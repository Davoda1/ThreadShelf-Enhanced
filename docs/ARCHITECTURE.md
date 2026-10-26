# Architecture

ThreadShelf Enhanced uses one Node.js HTTP server per database, reusable core
modules, local embeddings, LanceDB archive/vector storage and a React browser UI.
SQLite coordinates locks and persists import jobs, publication metadata and
temporary staging records; it does not replace the published LanceDB archive.

Conversation generation is an optional layer on top of the archive. The
`llama.cpp` path is local; the explicitly selected OpenRouter path is external.

## High-Level Flow

Imports follow a durable sequence: accept uploaded files or snapshot a local
folder, persist the job, normalize records into bounded disk spools, prepare
archive rows and vectors, then atomically publish their matching generation.
Readers keep using the previously published generation until that final step.
The HTTP UI, CLI and MCP read through the same storage and service layer.

Conversation generation is separate: stored threads or new local chats use the
provider registry, then the completed exchange is saved with recoverable index
work. Local `llama.cpp` and explicitly selected OpenRouter share this lifecycle.

## Modules

`src/server.ts`

- Express app.
- Serves the web UI.
- Exposes collection, ingest, search, thread, upload, stats, and health routes.
- Mounts HTTP routes from `src/routes/`.
- Holds the database-specific HTTP instance lock, starts job recovery and memory
  monitoring, and coordinates their shutdown before releasing the instance lock.
- Mounts the OpenAI/Anthropic-compatible local model API at `/v1`
  (`src/routes/local-api.ts`) ahead of the app-wide 512 KB JSON parser, since
  inference bodies carry whole conversations.
- Starts the optional network listener (`src/local-api-network.ts`): a second
  port bound to all interfaces that serves the same `/v1` router and nothing
  else, so sharing models never exposes the archive or `/api`.

`src/routes/`

- Own HTTP-specific validation, upload handling, and NDJSON progress streams.
- Delegate reusable behavior to `src/services/`, `src/import-jobs.ts` and
  `src/store.ts`. Legacy ingest streams observe durable jobs; disconnecting after
  acceptance does not cancel them. Cancellation uses the job action explicitly.
- Wrap model/runtime downloads in `abortOnDisconnect` (`stream-abort.ts`), which
  listens for both `req`'s `aborted` and `res`'s `close` — a browser cancelling a
  `fetch` only fires the latter, and missing it leaves the server downloading
  gigabytes after the user pressed Cancel.

`src/services/`

- Shared business logic used by HTTP routes and MCP.
- Keeps collection, search, and thread loading behavior consistent across surfaces.

`src/import-jobs.ts` and `src/indexing-coordinator.ts`

- Persist accepted job state, progress, input checksums, attempts and cancellation.
  Upload transfer must finish before the client can safely close its tab.
- Snapshot supported source files and bounded image companions so later source
  changes cannot silently alter an accepted job. Resume verifies checksums.
- Share one active index operation across web, CLI, watcher and edit recovery.
  A second HTTP server for the same database is rejected even on a different port.
- Reserve an active clear job's collection against other mutations while leaving
  its published data readable. Interrupted clear jobs retain a logical reservation
  until recovery or cancellation; process termination alone does not bypass it.
- Serialize collection job acceptance, claiming and deletion. Deletion cancels
  queued work and rejects active/interrupted imports rather than allowing a job
  to recreate a deleted collection later.
- Remove completed/failed/cancelled history under the same lifecycle coordination,
  retaining archive data while discarding that job's retry inputs.

`src/upload-storage.ts` and `src/routes/uploads.ts`

- List uploaded originals with bounded pagination and relative paths; expose
  selective deletion and collection-wide file cleanup to the Manage uploads dialog.
- Coordinate cleanup with indexing and job input maintenance, including jobs in
  other collections whose incomplete snapshots still depend on those files.
- Exclude transfer staging, symbolic links and protected server storage; remove
  regular uploaded files without changing archive rows, indexes or job history.

`src/ingest.ts` and `src/enhanced-import/`

- Discover supported exports recursively and normalize them incrementally where
  their format allows. The adapter layer retains raw data and source identity;
  `src/parser.ts` remains available for the original parser API.
- Write bounded records and verified completion checkpoints to disk spools.
  No complete folder or collection becomes one JavaScript array/string.
- Report unsupported/unrelated files, auxiliary metadata and empty exports as
  skips. A valid mixed folder or ZIP still imports. Recognized malformed exports,
  no valid conversations, or preparation failure prevent a clear replacement.
