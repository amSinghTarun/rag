import { createHash } from "node:crypto";
import type { ChunkInput, ParsedElement } from "../types";

interface TextPiece {
  text: string;
  continuationGroupId: string | null;
  continuationIndex: number | null;
}

interface ChunkPart extends TextPiece {
  pageNumber?: number;
}

interface ChunkingInput {
  documentId: string;
  collectionId: string;
  filename: string;
  elements: ParsedElement[];
}

export class StructureAwareChunker {
  private readonly targetTokens: number;
  private readonly targetCharacters: number;

  constructor(config: any) {
    //ChunkingConfig
    this.targetTokens = config.targetTokens;
    this.targetCharacters = Math.max(400, config.targetTokens * 4);
  }

  private stableId(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 24);
  }

  private splitLargeText(text: string, groupSeed: string): TextPiece[] {
    if (text.length <= this.targetCharacters) {
      return [
        { text: text, continuationGroupId: null, continuationIndex: null },
      ];
    }

    const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
    const breakdownParts: TextPiece[] = [];
    let current = "";

    const flushCurrent = (
      continuationGroupId: string | null = null,
      continuationIndex: number | null = null,
    ) => {
      if (!current) return;
      breakdownParts.push({
        text: current,
        continuationGroupId: continuationGroupId,
        continuationIndex: continuationIndex,
      });
      current = "";
    };

    for (const [sentenceIndex, originalSentence] of sentences.entries()) {
      let sentence = originalSentence.trim();
      if (!sentence) continue;
      if (
        current && // this current is important to avoid condition if current is null and sentence is oversize then also it will flush it
        current.length + sentence.length + 1 > this.targetCharacters
      ) {
        flushCurrent();
      }
      if (sentence.length > this.targetCharacters) {
        flushCurrent();
        const continueGroupId = this.stableId(
          groupSeed + ":" + sentenceIndex + ":" + originalSentence,
        );
        let continuationIndex = 0;
        while (sentence.length > this.targetCharacters) {
          const wordBoundary: number = sentence.lastIndexOf(
            " ",
            this.targetCharacters,
          );
          const sliceAt: number =
            wordBoundary > 0 ? wordBoundary : this.targetCharacters;
          current = sentence.slice(0, sliceAt);
          sentence = sentence.slice(sliceAt).trim();
          flushCurrent(continueGroupId, continuationIndex++);
        }
        if (sentence.length > 0) {
          current = sentence;
          flushCurrent(continueGroupId, continuationIndex++);
        }
      } else {
        current += (current ? " " : "") + sentence;
      }
    }
    flushCurrent();
    return breakdownParts;
  }

  createChunks(input: ChunkingInput): ChunkInput[] {
    const chunks: ChunkInput[] = [];
    const headingPath: string[] = [];
    let parts: ChunkPart[] = []; // this is the array where we store splitted text which the flush will use

    const flush = () => {
      const originalText = parts
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      if (!originalText) return;
      const pageNumber = parts
        .map((part) => part.pageNumber)
        .filter((value): value is number => value !== undefined);
      const chunkPosition = chunks.length;

      chunks.push({
        chunkId: this.stableId(
          input.documentId + ":" + chunkPosition + ":" + originalText,
        ),
        documentId: input.documentId,
        collectionId: input.collectionId,
        originalText: originalText,
        startPage: pageNumber[0] ?? -1,
        endPage: pageNumber[pageNumber.length - 1] ?? -1,
        headingPath: [...headingPath],
        chunkPosition: chunkPosition,
        continuationGroupId: parts[0]?.continuationGroupId ?? null, // we are directly doing [0].continuationGroupId as if there is a long sentence then only it will be present
        continuationIndex: parts[0]?.continuationIndex ?? null,
      });

      parts = [];
    };

    for (let [elementIndex, element] of input.elements.entries()) {
      if (element.type === "heading") {
        flush();
        const level = Math.max(1, element.headingLevel ?? 2);
        const addAtIndex = Math.min(level, headingPath.length + 1);
        headingPath.splice(addAtIndex - 1);
        headingPath.push(element.text.trim());
        continue;
      }

      const pieces = this.splitLargeText(
        element.text,
        input.documentId + ":" + elementIndex,
      );

      for (const piece of pieces) {
        if (piece.continuationGroupId) {
          if (parts.length) {
            // we do it before length check as even if length is less then token required, we need to flush it as it's of group not normal chunk
            flush();
          }
          parts.push({
            ...piece,
            ...(element.pageNumber !== undefined
              ? { pageNumber: element.pageNumber }
              : {}),
          });
          flush();
          continue;
        }
        // save the new piece in parts and if the token length is > required, save it.
        // we can't move the condition in flush as then it has to save non full length parts if there are no more parts
        // so check candidate and it length is apt, flush it

        const candidate = [...parts.map((part) => part.text), piece.text].join(
          "\n\n",
        );

        // approximateTokens > targettokens
        if (Math.ceil(candidate.length / 4) > this.targetTokens) {
          flush();
        }

        parts.push({
          ...piece,
          ...(element.pageNumber !== undefined
            ? { pageNumber: element.pageNumber }
            : {}),
        });
      }
    }
    flush();
    return chunks;
  }
}
