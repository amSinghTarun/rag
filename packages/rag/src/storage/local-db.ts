import { Database } from "bun:sqlite";
import type {
  CollectionRecord,
  DocumentRecord,
  DocumentStatus,
} from "../types";
import { randomUUID } from "node:crypto";

export class Db {
  private readonly db: Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath, { create: true });
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA journal_mode = WAL;");
    this.initializeSchema();
    this.migrateSchema();
    this.markInterruptedDocumentsFailed();
  }

  private initializeSchema(): void {
    this.db.run(
      [
        "CREATE TABLE IF NOT EXISTS collections (",
        "  id TEXT PRIMARY KEY,",
        "  name TEXT NOT NULL UNIQUE,",
        "  createdAt TEXT NOT NULL",
        ");",
        "CREATE TABLE IF NOT EXISTS documents (",
        "  id TEXT PRIMARY KEY,",
        "  collectionId TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,",
        "  originalFilename TEXT NOT NULL,",
        "  relativeFilePath TEXT NOT NULL,",
        "  mimeType TEXT NOT NULL,",
        "  sizeBytes INTEGER NOT NULL,",
        "  contentHash TEXT NOT NULL,",
        "  status TEXT NOT NULL CHECK(status IN ('queued','indexing','ready','failed')),",
        "  chunkCount INTEGER NOT NULL DEFAULT 0,",
        "  errorMessage TEXT,",
        "  createdAt TEXT NOT NULL,",
        "  updatedAt TEXT NOT NULL,",
        "  UNIQUE(collectionId, contentHash)",
        ");",
      ].join("\n"),
    );
  }

  private migrateSchema(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(documents)")
      .all() as Array<{ name: string }>;
    const hasRelativeFilePath = columns.some(
      (column) => column.name === "relativeFilePath",
    );
    const hasStorageKey = columns.some((column) => column.name === "storageKey");

    if (hasStorageKey && !hasRelativeFilePath) {
      this.db.run(
        "ALTER TABLE documents RENAME COLUMN storageKey TO relativeFilePath",
      );
    }
  }

  ensureDefaultCollection(): CollectionRecord {
    const existing = this.db
      .prepare("SELECT * FROM collections ORDER BY createdAt LIMIT 1")
      .get() as CollectionRecord | undefined;
    return existing ?? this.createCollection("Default");
  }

  createCollection(name: string): CollectionRecord {
    if (!name) throw new Error("Collection name is required.");
    const record: CollectionRecord = {
      id: randomUUID(),
      name: name,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO collections(id, name, createdAt) VALUES (?, ?, ?)")
      .run(record.id, record.name, record.createdAt);
    return record;
  }

  listCollections(): CollectionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM collections ORDER BY createdAt")
      .all() as unknown as CollectionRecord[];
    return rows;
  }

  getCollection(id: string): CollectionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM collections WHERE id = ?")
      .get(id) as CollectionRecord | undefined;
    return row ?? null;
  }

  deleteCollectionRecord(id: string): void {
    this.db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  }

  findDocumentByHash(
    collectionId: string,
    contentHash: string,
  ): DocumentRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM documents WHERE collectionId = ? AND contentHash = ?",
      )
      .get(collectionId, contentHash) as DocumentRecord | undefined;
    return row ?? null;
  }

  createDocument(input: {
    id: string;
    collectionId: string;
    originalFilename: string;
    relativeFilePath: string;
    mimeType: string;
    sizeBytes: number;
    contentHash: string;
  }): DocumentRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        [
          "INSERT INTO documents(",
          "id, collectionId, originalFilename, relativeFilePath, mimeType,",
          "sizeBytes, contentHash, status, chunkCount, createdAt, updatedAt",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)",
        ].join(" "),
      )
      .run(
        input.id,
        input.collectionId,
        input.originalFilename,
        input.relativeFilePath,
        input.mimeType,
        input.sizeBytes,
        input.contentHash,
        now,
        now,
      );
    return this.getDocument(input.id)!;
  }

  getDocument(id: string): DocumentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE id = ?")
      .get(id) as DocumentRecord | undefined;
    return row ?? null;
  }

  listDocuments(collectionId?: string): DocumentRecord[] {
    const rows = collectionId
      ? (this.db
          .prepare(
            "SELECT * FROM documents WHERE collectionId = ? ORDER BY createdAt DESC",
          )
          .all(collectionId) as unknown as DocumentRecord[])
      : (this.db
          .prepare("SELECT * FROM documents ORDER BY createdAt DESC")
          .all() as unknown as DocumentRecord[]);
    return rows;
  }

  updateDocumentStatus(
    id: string,
    status: DocumentStatus,
    options: { chunkCount?: number; errorMessage?: string | null } = {},
  ): void {
    const current = this.getDocument(id);
    if (!current) throw new Error("Document not found: " + id);
    this.db
      .prepare(
        [
          "UPDATE documents SET status = ?, chunkCount = ?,",
          "errorMessage = ?, updatedAt = ? WHERE id = ?",
        ].join(" "),
      )
      .run(
        status,
        options.chunkCount ?? current.chunkCount,
        options.errorMessage === undefined
          ? current.errorMessage
          : options.errorMessage,
        new Date().toISOString(),
        id,
      );
  }

  deleteDocumentRecord(id: string): void {
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }

  private markInterruptedDocumentsFailed(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        [
          "UPDATE documents SET status = 'failed',",
          "errorMessage = 'Process stopped during ingestion; retry the document.',",
          "updatedAt = ? WHERE status = 'indexing'",
        ].join(" "),
      )
      .run(now);
  }

  close(): void {
    this.db.close();
  }
}