- Reimport merges local continuations into matching conversations; missing keys
  retain their locally continued branch. Rewritten positional keys fork safely.
- Preserve an empty/skipped source's stored data during additive/watch imports.
  An empty auxiliary file does not veto a clear selection with valid conversations.
- Publish uploaded originals only for source groups that completed successfully.

`src/import-storage-stage.ts`, `src/storage-publication.ts` and `src/storage-read-leases.ts`

- Join old/new records, replay retries and cache completed embedding batches on
  disk rather than retaining archive-sized maps in the JavaScript heap.
- Stage archive rows with an internal generation and vectors in a hidden table.
  A small synced SQLite transaction selects both together. Cancellation or failure
  before publication leaves the old selection intact.
- Capture one publication mapping for a read operation. Shared read leases prevent
  retirement/deletion from removing tables still in use. Cleanup retains the
  current and previous publication and reclaims abandoned staging safely.
- Keep all public queries and mutations on the active generation; internal tables
  never appear as user collections. Legacy named collections remain readable.

Saved-edit index recovery (`src/store.ts`)

- Archive turns and their durable `indexPending` marker commit together for local
  edits. `local`, `all`, `delete` and `reset` describe the required index repair.
- Embed outside the global thread-table lock, then re-read the stored scope before
  committing. A changed snapshot is retried, preserving concurrent appends.
- Preserve failures in `indexAttempts`, `indexRetryAt` and `indexError`, with
  15-second to one-hour backoff and a pause after eight failed attempts until the
  affected thread changes. Recovery shares the indexer with import jobs.
- Retain undecodable rows as `invalid` instead of deleting their raw data. Searches
  exclude unsafe pending/invalid rows. An excessive exclusion backlog produces
  `INDEX_RECOVERY_REQUIRED` rather than an unbounded query or partial success.
- Use LanceDB `readConsistencyInterval: 0` and collection-before-thread lock order
  so separate processes observe current commits without bypassing coordination.

`src/memory-governor.ts`

- Check RSS/native memory, V8 heap headroom and available host/container memory,
  including ancestor cgroup limits and reclaimable clean cache.
- Reduce batch sizes, pause for available headroom, or return a controlled pressure
  error. Checkpoints are cancellable; a JavaScript heap ceiling is not a whole-
  process or whole-system memory limit.

See [IMPORT-JOBS.md](IMPORT-JOBS.md) for APIs, resource limits and recovery actions.

`src/parser.ts`

- Detects provider format.
- Converts provider-specific JSON into normalized turns, including Google AI
  Studio text chats and Imagen prompt histories.
- Supported providers: Google AI Studio, OpenRouter, LM Studio, Grok/xAI,
  ChatGPT/OpenAI, and Claude/Anthropic.

`src/chunking.ts`

- Splits long turn text into searchable chunks.
- Preserves `sourceFile`, `role`, and `turnIndex` metadata.

`src/embedding.ts`

- Loads the local multilingual Xenova embedding model.
- Produces 384-dimensional vectors for chunks and search queries.
- Reuses completed import embeddings only when the text and certified identity of
  the actually loaded model/tokenizer/runtime match. Missing or changing cache
  files disable certification; a model name alone is not proof of compatible bytes.

`src/store.ts`

- Resolves logical collections to their published archive generation and vector
  table, with a fallback for legacy named tables.
- Writes chunk rows.
- Runs vector search.
- Lists files and collection stats.
- Persists normalized conversation turns in the internal `__threads` table at
  ingest time, so the thread view and the conversation listing keep working
  after a source file is moved, rewritten, or deleted. Table names starting
  with `__` are internal and never listed as collections.

`src/validation.ts`

- Normalizes and validates API inputs.
- Keeps route behavior predictable and testable.

`src/generation/`

- Defines the plugin contract shared by generation providers.
- Discovers current GGUF files under default and user-configured roots.
- Manages one loopback-only `llama-server` process for the selected model.
- Wraps the OpenAI-compatible llama.cpp and OpenRouter chat APIs.
- Maps public model ids to GGUF files for the `/v1` local model API and loads
  them under the same model lease as UI chats (`local-api.ts`).
- Stops the previous `llama-server` and waits for it to exit before spawning
  another model, and optionally unloads an idle model after
  `idleUnloadMinutes` (`llama-process.ts`).
