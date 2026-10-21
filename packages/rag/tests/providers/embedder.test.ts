import { describe, expect, test } from "bun:test";
import { OpenAIEmbedder } from "../../src/providers/embedder";

describe("OpenAIEmbedder API key configuration", () => {
  test("starts unconfigured and accepts a key later", () => {
    const embedder = new OpenAIEmbedder(
      "text-embedding-3-small",
      undefined,
      "https://api.openai.com/v1/",
    );

    expect(embedder.configured).toBe(false);
    embedder.setApikey("  test-api-key  ");
    expect(embedder.configured).toBe(true);
  });

  test("rejects a blank key", () => {
    const embedder = new OpenAIEmbedder(
      "text-embedding-3-small",
      undefined,
      "https://api.openai.com/v1/",
    );

    expect(() => embedder.setApikey("   ")).toThrow(
      "OpenAI API key is required.",
    );
    expect(embedder.configured).toBe(false);
  });
});
