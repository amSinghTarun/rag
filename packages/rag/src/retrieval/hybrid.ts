import type { StoredChunkRow } from "../storage/lance-store.js";
import { tokenize, type LexicalResult } from "./bm25.js";

export interface HybridCandidate {
  row: StoredChunkRow;
  fusionScore: number;
  rerankScore: number;
  vectorRank: number | null;
  bm25Rank: number | null;
}

export function fuseAndRerank(
  query: string,
  vectorResults: StoredChunkRow[],
  bm25Results: LexicalResult[],
  limit: number,
  textForRow: (row: StoredChunkRow) => string,
): HybridCandidate[] {
  const candidates = new Map<string, HybridCandidate>();
  const rrfK = 60;

  vectorResults.forEach((row, index) => {
    candidates.set(row.chunkId, {
      row,
      fusionScore: 1 / (rrfK + index + 1),
      rerankScore: 0,
      vectorRank: index + 1,
      bm25Rank: null,
    });
  });

  bm25Results.forEach(({ row }, index) => {
    const existing = candidates.get(row.chunkId);
    if (existing) {
      existing.fusionScore += 1 / (rrfK + index + 1);
      existing.bm25Rank = index + 1;
    } else {
      candidates.set(row.chunkId, {
        row,
        fusionScore: 1 / (rrfK + index + 1),
        rerankScore: 0,
        vectorRank: null,
        bm25Rank: index + 1,
      });
    }
  });

  const queryTerms = [...new Set(tokenize(query))];

  const maximumFusion = Math.max(
    ...[...candidates.values()].map((candidate) => candidate.fusionScore),
    Number.EPSILON, //Number.EPSILON is a tiny positive fallback that prevents division by zero or Math.max() receiving no scores
  );

  for (const candidate of candidates.values()) {
    const text = textForRow(candidate.row).toLocaleLowerCase(); // org text, collection id document id
    const textTerms = new Set(tokenize(text)); /// unique terms of above text
    const coverage = queryTerms.length
      ? queryTerms.filter((term) => textTerms.has(term)).length /
        queryTerms.length
      : 0; // count how many of query terms are in the above unqiue text
    const phraseBoost = text.includes(query.toLocaleLowerCase()) ? 1 : 0; // check if whole phrase is avl

    // This gives a chunk an extra ranking boost when the query words appear in its section headings.
    /** candidate.row.headingPathJson =
        '["Benefits", "Parental Leave"]';
    */
    const heading = JSON.parse(
      candidate.row.headingPathJson || "[]",
    ) as string[];
    const headingTerms = new Set(tokenize(heading.join(" ")));
    const headingCoverage = queryTerms.length
      ? queryTerms.filter((term) => headingTerms.has(term)).length /
        queryTerms.length
      : 0;

    candidate.rerankScore =
      0.55 * (candidate.fusionScore / maximumFusion) +
      0.3 * coverage +
      0.1 * headingCoverage +
      0.05 * phraseBoost;
  }

  return [...candidates.values()]
    .sort((left, right) => right.rerankScore - left.rerankScore)
    .slice(0, limit);
}
