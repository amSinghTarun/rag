import type { HybridCandidate } from "./hybrid.js";
import type { StoredChunkRow } from "../storage/lance-store.js";

export interface ContextWindow {
  candidate: HybridCandidate;
  rows: StoredChunkRow[];
}

export function selectContextWindows(
  candidates: HybridCandidate[],
  allRows: StoredChunkRow[],
  limit: number,
  neighborWindow: number,
): ContextWindow[] {
  const rowsByDocument = new Map<string, Map<number, StoredChunkRow>>();
  const continuationGroups = new Map<string, StoredChunkRow[]>();

  for (const row of allRows) {
    let rowsByPosition = rowsByDocument.get(row.documentId);
    if (!rowsByPosition) {
      rowsByPosition = new Map<number, StoredChunkRow>();
      rowsByDocument.set(row.documentId, rowsByPosition);
    }
    rowsByPosition.set(row.chunkPosition, row);

    if (row.continuationGroupId) {
      const key = row.documentId + ":" + row.continuationGroupId;
      const group = continuationGroups.get(key) ?? [];
      group.push(row);
      continuationGroups.set(key, group);
    }
  }

  for (const group of continuationGroups.values()) {
    group.sort(
      (left, right) => left.continuationIndex - right.continuationIndex,
    );
  }

  const logicalUnit = (row: StoredChunkRow): StoredChunkRow[] => {
    if (!row.continuationGroupId) return [row];
    return (
      continuationGroups.get(
        row.documentId + ":" + row.continuationGroupId,
      ) ?? [row]
    );
  };

  const windows: ContextWindow[] = [];
  const usedChunkIds = new Set<string>();

  for (const candidate of candidates) {
    const rowsByPosition = rowsByDocument.get(candidate.row.documentId);
    const anchor =
      rowsByPosition?.get(candidate.row.chunkPosition) ?? candidate.row;
    const section = anchor.headingPathJson || "[]";
    const anchorRows = logicalUnit(anchor);

    const collectNeighbors = (
      startPosition: number,
      direction: -1 | 1,
    ): StoredChunkRow[] => {
      const neighbors: StoredChunkRow[] = [];
      let position = startPosition;

      for (let count = 0; count < neighborWindow; count++) {
        const row = rowsByPosition?.get(position + direction);
        if (!row || (row.headingPathJson || "[]") !== section) break;

        const unit = logicalUnit(row);
        if (unit.some((item) => (item.headingPathJson || "[]") !== section)) {
          break;
        }

        if (direction === -1) neighbors.unshift(...unit);
        else neighbors.push(...unit);
        position =
          direction === -1
            ? unit[0]!.chunkPosition
            : unit.at(-1)!.chunkPosition;
      }

      return neighbors;
    };

    const rows = [
      ...collectNeighbors(anchorRows[0]!.chunkPosition, -1),
      ...anchorRows,
      ...collectNeighbors(anchorRows.at(-1)!.chunkPosition, 1),
    ];
    if (rows.some((row) => usedChunkIds.has(row.chunkId))) continue;

    windows.push({ candidate, rows });
    for (const row of rows) usedChunkIds.add(row.chunkId);
    if (windows.length === limit) break;
  }

  return windows;
}
