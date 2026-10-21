import * as lancedb from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Int32,
  Schema,
  Utf8,
} from "apache-arrow";

import type { IndexedChunk } from "../types";

const TABLE_NAME = "chunks";

export interface StoredChunkRow extends Record<string, unknown> {
  chunkId: string;
  documentId: string;
  collectionId: string;
  originalText: string;
  startPage: number;
  endPage: number;
  headingPathJson: string;
  chunkPosition: number;
  continuationGroupId: string;
  continuationIndex: number;
  vector?: number[];
  _distance?: number;
}

const toRow = (chunk: IndexedChunk) => {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    collectionId: chunk.collectionId,
    originalText: chunk.originalText,
    startPage: chunk.startPage,
    endPage: chunk.endPage,
    headingPathJson: JSON.stringify(chunk.headingPath),
    chunkPosition: chunk.chunkPosition,
    continuationGroupId: chunk.continuationGroupId ?? "",
    continuationIndex: chunk.continuationIndex ?? -1,
    vector: chunk.vector,
  };
};

function createChunkSchema(vectorDimensions: number): Schema {
  return new Schema([
    new Field("chunkId", new Utf8(), false),
    new Field("documentId", new Utf8(), false),
    new Field("collectionId", new Utf8(), false),
    new Field("originalText", new Utf8(), false),
    new Field("startPage", new Int32(), false),
    new Field("endPage", new Int32(), false),
    new Field("headingPathJson", new Utf8(), false),
    new Field("chunkPosition", new Int32(), false),
    new Field("continuationGroupId", new Utf8(), false),
    new Field("continuationIndex", new Int32(), false),
    new Field(
      "vector",
      new FixedSizeList(
        vectorDimensions,
        new Field("item", new Float32(), false),
      ),
      false,
    ),
  ]);
}

function collectionFilter(collectionId: string, documentsId?: string[]) {
  let query = "collectionId = " + sqlString(collectionId);
  if (documentsId?.length) {
    query +=
      " AND documentId IN (" +
      documentsId.map((documentId) => sqlString(documentId)).join(", ") +
      ")";
  }
  return query;
}

function sqlString(string: string) {
  return "'" + string.replaceAll("'", "''") + "'";
}

export class LanceStore {
  private connection: lancedb.Connection | undefined;
  private table: lancedb.Table | undefined;

  constructor(private readonly indexDirectory: string) {}

  async initialize() {
    this.connection = await lancedb.connect(this.indexDirectory);
    const tableExists = await this.connection.listTables({ limit: 100 });
    this.table = tableExists.tables.includes(TABLE_NAME)
      ? await this.connection.openTable(TABLE_NAME)
      : await this.connection.createEmptyTable(
          TABLE_NAME,
          createChunkSchema(384),
        );
  }

  private get chunksTable(): lancedb.Table {
    if (!this.table) {
      throw new Error("LanceDB store has not been initialized.");
    }
    return this.table;
  }

  async replaceDocumentChunks(chunk: IndexedChunk[]) {
    if (!chunk.length) return;
    const row = chunk.map(toRow);

    await this.chunksTable.delete(
      "documentId = " + sqlString(chunk[0]!.documentId),
    );
    await this.chunksTable.add(row);
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.chunksTable.delete("documentId = " + sqlString(documentId));
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.chunksTable.delete("collectionId = " + sqlString(collectionId));
  }

  async countDocumentChunks(documentId: string): Promise<number> {
    return await this.chunksTable.countRows(
      "documentId = " + sqlString(documentId),
    );
  }

  async vectorSearch(
    collectionId: string,
    vector: number[],
    limit: number,
    documentIds?: string[],
  ): Promise<StoredChunkRow[]> {
    const row = await this.chunksTable
      .vectorSearch(vector)
      .column("vector")
      .distanceType("cosine")
      .where(collectionFilter(collectionId, documentIds))
      .limit(limit)
      .toArray();
    return row as StoredChunkRow[];
  }

  async listChunks(
    collectionId: string,
    documentIds?: string[],
    limit = 100_00,
  ) {
    const result = await this.chunksTable
      .query()
      .where(collectionFilter(collectionId, documentIds))
      .limit(limit)
      .toArray();
    return result;
  }

  close(): void {
    this.table?.close();
    this.table = undefined;
    this.connection?.close();
    this.connection = undefined;
  }
}
