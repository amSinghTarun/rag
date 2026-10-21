import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileStore } from "../../src/storage/files";

describe("FileStore.inspect", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  test("resolves with the file size and a hexadecimal SHA-256 digest", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "local-rag-file-store-"),
    );
    const contents = Buffer.from("A small document for hashing.\n", "utf8");
    const sourcePath = path.join(temporaryDirectory, "document.txt");
    await writeFile(sourcePath, contents);

    const store = new FileStore(temporaryDirectory);
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const inspected = await Promise.race([
        store.inspect(sourcePath),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("FileStore.inspect did not resolve.")),
            1_000,
          );
        }),
      ]);

      expect(inspected.sizeBytes).toBe(contents.byteLength);
      expect(inspected.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(inspected.contentHash).toBe(
        "sha256:" + createHash("sha256").update(contents).digest("hex"),
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });
});
