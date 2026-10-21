import type { StoredChunkRow } from "../storage/lance-store.js";

export interface LexicalResult {
  row: StoredChunkRow;
  score: number;
}

export function tokenize(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
    (token) => token.length > 1,
  );
}

// BM25 checks each query word against each chunk, calculates that chunk’s relevance score, then returns the highest-scoring chunks
export function bm25Search(
  query: string,
  rows: StoredChunkRow[], // all document chunks of collectionId
  limit: number,
  textForRow: (row: StoredChunkRow) => string,
): LexicalResult[] {
  // break query into array of individual words
  const queryTerms: string[] = [...new Set(tokenize(query))];
  if (!queryTerms.length || !rows.length) return [];

  // break all documents chunks(collection id, document id and original text) into array of individual words
  const documents: string[][] = rows.map((row) => tokenize(textForRow(row)));
  const averageLength =
    documents.reduce((sum, terms) => sum + terms.length, 0) / documents.length;

  // frequency of each query's word in all the document
  const documentFrequency: Map<string, number> = new Map<string, number>();

  for (const terms of documents) {
    // get the unique elemets from all the words in document
    const unique = new Set(terms);
    for (const term of queryTerms) {
      // check if document has terms of query and store how many times terms of query come in unique document array
      if (unique.has(term)) {
        // How many different chunks contain each query term at least once
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
  }

  const k1 = 1.2; // Controls how much repeating a query word improves the chunk's score.
  const b = 0.75; // Stops longer chunks from scoring higher just because they contain more words.
  const scores: LexicalResult[] = [];

  // we go through all tokenize document
  for (let index = 0; index < rows.length; index++) {
    const terms = documents[index]!;

    // freq of each term of document that is present in the query, this include duplicate as well
    const frequencies = new Map<string, number>();
    for (const term of terms) {
      // checking if query contain any word of the document, if do, increase freq of that term
      if (queryTerms.includes(term)) {
        frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      }
    }

    // It stores the BM25 relevance score for the chunk currently being checked.
    let score = 0;

    for (const term of queryTerms) {
      // frequency of any term of each in the currnet document
      const frequency = frequencies.get(term) ?? 0;
      if (!frequency) continue; // in case if the term in query is not in document

      // freq of any term in all of the documents (unique only)
      const df = documentFrequency.get(term) ?? 0;

      // Suppose there are 100 chunks:
      // "policy" appears in 80 chunks
      // "parental" appears in 5 chunks
      // parental is more useful for identifying the correct chunk, so BM25 gives it more weight.
      // This becomes the inverse document frequency:
      const inverseDocumentFrequency = Math.log(
        1 + (rows.length - df + 0.5) / (df + 0.5),
      );

      // Combines word repetition and chunk length to prevent repeated words or longer chunks from unfairly receiving higher scores.
      const denominator =
        frequency +
        k1 * (1 - b + b * (terms.length / Math.max(1, averageLength)));

      score +=
        inverseDocumentFrequency * ((frequency * (k1 + 1)) / denominator);
    }

    if (score > 0) scores.push({ row: rows[index]!, score });
  }

  return scores.sort((left, right) => right.score - left.score).slice(0, limit);
}
