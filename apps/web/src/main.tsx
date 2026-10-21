import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Collection {
  id: string;
  name: string;
  createdAt: string;
}

interface DocumentRecord {
  id: string;
  collectionId: string;
  originalFilename: string;
  status: "queued" | "indexing" | "ready" | "failed";
  chunkCount: number;
  sizeBytes: number;
  errorMessage: string | null;
}

interface SearchResult {
  chunkId: string;
  documentId: string;
  text: string;
  filename: string;
  startPage: number | null;
  endPage: number | null;
  headingPath: string[];
  contextChunks: Array<{
    chunkId: string;
    text: string;
    startPage: number | null;
    endPage: number | null;
    headingPath: string[];
    chunkPosition: number;
    continuationGroupId: string | null;
    continuationIndex: number | null;
  }>;
  score: number;
  scores: {
    fusion: number;
    rerank: number;
    vectorRank: number | null;
    keywordRank: number | null;
  };
}

interface Health {
  embedding: {
    provider: string;
    model: string;
    dimensions: number;
    configured: boolean;
  };
  generation: {
    enabled: boolean;
    model: string | null;
  };
}

async function api<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? "Request failed.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function bytes(value: number): string {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function pages(startPage: number | null, endPage: number | null): string | null {
  if (!startPage) return null;
  return endPage && endPage !== startPage
    ? "pages " + startPage + "–" + endPage
    : "page " + startPage;
}

