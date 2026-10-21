interface OpenAIEmbeddingResponse {
  data?: Array<{
    embedding?: number[];
    index?: number;
  }>;
}

import { EMBEDDING_DIMENSIONS } from "../helpers";

export class OpenAIEmbedder {
  constructor(
    readonly model: string,
    private apiKey: string | undefined,
    private readonly baseurl: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  setApikey(key: string): void {
    if (!key.trim()) throw new Error("OpenAI API key is required.");
    this.apiKey = key.trim();
  }

  async embed(chunks: string[]): Promise<number[][]> {
    if (!this.configured)
      throw new Error("OPENAI_API_KEY is required to generate embeddings.");

    if (!chunks.length) return [];

    const url = new URL(
      "embeddings",
      this.baseurl.endsWith("/") ? this.baseurl : this.baseurl + "/",
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: chunks,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
    });

    if (!response.ok) {
      throw new Error(
        "OpenAI embedding request failed (" +
          response.status +
          "): " +
          (await response.text()),
      );
    }

    const { data: payload } =
      (await response.json()) as OpenAIEmbeddingResponse;
    if (!payload || payload.length !== chunks.length)
      throw new Error("OpenAI returned an invalid embedding response.");

    const ordered = [...payload].sort(
      (left, right) => (left.index ?? -1) - (right.index ?? -1),
    );

    return ordered.map((item, index) => {
      if (item.index !== index || !Array.isArray(item.embedding))
        throw new Error("OpenAI returned an invalid embedding response.");

      if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          "Embedding dimension mismatch. Expected " +
            EMBEDDING_DIMENSIONS +
            " but received " +
            item.embedding.length +
            ". This application requires 384-dimensional embeddings.",
        );
      }

      return item.embedding;
    });
  }
}
