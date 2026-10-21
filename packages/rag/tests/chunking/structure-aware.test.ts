import { describe, expect, test } from "bun:test";
import { StructureAwareChunker } from "../../src/chunking/structure-aware";

const input = (elements: Parameters<StructureAwareChunker["createChunks"]>[0]["elements"]) => ({
  documentId: "document-1",
  collectionId: "collection-1",
  filename: "document.txt",
  elements,
});

describe("StructureAwareChunker", () => {
  test("preserves heading text in each chunk's heading path", () => {
    const chunker = new StructureAwareChunker({ targetTokens: 100 });

    const chunks = chunker.createChunks(
      input([
        { type: "heading", text: "User guide", headingLevel: 1 },
        { type: "paragraph", text: "Overview content." },
        { type: "heading", text: "Installation", headingLevel: 2 },
        { type: "paragraph", text: "Installation content." },
      ]),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headingPath).toEqual(["User guide"]);
    expect(chunks[1]?.headingPath).toEqual(["User guide", "Installation"]);
  });

  test("splits a long sentence without truncating or duplicating text", () => {
    const chunker = new StructureAwareChunker({ targetTokens: 100 });
    const longSentence =
      Array.from({ length: 120 }, (_, index) => `word-${index}`).join(" ") +
      ".";

    const chunks = chunker.createChunks(
      input([{ type: "paragraph", text: longSentence }]),
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.originalText).join(" ")).toBe(
      longSentence,
    );
  });
});
