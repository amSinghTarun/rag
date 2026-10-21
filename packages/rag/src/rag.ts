import { mkdir } from "node:fs/promises";
import type {
  AddDocumentInput,
  AnswerResult,
  DocumentRecord,
  RagConfig,
  SearchContextChunk,
  SearchOptions,
} from "./types";
import path from "node:path";
import type {
  FileStore as FileStoreType,
  LanceStore as LanceStoreType,
  Db as DbType,
  StoredChunkRow as StoredChunkRowType,
} from "./storage";
import { FileStore, LanceStore, Db } from "./storage";
import { randomUUID } from "node:crypto";
import { parseDocument } from "./parsers/document-parser";
import { StructureAwareChunker } from "./chunking/structure-aware";
import { EMBEDDING_DIMENSIONS } from "./helpers";
import {
  generateWithOpenAI,
  OpenAIEmbedder,
  type OpenAIEmbedder as OpenAIEmbedderType,
} from "./providers";
import { contextualizeText } from "./helpers";
import { bm25Search } from "./retrieval/bm25";
import { fuseAndRerank } from "./retrieval/hybrid";
import { selectContextWindows } from "./retrieval/context";
import { configFromEnv } from "./config";

const READY_POLL_INTERVAL_MS = 100;
const MAX_NEIGHBOR_WINDOW = 5;

function mimeFromFilename(filename: string): string {
  const extension = path.extname(filename).toLocaleLowerCase();
  const types: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".html": "text/html",
    ".htm": "text/html",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
  };
  return types[extension] ?? "application/octet-stream";
}

function headingPath(row: StoredChunkRowType): string[] {
  try {
    return JSON.parse(row.headingPathJson || "[]") as string[];
  } catch {
    return [];
  }
}

function toContextChunk(row: StoredChunkRowType): SearchContextChunk {
  return {
    chunkId: row.chunkId,
    text: row.originalText,
    startPage: row.startPage > 0 ? row.startPage : null,
    endPage: row.endPage > 0 ? row.endPage : null,
    headingPath: headingPath(row),
    chunkPosition: row.chunkPosition,
    continuationGroupId: row.continuationGroupId || null,
    continuationIndex:
      Number.isInteger(row.continuationIndex) && row.continuationIndex >= 0
        ? row.continuationIndex
        : null,
  };
}

export class Rag {
  private readonly activeIngestions = new Set<Promise<void>>();
  private ingestion: Promise<void> = Promise.resolve();

  constructor(
    readonly config: RagConfig,
    private readonly db: DbType,
    private readonly files: FileStoreType,
    private readonly searchStore: LanceStoreType,
    private readonly chunker: StructureAwareChunker,
    private readonly embedder: OpenAIEmbedderType,
  ) {}

  listCollections() {
    return this.db.listCollections();
  }

  setOpenAIApiKey(apiKey: string): void {
    const normalized = apiKey.trim();
    this.embedder.setApikey(normalized);
    this.config.embedding.apiKey = normalized;
    this.config.generation.apiKey = normalized;
  }

  createCollection(name: string) {
    return this.db.createCollection(name);
  }

  hasOpenAIApiKey(): boolean {
    return this.embedder.configured;
  }

  deleteCollection(id: string) {
    return this.db.deleteDocumentRecord(id);
  }

  listDocuments(collectionId?: string) {
    return this.db.listDocuments(collectionId);
  }

  getDocument(id: string) {
    return this.db.getDocument(id);
  }

  async deleteDocument(documentId: string) {
    const document = this.db.getDocument(documentId);
    if (!document) return;
    await this.searchStore.deleteDocument(documentId);
    await this.files.deleteDocument(document.collectionId, documentId);
    this.db.deleteDocumentRecord(documentId);
  }

  async addDocument(input: AddDocumentInput): Promise<DocumentRecord> {
    // register document - insert it in db and return the processing state
    const registered = await this.registerDocument(input);
    if (!registered.shouldProcess) return registered.document;

    const ingestion = this.ingestion
      .then(() => this.processDocument(registered.document.id))
      .catch((error: unknown) => {
        console.error(
          "Document ingestion failed for " + registered.document.id + ":",
          error,
        );
      });
    this.ingestion = ingestion;
    this.activeIngestions.add(ingestion);
    ingestion.finally(() => this.activeIngestions.delete(ingestion));

    return registered.document;
  }

