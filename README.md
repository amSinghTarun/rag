# OG RAG

OG RAG is a local-first document retrieval and RAG application. It uses a
React interface, a Bun server, SQLite for metadata, and LanceDB for vector
search.

Your source files, database, and vector index are stored locally. OpenAI is
currently the only supported provider for embeddings and generated answers.

> **OpenAI API key required:** The application can start without a key, but
> you must add or update an OpenAI API key before uploading, indexing, or
> searching documents. The same key enables RAG-generated answers.

## Recruiter showcase

A separate, Vercel-ready Next.js website lives in [`showcase/`](showcase). It
explains the ingestion pipeline, hybrid retrieval and ranking strategy,
collection boundaries, SQLite/LanceDB split, and OpenAI data boundary.

Run it locally with:

```bash
cd showcase
bun install --frozen-lockfile
bun run dev
```

For Vercel, import this repository and set the project **Root Directory** to
`showcase`. No environment variables are required. To show a prominent source
code link, optionally set `NEXT_PUBLIC_REPOSITORY_URL` to the repository URL.

## Features

- Start with a default collection and create additional collections to keep
  document libraries and searches separate.
- Upload PDF, DOCX, HTML, Markdown, and plain-text files.
- Upload up to 20 files per batch, with a 50 MB limit per file and a 250 MB
  batch limit.
- Track documents through `queued`, `indexing`, `ready`, and `failed` states.
- Avoid duplicate indexing by detecting matching file content within a
  collection.
- Search with hybrid retrieval: OpenAI embeddings, LanceDB vector search,
  BM25 keyword search, result fusion, reranking, and neighboring context.
- Inspect retrieved passages, filenames, page numbers, headings, and score
  details.
- Generate an answer from the retrieved sources using OpenAI.
- Delete documents together with their stored file, metadata, and vectors.
- Keep collections, uploads, metadata, and indexes between restarts.

## Run with Docker

Docker is the easiest way to run the application after cloning the repository.

### 1. Build the image

From the repository root:

```bash
docker build -t og-rag .
```

### 2. Start the container

```bash
docker run --rm --init \
  --name og-rag \
  --stop-timeout 120 \
  -p 127.0.0.1:3000:3000 \
  -v og-rag-data:/app/data \
  og-rag
```

Open [http://localhost:3000](http://localhost:3000).

The `og-rag-data` volume preserves uploaded files, SQLite metadata, the
LanceDB index, and locally saved settings when the container is replaced.
Use only one container at a time with this volume.

### 3. Add your OpenAI API key

After opening the application:

1. Select **Add API key** in the top-right corner.
2. Enter an OpenAI API key and select **Save API key**.
3. If the key changes later, use **Update API key** before searching again.

The key is saved in the local RAG data directory and is never returned to the
browser after it is stored. With Docker, it is persisted in the
`og-rag-data` volume.

You can instead supply the key through an ignored `.env` file:

```dotenv
OPENAI_API_KEY=your-key-here
```

Then start the container with:

```bash
docker run --rm --init \
  --name og-rag \
  --stop-timeout 120 \
  --env-file .env \
  -p 127.0.0.1:3000:3000 \
  -v og-rag-data:/app/data \
  og-rag
```

## Using the application

1. **Create a collection.** Collections keep document libraries and searches
   separate from one another.
2. **Select the collection.** Uploads and searches always use the currently
   selected collection.
3. **Upload documents.** The application parses, chunks, embeds, and indexes
   each file in the background. Wait until a document shows `ready` before
   searching it.
4. **Enter a question.** Search is limited to ready documents in the selected
   collection.
5. Choose one of the available actions:
   - **Inspect retrieval** shows the passages selected by hybrid search,
     including source and scoring information.
   - **Generate answer** sends the retrieved context to OpenAI and produces a
     source-backed RAG answer.

The OpenAI API key is required for both actions because semantic search uses
OpenAI embeddings. Answer generation also currently supports OpenAI only.

## How it works

1. The selected document is parsed into structured text.
2. The text is split into chunks while preserving headings and page metadata.
3. Chunk text is sent to OpenAI to create embeddings.
4. Files and metadata stay in the local data directory; embeddings are stored
   in LanceDB.
5. A search combines vector similarity with BM25 keyword matches, reranks the
   results, and includes nearby context chunks.
6. When **Generate answer** is selected, the question and retrieved source
   context are sent to OpenAI for answer generation.

## Supported files

| Format | Extensions |
| --- | --- |
| PDF | `.pdf` |
| Word | `.docx` |
| HTML | `.html`, `.htm` |
| Markdown | `.md`, `.markdown` |
| Plain text | `.txt` |

PDF processing extracts existing text and does not perform OCR. Scanned or
image-only PDFs may therefore contain no searchable text.

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI key used for embeddings and answer generation | Not set |
| `OPENAI_BASE_URL` | OpenAI API base URL | `https://api.openai.com/v1/` |
| `RAG_EMBEDDING_MODEL` | Embedding model | `text-embedding-3-small` |
| `OPENAI_GENERATION_MODEL` | Answer-generation model | `gpt-5.4-mini` |
| `RAG_DATA_DIR` | Database, index, settings, and uploaded-file directory | `./rag-data` locally; `/app/data` in Docker |

## Local development

Install [Bun](https://bun.sh), then run:

```bash
bun install --frozen-lockfile
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

For a production-style local start, use `bun run start` instead of
`bun run dev`.

Run the project checks with:

```bash
bun run build
bun test packages/rag/tests
```

## Current limitations

- OpenAI is currently the only supported embedding and answer-generation
  provider.
- The application is intended for local, single-user use and does not include
  authentication.
- SQLite and embedded LanceDB storage are designed for one running application
  process per data directory or Docker volume.
- Although files and indexes remain local, document text and search queries
  are sent to OpenAI as part of embedding and answer-generation requests.
