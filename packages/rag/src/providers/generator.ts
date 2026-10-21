import type { SearchResult } from "../types.js";

interface OpenAIResponse {
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

function pageLabel(startPage: number | null, endPage: number | null): string {
  if (!startPage) return "";
  return endPage && endPage !== startPage
    ? "Pages " + startPage + "–" + endPage
    : "Page " + startPage;
}

function sourceEvidence(source: SearchResult): string {
  const passages: string[] = [];
  let previousContinuationGroupId: string | null = null;

  for (const chunk of source.contextChunks) {
    if (
      chunk.continuationGroupId &&
      chunk.continuationGroupId === previousContinuationGroupId
    ) {
      passages[passages.length - 1] += " " + chunk.text;
    } else {
      const location = [
        pageLabel(chunk.startPage, chunk.endPage),
        chunk.headingPath.length
          ? "Section: " + chunk.headingPath.join(" > ")
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      passages.push((location ? location + "\n" : "") + chunk.text);
    }
    previousContinuationGroupId = chunk.continuationGroupId;
  }

  return passages.join("\n\n");
}

export async function generateWithOpenAI(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  question: string;
  sources: SearchResult[];
  fetcher?: typeof fetch;
}): Promise<string> {
  const context = input.sources
    .map((source, index) => {
      const pages = pageLabel(source.startPage, source.endPage);
      return (
        "[" +
        (index + 1) +
        "] " +
        source.filename +
        (pages ? ", " + pages.toLowerCase() : "") +
        "\n" +
        sourceEvidence(source)
      );
    })
    .join("\n\n");

  const baseUrl = input.baseUrl.endsWith("/")
    ? input.baseUrl
    : input.baseUrl + "/";
  const response = await (input.fetcher ?? fetch)(
    new URL("responses", baseUrl),
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + input.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        instructions: [
          "Answer using only the supplied sources.",
          "Cite claims with source numbers such as [1].",
          "If the sources do not support an answer, say that you do not have enough evidence.",
        ].join(" "),
        input: "Question: " + input.question + "\n\nSources:\n" + context,
        store: false,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      "OpenAI generation failed (" +
        response.status +
        "): " +
        (await response.text()),
    );
  }

  const payload = (await response.json()) as OpenAIResponse;
  const answer = payload.output
    ?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
  if (!answer) {
    throw new Error(
      payload.error?.message
        ? "OpenAI did not generate an answer: " + payload.error.message
        : "OpenAI returned an empty answer.",
    );
  }
  return answer;
}

export function createExtractiveAnswer(sources: SearchResult[]): string {
  if (!sources.length) {
    return "No relevant evidence was found in the selected collection.";
  }

  return [
    "Generation is not configured, so here are the strongest retrieved passages:",
    "",
    ...sources
      .slice(0, 3)
      .map(
        (source, index) =>
          "[" +
          (index + 1) +
          "] " +
          sourceEvidence(source).replace(/\s+/g, " ").trim(),
      ),
  ].join("\n\n");
}
