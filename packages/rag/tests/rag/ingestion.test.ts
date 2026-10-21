import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalRag } from "../../index";
import { EMBEDDING_DIMENSIONS } from "../../src/helpers";

describe("document ingestion", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  test("indexes a text document and does not reprocess a ready duplicate", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "local-rag-ingestion-"),
    );
    const sourcePath = path.join(temporaryDirectory, "source.txt");
    await writeFile(
      sourcePath,
      "# Upload test\n\nThis document should be parsed, chunked, and indexed.",
    );

    const originalFetch = globalThis.fetch;
    let embeddingRequests = 0;
    globalThis.fetch = (async (_input, init) => {
      embeddingRequests += 1;
      const request = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({
        data: request.input.map((_, index) => ({
          index,
          embedding: Array(EMBEDDING_DIMENSIONS).fill(0.01),
        })),
      });
    }) as typeof fetch;

    const rag = await createLocalRag({
      dataDirectory: temporaryDirectory,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        baseUrl: "https://api.openai.com/v1/",
        apiKey: "test-api-key",
      },
    });

    try {
      const collection = rag.listCollections()[0];
      if (!collection) throw new Error("Default collection was not created.");

      const queued = await rag.addDocument({
        collectionId: collection.id,
        path: sourcePath,
        originalFileName: "source.txt",
        mimeType: "text/plain",
      });
      const ready = await rag.waitUntilReady(queued.id, 10_000);

      expect(ready.status).toBe("ready");
      expect(ready.chunkCount).toBeGreaterThan(0);
      expect(ready.relativeFilePath).toEndWith("source.txt");
      expect(embeddingRequests).toBe(1);

      const duplicate = await rag.addDocument({
        collectionId: collection.id,
        path: sourcePath,
        originalFileName: "source.txt",
        mimeType: "text/plain",
      });

      expect(duplicate.id).toBe(ready.id);
      expect(duplicate.status).toBe("ready");
      expect(embeddingRequests).toBe(1);
    } finally {
      await rag.close();
      globalThis.fetch = originalFetch;
    }
  }, 15_000);
});
