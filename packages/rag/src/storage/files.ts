import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, stat, readFile, rm } from "node:fs/promises";
import path from "node:path";

const safeExtension = (filename: string) => {
  const extension = path.extname(filename);
  return /^[.][a-z0-9]{1,10}$/.test(extension) ? extension : ".bin";
};

export class FileStore {
  private fileDirectory: string;

  constructor(dataDirectory: string) {
    this.fileDirectory = path.join(dataDirectory, "files");
  }

  async inspect(
    sourcePath: string,
  ): Promise<{ sizeBytes: number; contentHash: string }> {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) throw new Error("Document path is not a file");

    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(sourcePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    return {
      sizeBytes: fileStat.size,
      contentHash: "sha256:" + hash.digest("hex"),
    };
  }

  resolve(relativeFilePath: string) {
    const resolved = path.resolve(this.fileDirectory, relativeFilePath);
    const root = path.resolve(this.fileDirectory) + path.sep;
    if (!resolved.startsWith(root)) throw new Error("Unsafe storage key");
    return resolved;
  }

  async put(
    sourcePath: string,
    collectionId: string,
    documentId: string,
    originalFilename: string,
  ) {
    const relativePath = path.join(
      collectionId,
      documentId,
      "source" + safeExtension(originalFilename),
    );
    const destination = this.resolve(relativePath);
    const tempDestination = destination + ".partial";
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, tempDestination);
    await rename(tempDestination, destination);
    return relativePath;
  }

  async read(relativeFilePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativeFilePath));
  }

  async deleteDocument(
    collectionId: string,
    documentId: string,
  ): Promise<void> {
    await rm(path.join(this.fileDirectory, collectionId, documentId), {
      recursive: true,
      force: true,
    });
  }
}
