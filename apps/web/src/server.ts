import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import page from "../index.html";
import {
  EMBEDDING_DIMENSIONS,
  createLocalRag,
  type DocumentRecord,
  type SearchOptions,
} from "@rag";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILES_PER_BATCH = 20;
const MAX_BATCH_UPLOAD_BYTES = 250 * 1024 * 1024;

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type RouteRequest = Request & {
  params: Record<string, string>;
};

function routeParam(request: Request, name: string): string {
  const value = (request as RouteRequest).params[name];
  if (!value) throw new HttpError("Missing route parameter: " + name, 400);
  return value;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError("Request body must be valid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function searchInput(value: Record<string, unknown>): SearchOptions {
  if (typeof value.collectionId !== "string" || !value.collectionId.trim()) {
    throw new HttpError("collectionId is required.", 400);
  }
  if (typeof value.query !== "string" || !value.query.trim()) {
    throw new HttpError("query is required.", 400);
  }

  const optionalPositiveInteger = (name: string): number | undefined => {
    const candidate = value[name];
    if (candidate === undefined) return undefined;
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 1
    ) {
      throw new HttpError(name + " must be a positive integer.", 400);
    }
    return Math.min(candidate, 100);
  };

  const optionalNeighborWindow = (): number | undefined => {
    const candidate = value.neighborWindow;
    if (candidate === undefined) return undefined;
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 0 ||
      candidate > 5
    ) {
      throw new HttpError(
        "neighborWindow must be an integer between 0 and 5.",
        400,
      );
    }
    return candidate;
  };

  const documentIds = value.documentIds;
  if (
    documentIds !== undefined &&
    (!Array.isArray(documentIds) ||
      documentIds.some((id) => typeof id !== "string" || !id.trim()))
  ) {
    throw new HttpError("documentIds must contain document ID strings.", 400);
  }

  return {
    collectionId: value.collectionId,
    query: value.query,
    ...(optionalPositiveInteger("topK") !== undefined
      ? { topK: optionalPositiveInteger("topK") }
      : {}),
    ...(optionalPositiveInteger("vectorCandidates") !== undefined
      ? { vectorCandidates: optionalPositiveInteger("vectorCandidates") }
      : {}),
    ...(optionalPositiveInteger("keywordCandidates") !== undefined
      ? { keywordCandidates: optionalPositiveInteger("keywordCandidates") }
      : {}),
    ...(optionalNeighborWindow() !== undefined
      ? { neighborWindow: optionalNeighborWindow() }
      : {}),
    ...(documentIds ? { documentIds: documentIds as string[] } : {}),
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error(error);
  return Response.json(
    {
      error: error instanceof Error ? error.message : "Internal server error.",
    },
    { status: 500 },
  );
}