- Converts provider SSE into redacted NDJSON progress and token events for the UI.
- Reports whether a GGUF is discovered, loading, or active in the managed runtime.
- Maps validated CPU/GPU/hybrid/multi-GPU profiles to upstream llama.cpp flags.
- Provides a loopback-only, directory-only filesystem browser for model roots.
- Keeps OpenRouter API keys in environment/session memory, never persisted config.
- Contains the explicit-consent llama.cpp release installer primitives, including
  the `nightly-tag.txt` resolution that finds the release actually carrying
  binaries (`llama-install.ts`).
- Owns created-chat lifecycle and per-thread generation leases in
  `src/generation/threads.ts`.
- Browses the public Hugging Face GGUF catalog read-only, without a token, and
  detects gated repositories up front (`model-catalog.ts`).
- Plans and fetches catalog models into `downloadDirectory`, verifying each file
  against its LFS `oid` before moving it into place (`model-download.ts`).
- Shares one resumable, hash-verifying downloader between runtime archives and
  models; a cancelled transfer keeps its `.part` file, any other failure deletes
  it (`downloader.ts`).
- Detects accelerators and RAM and turns a byte size into a single
  fits/tight/too-large verdict used by every surface (`hardware.ts`).
- Builds the one-screen setup plan, fingerprints exactly what it would fetch, and
  runs it (`quick-setup.ts`). The plan is always rebuilt server-side and matched
  against the approved fingerprint, so a client can never hand the server a URL
  to fetch and execute.

`mcp/server.ts`

- Exposes indexed local data to MCP clients over stdio.
- Reuses the same service layer as the web app.

`client/src/`

- React frontend built with Vite into `public/`.
- Handles collection selection, uploads, persistent import-job cards, search,
  role filters, file tree, thread reader and the persistent New chat workspace.
- Stores separate basic/rich rendering preferences for user, thinking and response
  roles. Basic mode still formats Markdown; visibility filters remain independent.
- Defers expensive offscreen/collapsed formatting and preserves source text for
  copy/export and navigation. Lazy mounting preserves the visible scroll position.
- Localizes interface text in English (default), Hungarian, German, Japanese,
  French and Russian without translating conversation content.
- Loads remote images inline on click by default, or automatically when selected.
  Compact/wide placeholders keep missing, waiting and failed states readable.

`src/image-cache.ts` and `src/routes/image-cache.ts`

- Fetch public HTTP(S) images through a server proxy, with DNS pinning, redirect
  validation, time/byte limits and raster signature checks. Credentials, cookies
  and referrers are not forwarded; private network addresses and active formats
  such as HTML/SVG are rejected.
- Optionally retain image bytes in a separate server-only cache partitioned by
  collection. Caching starts disabled and has a shared total size limit; collection
  or whole-cache purge does not modify archive data.
- Use `Cache-Control: no-store` for proxy responses. Disabling the cache retains
  existing cache bytes but bypasses their use and prevents new cache writes.
  Explicit imported/local image assets do not use the external proxy.

## Data Model

Parser output is normalized into turns shaped like:

```js
{
  user: '...',
  thinking: '...',
  ai: '...',
  model: 'optional-model-name'
}
```

Not every turn has every role. A user-only or assistant-only message is valid.

Chunk rows stored in LanceDB include:

- Vector embedding.
- Text.
- Role: `user`, `thinking`, or `ai`.
- Source file.
- Turn index.
- Collection name.
- Model metadata when available.

## Collections

Each collection is a logical archive. Legacy collections use their named LanceDB
vector table. A 1.3.0 import prepares a hidden vector table and archive rows tagged
with an internal generation, then publishes their mapping atomically. The shared
`__threads` key includes `(collection, sourceFile, conversationKey, importGeneration)`;
public thread identities remain `(collection, sourceFile, conversationKey)`.
Collections isolate archives:
- One provider per collection.
- One project per collection.
- One time range per collection.
- Throwaway collections for real-data testing.

The special `all` selector is not a table. It searches across available collections.

Chats created inside ThreadShelf share the same normalized turn representation
and use the dedicated `threadshelf_conversations` collection plus `__threads`.
Their rows and turns set `createdInThreadShelf=true` and retain creation time,
generation backend, and model metadata. They never pretend to be source export
files. Imported threads keep thread-level archive provenance while appended
ThreadShelf turns carry per-turn provenance. After a complete response, the API
updates normalized storage and idempotently replaces only ThreadShelf-authored
search chunks. Generation is serialized per thread.

## Uploads

Browser folder uploads are stored under `.uploads/` by default. The path can be changed with:

```bash
UPLOADS_DIR=path/to/uploads npm start
```

