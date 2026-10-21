import path from "node:path";
import type { RagConfig } from "./types.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function configFromEnv(overrides: Partial<RagConfig> = {}): RagConfig {
  const defaults: RagConfig = {
    dataDirectory: path.resolve(process.env.RAG_DATA_DIR ?? "./rag-data"),
    embedding: {
      provider: "openai",
      model: process.env.RAG_EMBEDDING_MODEL ?? "text-embedding-3-small",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/",
      ...(process.env.OPENAI_API_KEY
        ? { apiKey: process.env.OPENAI_API_KEY }
        : {}),
    },
    generation: {
      provider: "openai",
      model: process.env.OPENAI_GENERATION_MODEL ?? "gpt-5.4-mini",
      baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/",
      apiKey: process.env.OPENAI_API_KEY ?? "",
    },
    chunking: {
      targetTokens: positiveInteger(process.env.RAG_CHUNK_TARGET_TOKENS, 500),
    },
    retrieval: {
      vectorCandidates: positiveInteger(process.env.RAG_VECTOR_CANDIDATES, 40),
      keywordCandidates: positiveInteger(
        process.env.RAG_KEYWORD_CANDIDATES,
        40,
      ),
      finalResults: positiveInteger(process.env.RAG_FINAL_RESULTS, 8),
      neighborWindow: nonNegativeInteger(process.env.RAG_NEIGHBOR_WINDOW, 1),
    },
  };

  return {
    ...defaults,
    ...overrides,
    embedding: {
      ...defaults.embedding,
      ...overrides.embedding,
    },
    generation: {
      ...defaults.generation,
      ...overrides.generation,
    },
    chunking: {
      ...defaults.chunking,
      ...overrides.chunking,
    },
    retrieval: {
      ...defaults.retrieval,
      ...overrides.retrieval,
    },
  };
}