function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState("");
  const [selectedFileCount, setSelectedFileCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showApiKeyDialog, setShowApiKeyDialog] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);

  const activeCollection = useMemo(
    () => collections.find((item) => item.id === collectionId),
    [collections, collectionId],
  );
  const activeDocuments = useMemo(
    () => documents.filter((document) => document.collectionId === collectionId),
    [documents, collectionId],
  );
  const hasPendingDocuments = documents.some(
    (document) => document.status === "queued" || document.status === "indexing",
  );
  const hasReadyDocuments = activeDocuments.some(
    (document) => document.status === "ready",
  );

  async function loadCollections() {
    const payload = await api<{ collections: Collection[] }>(
      "/v1/collections",
    );
    setCollections(payload.collections);
    setCollectionId((current) =>
      current && payload.collections.some((item) => item.id === current)
        ? current
        : (payload.collections[0]?.id ?? ""),
    );
  }

  async function loadDocuments() {
    const payload = await api<{ documents: DocumentRecord[] }>(
      "/v1/documents",
    );
    setDocuments(payload.documents);
  }

  useEffect(() => {
    void Promise.all([
      api<Health>("/v1/health"),
      api<{ collections: Collection[] }>("/v1/collections"),
      api<{ documents: DocumentRecord[] }>("/v1/documents"),
    ])
      .then(([healthPayload, collectionPayload, documentPayload]) => {
        const savedCollectionId = window.localStorage.getItem(
          "local-rag.collection-id",
        );
        const savedCollectionExists = collectionPayload.collections.some(
          (collection) => collection.id === savedCollectionId,
        );
        setHealth(healthPayload);
        setCollections(collectionPayload.collections);
        setDocuments(documentPayload.documents);
        setCollectionId(
          savedCollectionExists
            ? savedCollectionId!
            : (documentPayload.documents[0]?.collectionId ??
                collectionPayload.collections[0]?.id ??
                ""),
        );
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    if (!hasPendingDocuments) return;
    const timer = window.setInterval(() => {
      void loadDocuments().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [hasPendingDocuments]);

  function selectCollection(id: string) {
    window.localStorage.setItem("local-rag.collection-id", id);
    setCollectionId(id);
    setResults([]);
    setAnswer(null);
    setMessage(null);
  }

  async function createCollection(event: React.FormEvent) {
    event.preventDefault();
    if (!newCollection.trim()) return;
    setMessage(null);
    try {
      const payload = await api<{ collection: Collection }>(
        "/v1/collections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: newCollection }),
        },
      );
      setNewCollection("");
      await loadCollections();
      window.localStorage.setItem(
        "local-rag.collection-id",
        payload.collection.id,
      );
      setCollectionId(payload.collection.id);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("documents") as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (!files.length || !collectionId) return;
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      for (const file of files) body.append("files", file);
      const payload = await api<{ documents: DocumentRecord[] }>(
        "/v1/documents?collectionId=" +
          encodeURIComponent(collectionId),
        { method: "POST", body },
      );
      form.reset();
      setSelectedFileCount(0);
      await loadDocuments();
      setMessage(
        payload.documents.length === 1
          ? "1 document queued for indexing."
          : payload.documents.length + " documents queued for indexing.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(generate: boolean) {
    if (!query.trim() || !collectionId) return;
    setBusy(true);
    setMessage(null);
    setAnswer(null);
    try {
      const payload = await api<
        | { results: SearchResult[] }
        | {
            answer: string;
            generated: boolean;
            sources: SearchResult[];
          }
      >(generate ? "/v1/answer" : "/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collectionId,
          query,
          topK: 8,
        }),
      });

      if ("answer" in payload) {
        setAnswer(payload.answer);
        setResults(payload.sources);
      } else {
        setResults(payload.results);
      }
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDocument(documentId: string) {
    setMessage(null);
    try {
      await api("/v1/documents/" + encodeURIComponent(documentId), {
        method: "DELETE",
      });
      await loadDocuments();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  async function saveApiKey(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setSavingApiKey(true);
    setMessage(null);
    try {
      await api<{ configured: true }>("/v1/settings/openai", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      setHealth((current) =>
        current
          ? {
              ...current,
              embedding: { ...current.embedding, configured: true },
            }
          : current,
      );
      setApiKey("");
      setShowApiKeyDialog(false);
      setMessage(
        documents.length
          ? "OpenAI API key saved locally. Re-index documents created with another embedding provider before searching."
          : "OpenAI API key saved locally. You can now upload and search documents.",
      );
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSavingApiKey(false);
    }
  }

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">LOCAL-FIRST RETRIEVAL</p>
          <h1>Local RAG</h1>
          <p className="lede">
            Keep files and indexes local while using OpenAI-powered
            semantic retrieval.
          </p>
        </div>
        <div className="runtime-controls">
          <div className="runtime">
            <span
              className={
                health?.embedding.configured
                  ? "status-dot"
                  : "status-dot warning"
              }
            />
            {health
              ? health.embedding.configured
                ? health.embedding.provider +
                  " · " +
                  health.embedding.model +
                  (health.generation.enabled
                    ? " · generation enabled"
                    : " · extractive answers")
                : "OpenAI API key required"
              : "Connecting…"}
          </div>
          <button
            className={
              health?.embedding.configured
                ? "api-key-button"
                : "api-key-button api-key-required"
            }
            type="button"
            onClick={() => {
              setApiKey("");
              setShowApiKeyDialog(true);
            }}
          >
            {health?.embedding.configured ? "Update API key" : "Add API key"}
          </button>
        </div>
      </header>

      {message ? (
        <div className="notice" role="alert">
          {message}
        </div>
      ) : null}

      <section className="layout">
        <aside className="library-panel">
          <div className="section-heading library-heading">
            <div>
              <p className="step">DOCUMENT LIBRARY</p>
              <h2>Collections &amp; files</h2>
            </div>
            <span className="library-total">
            <span>{collections.length} available</span>
            </span>
          </div>

          <div className="collection-section">

            <div className="collection-list">
              {collections.map((collection) => {
                const isActive = collection.id === collectionId;
                const documentCount = documents.filter(
                  (document) => document.collectionId === collection.id,
                ).length;

                return (
                  <button
                    aria-pressed={isActive}
                    className={isActive ? "collection active" : "collection"}
                    key={collection.id}
                    onClick={() => selectCollection(collection.id)}
                  >
                    <span className="collection-main">
                      <span className="collection-indicator" aria-hidden="true">
                        {isActive ? "✓" : ""}
                      </span>
                      <span className="collection-copy">
                        <strong>{collection.name}</strong>
                        <small>{isActive ? "Selected collection" : "Collection"}</small>
                      </span>
                    </span>
                    <span className="collection-count">
                      {documentCount} {documentCount === 1 ? "file" : "files"}
                    </span>
                  </button>
                );
              })}
            </div>

            <form className="inline-form add-collection" onSubmit={createCollection}>
              <input
                value={newCollection}
                onChange={(event) => setNewCollection(event.target.value)}
                placeholder="New collection name"
                aria-label="New collection name"
              />
              <button type="submit">Add collection</button>
            </form>
          </div>

          <section className="library-section">
            <div className="section-heading document-heading">
              <div>
                <p className="step">FILES IN COLLECTION</p>
                <h2>{activeCollection?.name ?? "Select a collection"}</h2>
              </div>
              <span className="collection-document-count">
                {activeDocuments.length} {activeDocuments.length === 1 ? "file" : "files"}
              </span>
            </div>
            <p className="collection-context">
              Uploads and searches below are scoped to this collection.
            </p>

            <form className="upload" onSubmit={upload}>
              <input
                type="file"
                name="documents"
                accept=".pdf,.docx,.html,.htm,.md,.markdown,.txt"
                multiple
                onChange={(event) => {
                  setSelectedFileCount(event.target.files?.length ?? 0);
                  setMessage(null);
                }}
                disabled={!collectionId || busy || !health?.embedding.configured}
                required
              />
              <button
                disabled={
                  !collectionId ||
                  busy ||
                  selectedFileCount === 0 ||
                  !health?.embedding.configured
                }
                type="submit"
              >
                {busy
                  ? "Uploading…"
                  : selectedFileCount > 1
                    ? "Upload " + selectedFileCount + " files"
                    : "Upload files"}
              </button>
            </form>

            <div className="documents">
              {!activeDocuments.length ? (
                <p className="empty">
                  No documents yet. Upload a PDF, DOCX, HTML, Markdown or
                  text file.
                </p>
              ) : (
                activeDocuments.map((document) => (
                  <article className="document" key={document.id}>
                    <div>
                      <strong>{document.originalFilename}</strong>
                      <p>
                        {bytes(document.sizeBytes)} ·{" "}
                        {document.chunkCount} chunks
                      </p>
                      {document.errorMessage ? (
                        <p className="error">{document.errorMessage}</p>
                      ) : null}
                    </div>
                    <div className="document-actions">
                      <span className={"badge " + document.status}>
                        {document.status}
                      </span>
                      <button
                        className="secondary danger"
                        onClick={() => void deleteDocument(document.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>
        </aside>

        <section className="panel retrieval-panel">
            <div className="section-heading">
              <div>
                <p className="step">SEARCH</p>
                <h2>Retrieval playground</h2>
              </div>
              <span className="muted">
                Vector + BM25 → fusion → rerank → neighbors
              </span>
            </div>

            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Ask something about the indexed documents…"
              rows={3}
            />
            <div className="actions">
              <button
                disabled={
                  busy ||
                  !query.trim() ||
                  !hasReadyDocuments ||
                  !health?.embedding.configured
                }
                onClick={() => void runSearch(false)}
              >
                Inspect retrieval
              </button>
              <button
                className="secondary"
                disabled={
                  busy ||
                  !query.trim() ||
                  !hasReadyDocuments ||
                  !health?.embedding.configured
                }
                onClick={() => void runSearch(true)}
              >
                Generate answer
              </button>
            </div>

            {answer ? (
              <div className="answer">
                <p className="eyebrow">ANSWER</p>
                <div className="answer-text">{answer}</div>
              </div>
            ) : null}

            <div className="results">
              {results.map((result, index) => (
                <article className="result" key={result.chunkId}>
                  <div className="result-meta">
                    <span>#{index + 1}</span>
                    <span>{result.filename}</span>
                    {pages(result.startPage, result.endPage) ? (
                      <span>{pages(result.startPage, result.endPage)}</span>
                    ) : null}
                    <span>
                      score {result.score.toFixed(3)}
                    </span>
                  </div>
                  {result.headingPath.length ? (
                    <p className="heading-path">
                      {result.headingPath.join(" / ")}
                    </p>
                  ) : null}
                  <p>{result.text}</p>
                  {result.contextChunks.length > 1 ? (
                    <details className="context-details">
                      <summary className="result-meta">
                        Expanded context ({result.contextChunks.length - 1}{" "}
                        {result.contextChunks.length === 2 ? "chunk" : "chunks"})
                      </summary>
                      <div className="context-chunks">
                        {result.contextChunks
                          .filter((chunk) => chunk.chunkId !== result.chunkId)
                          .map((chunk) => (
                            <div className="context-chunk" key={chunk.chunkId}>
                              <span className="context-label">
                                {chunk.continuationGroupId
                                  ? "Continuation part " +
                                    ((chunk.continuationIndex ?? 0) + 1)
                                  : chunk.chunkPosition <
                                      result.contextChunks.find(
                                        (item) =>
                                          item.chunkId === result.chunkId,
                                      )!.chunkPosition
                                    ? "Previous chunk"
                                    : "Following chunk"}
                                {pages(chunk.startPage, chunk.endPage)
                                  ? " · " + pages(chunk.startPage, chunk.endPage)
                                  : ""}
                              </span>
                              <p>{chunk.text}</p>
                            </div>
                          ))}
                      </div>
                    </details>
                  ) : null}
                  <details>
                    <summary className="result-meta">Score breakdown</summary>
                    <code>
                      vector rank:{" "}
                      {result.scores.vectorRank ?? "—"} · keyword rank:{" "}
                      {result.scores.keywordRank ?? "—"} · fusion:{" "}
                      {result.scores.fusion.toFixed(4)}
                    </code>
                  </details>
                </article>
              ))}
            </div>
        </section>
      </section>

      {showApiKeyDialog ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingApiKey) {
              setShowApiKeyDialog(false);
              setApiKey("");
            }
          }}
        >
          <section
            aria-labelledby="api-key-title"
            aria-modal="true"
            className="settings-dialog"
            role="dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !savingApiKey) {
                setShowApiKeyDialog(false);
                setApiKey("");
              }
            }}
          >
            <div className="dialog-heading">
              <div>
                <p className="step">OPENAI CONNECTION</p>
                <h2 id="api-key-title">
                  {health?.embedding.configured
                    ? "Update API key"
                    : "Add API key"}
                </h2>
              </div>
              <button
                aria-label="Close"
                className="dialog-close"
                disabled={savingApiKey}
                onClick={() => {
                  setShowApiKeyDialog(false);
                  setApiKey("");
                }}
                type="button"
              >
                ×
              </button>
            </div>
            <p className="dialog-copy" id="api-key-help">
              The key is stored only on this machine in the local RAG data
              directory. It is never returned to the browser after saving.
            </p>
            <form onSubmit={saveApiKey}>
              <label className="secret-label" htmlFor="openai-api-key">
                OpenAI API key
              </label>
              <input
                autoComplete="off"
                autoFocus
                id="openai-api-key"
                aria-describedby="api-key-help"
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…"
                type="password"
                value={apiKey}
              />
              <div className="dialog-actions">
                <button
                  className="secondary"
                  disabled={savingApiKey}
                  onClick={() => {
                    setShowApiKeyDialog(false);
                    setApiKey("");
                  }}
                  type="button"
                >
                  Cancel
                </button>
                <button disabled={savingApiKey || !apiKey.trim()} type="submit">
                  {savingApiKey ? "Saving…" : "Save API key"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