  private async registerDocument(input: AddDocumentInput): Promise<{
    document: DocumentRecord;
    shouldProcess: boolean;
  }> {
    // verify the extra details
    const collection = this.db.getCollection(input.collectionId);
    if (!collection) throw new Error("Invalid collection reference");
    // let document: DocumentRecord;
    // let shouldProcess = true;
    // inspect the document - from there we get the content hash
    const inspected = await this.files.inspect(input.path);

    // find document from hash so that there is no duplication
    let existing = this.db.findDocumentByHash(
      input.collectionId,
      inspected.contentHash,
    );

    if (!existing) {
      const documentId = randomUUID();
      const filename =
        input.originalFileName?.trim() || path.basename(input.path);
      existing = this.db.createDocument({
        id: documentId,
        collectionId: input.collectionId,
        originalFilename: filename,
        relativeFilePath: await this.files.put(
          input.path,
          input.collectionId,
          documentId,
          filename,
        ),
        mimeType: input.mimeType ?? mimeFromFilename(filename),
        sizeBytes: inspected.sizeBytes,
        contentHash: inspected.contentHash,
      });
      return { document: existing, shouldProcess: true };
    }

    // if status is failed - then queue it
    if (existing.status === "failed") {
      this.db.updateDocumentStatus(existing.id, "queued", {
        errorMessage: null,
      });
      return {
        document: this.db.getDocument(existing.id)!,
        shouldProcess: true,
      };
    }

    return { document: existing, shouldProcess: false };
  }

