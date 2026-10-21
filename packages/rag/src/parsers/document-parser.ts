import path from "node:path";
import { readFile } from "node:fs/promises";
import mammoth from "mammoth";
import type { ParsedElement } from "../types";

function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return entities[entity.toLocaleLowerCase()] ?? " ";
  });
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeHeading(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || cleaned.length > 100) return false;
  if (/^#{1,6}\s+/.test(cleaned)) return true;
  if (/^[A-Z\d][A-Z\d\s&/,:()-]{3,}$/.test(cleaned)) return true;
  return (
    cleaned.length < 70 &&
    !/[.!?;:]$/.test(cleaned) &&
    cleaned.split(/\s+/).length <= 10
  );
}

function textToElements(text: string, pageNumber?: number): ParsedElement[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];

  return normalized
    .split(/\n\s*\n|(?<=\n)(?=#{1,6}\s)/)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block): ParsedElement[] => {
      const heading = block.match(/^(#{1,6})\s+(.+)$/s);
      if (heading) {
        return [
          {
            type: "heading",
            text: heading[2]!.trim(),
            headingLevel: heading[1]!.length,
            ...(pageNumber ? { pageNumber } : {}),
          },
        ];
      }

      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length === 1 && looksLikeHeading(lines[0]!)) {
        return [
          {
            type: "heading",
            text: lines[0]!,
            headingLevel: 2,
            ...(pageNumber ? { pageNumber } : {}),
          },
        ];
      }

      return [
        {
          type: /^[-*•]\s+/.test(block) ? "list-item" : "paragraph",
          text: lines.join(" "),
          ...(pageNumber ? { pageNumber } : {}),
        },
      ];
    });
}

function htmlToStructuredText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level: string, content: string) =>
          "\n\n" +
          "#".repeat(Number.parseInt(level, 10)) +
          " " +
          content.replace(/<[^>]+>/g, " ") +
          "\n\n",
      )
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<\/(p|div|section|article|li|tr)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

async function parsePdf(filePath: string): Promise<ParsedElement[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(filePath));
  const document = await pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
  }).promise;

  const elements: ParsedElement[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let current = "";

    for (const item of content.items) {
      if (!("str" in item)) continue;
      const value = item.str.trim();
      if (value) current += (current ? " " : "") + value;
      if ("hasEOL" in item && item.hasEOL && current) {
        lines.push(current);
        current = "";
      }
    }
    if (current) lines.push(current);
    elements.push(...textToElements(lines.join("\n\n"), pageNumber));
  }
  return elements;
}

export async function parseDocument(
  filePath: string,
  mimeType: string,
  originalFilename: string,
): Promise<ParsedElement[]> {
  const extension = path.extname(originalFilename).toLocaleLowerCase();

  if (mimeType === "application/pdf" || extension === ".pdf") {
    return parsePdf(filePath);
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    extension === ".docx"
  ) {
    const result = await mammoth.convertToHtml({ path: filePath });
    return textToElements(htmlToStructuredText(result.value));
  }

  const contents = await readFile(filePath, "utf8");
  if (
    mimeType === "text/html" ||
    extension === ".html" ||
    extension === ".htm"
  ) {
    return textToElements(htmlToStructuredText(contents));
  }

  if (
    mimeType.startsWith("text/") ||
    [".txt", ".md", ".markdown"].includes(extension)
  ) {
    return textToElements(contents);
  }

  throw new Error(
    "Unsupported document type. Supported extensions: PDF, DOCX, HTML, Markdown and text.",
  );
}
