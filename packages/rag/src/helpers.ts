export function contextualizeText(
  filename: string,
  headingPath: string[],
  originalText: string,
): string {
  return [
    "Document: " + filename,
    "Section: " + (headingPath.length ? headingPath.join(" > ") : "Document"),
    originalText,
  ].join("\n");
}

export const EMBEDDING_DIMENSIONS = 384;
