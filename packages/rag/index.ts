export { createLocalRag, Rag } from "./src/rag.ts";
export { configFromEnv } from "./src/config.ts";
export { EMBEDDING_DIMENSIONS } from "./src/helpers";
export type {
  AddDocumentInput,
  AnswerResult,
  CollectionRecord,
  DocumentRecord,
  RagConfig,
  SearchContextChunk,
  SearchOptions,
  SearchResult,
} from "./src/types.ts";
