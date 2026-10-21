export type DocumentStatus = "queued" | "indexing" | "ready" | "failed";

export interface AnswerResult {
  answer: string;
  generated: boolean;
  sources: SearchResult[];
}

export interface ParsedElement {
  type: "heading" | "paragraph" | "list-item" | "table";
  text: string;
  pageNumber?: number;
  headingLevel?: number;
}

export interface IndexedChunk extends ChunkInput {
  vector: number[];
}

export interface SearchContextChunk {
  chunkId: string;
  text: string;
  startPage: number | null;
  endPage: number | null;
  headingPath: string[];
  chunkPosition: number;
  continuationGroupId: string | null;
  continuationIndex: number | null;
}

export interface ChunkInput {
  chunkId: string;
  documentId: string;
  collectionId: string;
  originalText: string;
  startPage: number;
  endPage: number;
  headingPath: string[];
  chunkPosition: number;
  continuationGroupId: string | null;
  continuationIndex: number | null;
}

export interface CollectionRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface SearchOptions {
  query: string;
  collectionId: string;
  topK?: number;
}

export interface DocumentRecord {
  id: string;
  collectionId: string;
  originalFilename: string;
  relativeFilePath: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  status: DocumentStatus;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RagConfig {
  dataDirectory: string;
  embedding: {
    provider: "openai";
    model: string;
    baseUrl: string;
    apiKey?: string;
  };
  generation: {
    provider: "openai";
    model: string;
    baseUrl: string;
    apiKey: string;
  };
  chunking: {
    targetTokens: number;
  };
  retrieval: {
    vectorCandidates: number;
    keywordCandidates: number;
    finalResults: number;
    neighborWindow: number;
  };
}

export interface AddDocumentInput {
  collectionId: string;
  path: string;
  originalFileName?: string;
  mimeType?: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  collectionId: string;
  text: string;
  filename: string;
  startPage: number | null;
  endPage: number | null;
  headingPath: string[];
  contextChunks: SearchContextChunk[];
  score: number;
  scores: {
    fusion: number;
    rerank: number;
    vectorRank: number | null;
    keywordRank: number | null;
  };
}