On Windows PowerShell:

```powershell
$env:UPLOADS_DIR='D:\threadshelf-uploads'
npm start
```

Upload paths are normalized and checked to reduce path traversal risk.
Incoming multipart files are staged on disk rather than buffered fully in
memory. Browser folder uploads include supported raster image companions as well
as export files. Accepted inputs and progress live below the configured database;
completed source originals retain their compatible `.uploads/<collection>` paths.
Deleting a collection removes its archive generations, vector tables, publication
metadata and uploaded copies; it never deletes the original folder selected by
the user.

## Embeddings

The app uses:

```text
Xenova/paraphrase-multilingual-MiniLM-L12-v2
```

This is a local multilingual model. The first run may be slower because model files need to download/cache.

## API Surface

Core routes:

- `GET /api/health`
- `GET /api/memory`
- `GET /api/import-jobs`, `GET /api/import-jobs/:id`
- `POST /api/import-jobs`, `POST /api/import-jobs/upload`
- `POST /api/import-jobs/:id/cancel`, `POST /api/import-jobs/:id/retry`
- `GET`, `PUT`, `DELETE /api/image-cache`
- `GET /api/image-cache/resource`
- `GET /api/collections`
- `POST /api/collections`
- `DELETE /api/collections/:name`
- `POST /api/collections/:name/clear`
- `GET /api/collections/:name/stats`
- `GET /api/files`
- `GET /api/ingest-preview`
- `POST /api/ingest-progress`
- `POST /api/ingest-upload`
- `GET /api/search`
- `GET /api/thread`
- `GET /api/generation/config` (loopback only)
- `PUT /api/generation/config` (loopback only)
- `GET /api/generation/models` (loopback only)
- `GET /api/generation/runtime` (redacted runtime status)
- `GET /api/generation/runtime/logs` / `POST /api/generation/runtime/eject` (loopback only)
- `GET /api/generation/directories` (loopback only)
- `/api/generation/prompts` CRUD and active selection (loopback only)
- `/api/generation/threads` list/create/get/rename/delete (loopback only)
- `POST /api/generation/chat` (loopback only)
- `POST /api/generation/chat/stream` (loopback-only NDJSON)
- `GET /api/generation/hardware` (loopback only)
- `GET /api/generation/catalog/search` / `GET /api/generation/catalog/model` (loopback only)
- `POST /api/generation/catalog/download` (loopback-only NDJSON, cancellable)
- `GET /api/generation/setup/plan` (loopback only)
- `POST /api/generation/setup/run` (loopback-only NDJSON; needs `confirm` plus the approved `fingerprint`)

Local model API (loopback only unless network access is
on; optional API key; see [LOCAL_API.md](LOCAL_API.md)):

- `GET /v1/models`, `GET /v1/models/{id}`
- `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/responses` (OpenAI)
- `POST /v1/messages`, `POST /v1/messages/count_tokens` (Anthropic)
- `POST /v1/models/unload` (ThreadShelf: free the loaded model's memory)
- `GET /api/generation/local-api` (settings UI, loopback only): model list and
  network listener status, without needing the API key

## Testing Layers

Unit/regression:

```bash
npm test
```

API/LanceDB/MCP integration:

```bash
npm run test:e2e
```

Browser workflows:

```bash
npm run test:playwright
```

The full `npm run check` gate also verifies dependency security, repository privacy
hygiene, documentation links, lint, TypeScript and the production client build.
Security checks require the advisory service and audit application all/production
dependencies, the renderer-build lockfile and bundled components, including asset
hashes. Functional checks can reuse the local embedding-model cache.

## Extension Points

Add a generation provider:

1. Implement `GenerationProvider` under `src/generation/providers/`.
2. Register it in `src/generation/registry.ts`.
3. Keep model discovery dynamic and declare whether requests are local/external.
4. Add provider contract tests and an API E2E stub; never call a live paid API in tests.

Add a provider:

1. Add format detection and parser logic in `src/parser.ts`.
2. Add a synthetic fixture under `test/fixtures/`.
3. Add parser tests.
4. Add an ingest or E2E case if the structure is unusual.

Improve search:

1. Add store-level behavior in `src/store.ts`.
2. Keep API response shape backward-compatible when possible.
3. Add tests for ranking, role filters, and cross-collection behavior.

Improve UI:

1. Update the React components and styles under `client/src/`.
2. Add or update Playwright tests.
3. Verify empty states, role filters, collection switching, and modal behavior.