function safe(
  handler: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

const rag = await createLocalRag();
const settingsPath = path.join(rag.config.dataDirectory, "settings.json");

async function readLocalSettings(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

async function saveOpenAIApiKey(apiKey: string): Promise<void> {
  const temporaryPath = settingsPath + "." + randomUUID() + ".tmp";
  const settings = await readLocalSettings();
  try {
    await writeFile(
      temporaryPath,
      JSON.stringify({ ...settings, openAIApiKey: apiKey }, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, settingsPath);
    await chmod(settingsPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

const localSettings = await readLocalSettings();
if (
  !rag.hasOpenAIApiKey() &&
  typeof localSettings.openAIApiKey === "string" &&
  localSettings.openAIApiKey.trim()
) {
  rag.setOpenAIApiKey(localSettings.openAIApiKey);
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const server = Bun.serve({
  hostname: host,
  port,
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": page,
    "/v1/health": safe(() =>
      Response.json({
        status: "ok",
        embedding: {
          provider: rag.config.embedding.provider,
          model: rag.config.embedding.model,
          dimensions: EMBEDDING_DIMENSIONS,
          configured: rag.hasOpenAIApiKey(),
        },
        generation: {
          enabled: Boolean(rag.config.generation.apiKey),
          model: rag.config.generation.model,
        },
      }),
    ),
    "/v1/settings/openai": {
      PUT: safe(async (request) => {
        const body = await objectBody(request);
        if (
          typeof body.apiKey !== "string" ||
          !body.apiKey.trim() ||
          body.apiKey.length > 512
        ) {
          throw new HttpError("A valid OpenAI API key is required.", 400);
        }

        const apiKey = body.apiKey.trim();
        await saveOpenAIApiKey(apiKey);
        rag.setOpenAIApiKey(apiKey);
        return Response.json({ configured: true });
      }),
    },
    "/v1/collections": {
      GET: safe(() => Response.json({ collections: rag.listCollections() })),
      POST: safe(async (request) => {
        const body = await objectBody(request);
        if (typeof body.name !== "string" || !body.name.trim()) {
          throw new HttpError("Collection name is required.", 400);
        }
        return Response.json(
          { collection: rag.createCollection(body.name) },
          { status: 201 },
        );
      }),
    },
    "/v1/collections/:id": {
      DELETE: safe(async (request) => {
        await rag.deleteCollection(routeParam(request, "id"));
        return new Response(null, { status: 204 });
      }),
    },
    "/v1/documents": {
      GET: safe((request) => {
        const collectionId = new URL(request.url).searchParams.get(
          "collectionId",
        );
        return Response.json({
          documents: rag.listDocuments(collectionId ?? undefined),
        });
      }),
      POST: safe(async (request) => {
        const collectionId = new URL(request.url).searchParams.get(
          "collectionId",
        );
        if (!collectionId) {
          throw new HttpError("collectionId is required.", 400);
        }

        const declaredSize = Number(request.headers.get("content-length") ?? 0);
        if (declaredSize > MAX_BATCH_UPLOAD_BYTES + 2_000_000) {
          throw new HttpError("Batch exceeds the 250 MB upload limit.", 413);
        }

        const form = await request.formData();

        const entries = form.getAll("files");
        const uploads = entries.filter(
          (value): value is Exclude<(typeof entries)[number], string> =>
            typeof value !== "string" && value.size > 0,
        );
        if (!uploads.length) {
          throw new HttpError(
            "At least one multipart file field named 'files' is required.",
            400,
          );
        }
        if (uploads.length > MAX_FILES_PER_BATCH) {
          throw new HttpError("A batch can contain at most 20 files.", 413);
        }
        if (uploads.some((upload) => upload.size > MAX_UPLOAD_BYTES)) {
          throw new HttpError("Each file must be 50 MB or smaller.", 413);
        }
        const totalSize = uploads.reduce(
          (total, upload) => total + upload.size,
          0,
        );
        if (totalSize > MAX_BATCH_UPLOAD_BYTES) {
          throw new HttpError("Batch exceeds the 250 MB upload limit.", 413);
        }

        const temporaryDirectory = path.join(rag.config.dataDirectory, "temp");
        await mkdir(temporaryDirectory, { recursive: true });
        const documents: DocumentRecord[] = [];

        for (const upload of uploads) {
          const temporaryPath = path.join(
            temporaryDirectory,
            "upload-" + randomUUID(),
          );
          try {
            const bytes = new Uint8Array(await upload.arrayBuffer());
            await Bun.write(temporaryPath, bytes);

            const document = await rag.addDocument({
              collectionId,
              path: temporaryPath,
              originalFileName: upload.name || "document.bin",
              mimeType: upload.type || "application/octet-stream",
            });
            if (!documents.some((item) => item.id === document.id)) {
              documents.push(document);
            }
          } finally {
            await rm(temporaryPath, { force: true });
          }
        }

        return Response.json({ documents }, { status: 202 });
      }),
    },
    "/v1/documents/:id": {
      GET: safe((request) => {
        const document = rag.getDocument(routeParam(request, "id"));
        if (!document) throw new HttpError("Document not found.", 404);
        return Response.json({ document });
      }),
      DELETE: safe(async (request) => {
        await rag.deleteDocument(routeParam(request, "id"));
        return new Response(null, { status: 204 });
      }),
    },
    "/v1/documents/:id/reindex": {
      POST: safe(async (request) =>
        Response.json({
          document: await rag.reindexDocument(routeParam(request, "id")),
        }),
      ),
    },
    "/v1/search": {
      POST: safe(async (request) =>
        Response.json({
          results: await rag.search(searchInput(await objectBody(request))),
        }),
      ),
    },
    "/v1/answer": {
      POST: safe(async (request) =>
        Response.json(await rag.answer(searchInput(await objectBody(request)))),
      ),
    },
  },
  fetch() {
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.log("Local RAG is running at " + server.url);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await rag.close();
  await server.stop();
}

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});