  async processDocument(documentId: string): Promise<void> {
    // change the status from indexing
    try {
      const document = this.db.getDocument(documentId);
      if (!document) throw new Error("Document to be processed not found");

      this.db.updateDocumentStatus(documentId, "indexing", {
        errorMessage: null,
      });

      // parse the document in a structure aware way
      const elements = await parseDocument(
        this.files.resolve(document.relativeFilePath),
        document.mimeType,
        document.originalFilename,
      );
      if (!elements.length)
        throw new Error("The parser did not extract any readable text.");

      // create appropriate length and context chunks from the parsed document
      const chunks = this.chunker.createChunks({
        documentId,
        collectionId: document.collectionId,
        filename: document.originalFilename,
        elements,
      });
      if (!chunks.length)
        throw new Error("Chunking produced no searchable content.");

      // embedd the chunks
      const vector: number[][] = [];
      for (
        let offset = 0;
        offset < chunks.length;
        offset += EMBEDDING_DIMENSIONS
      ) {
        const batch = chunks.slice(offset, offset + EMBEDDING_DIMENSIONS);
        vector.push(
          ...(await this.embedder.embed(
            batch.map((chunk) =>
              contextualizeText(
                document.originalFilename,
                chunk.headingPath,
                chunk.originalText,
              ),
            ),
          )),
        );
      }

      // store in lanceDB
      await this.searchStore.replaceDocumentChunks(
        chunks.map((chunk, index) => ({ ...chunk, vector: vector[index]! })),
      );

      const indexedCount =
        await this.searchStore.countDocumentChunks(documentId);

      if (indexedCount !== chunks.length) {
        throw new Error(
          "Index verification failed: expected " +
            chunks.length +
            " chunks but found " +
            indexedCount +
            ".",
        );
      }

      // change state
      this.db.updateDocumentStatus(documentId, "ready", {
        errorMessage: null,
        chunkCount: chunks.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.updateDocumentStatus(documentId, "failed", {
        errorMessage: message,
      });
      throw error;
    }
  }

  async reindexDocument(documentId: string): Promise<DocumentRecord> {
    await this.processDocument(documentId);
    return this.db.getDocument(documentId)!;
  }

  async reindexAll(collectionId: string) {
    for (const document of this.db.listDocuments(collectionId)) {
      await this.reindexDocument(document.id);
    }
  }

  async search(options: SearchOptions) {
    const query = options.query.trim();
    if (!query) throw new Error("Search query is required");
    if (!this.db.getCollection(options.collectionId))
      throw new Error("Collection not found: " + options.collectionId);

    const {
      vectorCandidates,
      keywordCandidates,
      finalResults: topK,
    } = this.config.retrieval;

    const scope = { collectionId: options.collectionId };

    const neighborWindow = Math.min(
      Math.max(0, this.config.retrieval.neighborWindow),
      MAX_NEIGHBOR_WINDOW,
    );

    const [queryVector] = await this.embedder.embed([query]);
    if (!queryVector) throw new Error("Embedding provider returned no vector.");

    const [vectorRows, allRows] = await Promise.all([
      this.searchStore.vectorSearch(
        options.collectionId,
        queryVector,
        vectorCandidates,
      ),
      this.searchStore.listChunks(options.collectionId),
    ]);

    const filenames = new Map(
      this.db
        .listDocuments(options.collectionId)
        .map((document) => [document.id, document.originalFilename]),
    );

    const textForRow = (row: StoredChunkRowType) => {
      return contextualizeText(
        filenames.get(row.documentId) ?? "Unknown document",
        headingPath(row),
        row.originalText,
      );
    };

    const keywordRows = bm25Search(
      query,
      allRows,
      keywordCandidates,
      textForRow,
    );

    const rankedCandidates = fuseAndRerank(
      query,
      vectorRows,
      keywordRows,
      vectorRows.length + keywordRows.length,
      textForRow,
    );

    const contextWindows = selectContextWindows(
      rankedCandidates,
      allRows,
      options.topK ?? topK,
      neighborWindow,
    );

    return contextWindows.map(({ candidate, rows }) => ({
      chunkId: candidate.row.chunkId,
      documentId: candidate.row.documentId,
      collectionId: candidate.row.collectionId,
      text: candidate.row.originalText,
      filename: filenames.get(candidate.row.documentId) ?? "Unknown document",
      startPage: candidate.row.startPage > 0 ? candidate.row.startPage : null,
      endPage: candidate.row.endPage > 0 ? candidate.row.endPage : null,
      headingPath: headingPath(candidate.row),
      contextChunks: rows.map(toContextChunk),
      score: candidate.rerankScore,
      scores: {
        fusion: candidate.fusionScore,
        rerank: candidate.rerankScore,
        vectorRank: candidate.vectorRank,
        keywordRank: candidate.bm25Rank,
      },
    }));
  }

  async answer(options: SearchOptions): Promise<AnswerResult> {
    const sources = await this.search(options);
    const generation = this.config.generation;
    if (!sources.length || !generation.apiKey) {
      return {
        answer: "No relevant evidence was found in the selected collection.",
        generated: false,
        sources,
      };
    }

    const answer = await generateWithOpenAI({
      baseUrl: generation.baseUrl,
      apiKey: generation.apiKey,
      model: generation.model,
      question: options.query,
      sources,
    });
    return { answer, generated: true, sources };
  }

  async waitUntilReady(documentId: string, timeoutMilliseconds = 120_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMilliseconds) {
      const document = this.db.getDocument(documentId);
      if (!document) throw new Error("Document not found: ID - " + documentId);

      if (document.status == "ready") return document;
      if (document.status == "failed")
        throw new Error(document.errorMessage ?? "Document ingestion failed.");

      await new Promise((resolve, _reject) => {
        setTimeout(resolve, READY_POLL_INTERVAL_MS);
      });
    }
    throw new Error("Timed out waiting for document ingestion.");
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.activeIngestions]);
    this.searchStore.close();
    this.db.close();
  }
}

export async function createLocalRag(
  overrides: Partial<RagConfig> = {},
): Promise<Rag> {
  const config = configFromEnv(overrides);
  await mkdir(config.dataDirectory, { recursive: true });
  const files = new FileStore(config.dataDirectory);
  const db = new Db(path.join(config.dataDirectory, "db.sqlite"));
  db.ensureDefaultCollection();
  const searchStore = new LanceStore(
    path.join(config.dataDirectory, "search-index"),
  );
  await searchStore.initialize();
  const embedder = new OpenAIEmbedder(
    config.embedding.model,
    config.embedding.apiKey,
    config.embedding.baseUrl,
  );
  const chunker = new StructureAwareChunker(config.chunking);
  return new Rag(config, db, files, searchStore, chunker, embedder);
}
