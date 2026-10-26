# Getting Started

This guide gets ThreadShelf running locally and indexes your first export folder. It assumes you want a private local search tool, not a hosted service.

The optional llama.cpp/OpenRouter conversation continuation is a separate,
opt-in layer. Search remains local; OpenRouter continuation is external
and is selected through the clearly marked **OpenRouter · external** provider.
See [GENERATION.md](GENERATION.md).

## 1. Install

Run the platform setup from the extracted source directory. It installs a
checksum-verified project-local Node 24.22.1 runtime, npm 12.2.1, locked
dependencies and the compiled application. It preserves an existing `.env`.

Linux:

```bash
bash setup-threadshelf.sh
```

Windows PowerShell:

```powershell
.\setup-threadshelf.ps1
```

With a compatible existing Node 24+/npm installation, use `npm ci` followed by
`npm run build`. See the [installation guide](../README.md#installation) for
supported architectures, runtime overrides and subsequent-start commands.

## 2. Start The App

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Use a custom port if needed:

```bash
npm start -- 3001
```

## 3. Create Or Select A Collection

A collection is a separate local search index. Think of it like a project folder inside the vector database.

Use one collection per archive or provider when testing:

- `ai_studio`
- `chatgpt`
- `claude`
- `openrouter`
- `work_archive`
- `personal_archive`

The special `All` option searches across indexed collections.

Recommended workflow:

1. Start with a throwaway collection.
2. Index a small sample.
3. Search and inspect a few threads.
4. Only then index a larger real archive.

This makes parser issues easier to debug and prevents accidental destructive operations on your main archive.

## 4. Index Exports

Use either path:

- Folder picker: best for normal use.
- Manual folder path: useful when browser folder access is awkward or when indexing very large local folders.

Supported inputs are JSON exports from:

- Google AI Studio (the Drive "Google AI Studio" folder; files may have no extension).
- OpenAI / ChatGPT.
- Anthropic / Claude.
- OpenRouter JSON created by this project's browser-console export script.
- LM Studio (`.lmstudio/conversations/*.conversation.json`).
- Grok / xAI (`prod-grok-backend.json` from an account export).

The app skips known account metadata, unrelated files and unsupported inputs,
reporting them in the job diagnostics. Supported conversations in a mixed folder
or ZIP can still import. Recognized but malformed exports are reported as errors.

Keep the tab open while files transfer. Once the server accepts the import job,
it continues independently of the tab or browser connection. The **Add data** page
retains job progress and provides explicit **Cancel import** and **Retry import**
actions. Cancellation stops at a safe boundary; publication that already finished
is not undone. For update imports, files completed earlier can remain indexed.
See [background jobs and recovery](IMPORT-JOBS.md).

## Folder Picker Versus Manual Path

Folder picker:

- Easier for normal browser use.
- Transfers supported exports and image companions to the server, then accepts a persistent job.
- Publishes originals for successfully imported source groups into `.uploads/`.
- Good when you do not want to paste local paths.

Manual path:

- The server snapshots selected input files from disk for a persistent job.
- Better for very large folders.
- Useful when browser folder upload is slow or awkward.
- Requires the path to be readable by the Node.js process.

## Clear First

`Clear collection first` replaces the selected collection after the complete
replacement is prepared. It does not delete the original export folder.
Published conversations remain readable during preparation; other writes to the
collection receive a busy response until replacement finishes.

Use it when you intend to replace the collection with the selected export set.
Unsupported or empty auxiliary files are skipped. Recognized corruption, failed
preparation, zero valid conversations or cancellation before publication leave
the previous collection intact. An ordinary update import can refresh matching
source files without replacing unrelated sources.

Deleting a collection removes its archive/index and copies uploaded through the
browser, cancels queued imports and refuses an active import conflict. Files in
the original folder are not deleted. Server-local indexing does not move or
rewrite original files. Keep a backup before intentional replacement or deletion.

## 5. Search

Search by meaning, not only exact text. Useful query types:

- A phrase you remember from a conversation.
- A topic summary.
- A code/API name.
- A multilingual term.

Use role filters to search only:

- User prompts.
- Thinking/reasoning fields when present.
- Assistant responses.

## Exact Search Versus Semantic Search

ThreadShelf is primarily semantic. That means a query can find related text even when wording differs. This is useful for old conversations where you remember the topic but not the exact phrase.

For rare IDs, exact filenames, package names, or short symbols, switch to
**Exact** mode for case-insensitive substring matching.

## Role Filters

Role filters answer different questions:

- User only: "What did I ask?"
- Assistant only: "What answer did I get?"
- Thinking only: "What reasoning traces exist in exports that include thinking?"

If search looks empty, check role filters first.

## 6. Open Threads

Search results are chunks. A chunk is only the part of a conversation that matched the query.

Click a result to open the routed thread reader. Current indexes load normalized
turns from the internal thread store, so a conversation remains readable after
its source export is moved, rewritten, or deleted. Older indexes may still fall
back to the original source path until they are re-indexed.

Use thread view to verify:

- Result context.
- Conversation order.
- Whether the match came from user prompt, thinking, or assistant response.
- Whether model metadata looks plausible.

## 7. Local Data Folders

Runtime data is local:

- `.lancedb/` - vector database.
- `.uploads/` - uploaded source files.
- `.collections.json` - remembered manual collections.
- `.threadshelf/generation.json` - non-secret generation settings.
- `.threadshelf/tools/` - managed `llama.cpp` builds.
- `.threadshelf/models/` - models downloaded from the catalog (`THREADSHELF_MODELS_PATH`).
- `.tmp-*` - test temp folders.
- `test-results/` - Playwright artifacts.

These should not be committed.

## 8. Useful Commands

```bash
npm test
npm run test:e2e
npm run test:playwright
npm run check
npm run parse -- path/to/export.json
npm run mcp
npm run setup:llama                  # local discovery only
npm run setup:llama -- -- --check    # release metadata only; no archive download
```

For a first run, **Settings → Conversation generation → Set up local generation**
installs a `llama.cpp` build and a fitting model from one confirmed plan; the
commands above remain the scripted and custom-build path. See
[Conversation generation](GENERATION.md).

If Playwright browsers are not installed:

```bash
npx playwright install chromium
```

## Troubleshooting

If first ingest is slow, the local embedding model may be downloading or loading.
Check the persistent job phase before starting another import. Only one index
operation uses a database at a time; queued jobs wait for the current one.

If search returns nothing, check:

- The selected collection.
- Collection stats: files and chunks should be above zero.
- Role filters: you may have filtered out the role that contains the match.
- Parser support: unsupported export shapes need a tiny anonymized fixture and a parser test.

If an upload or import fails, inspect the job's error and skipped-file details.
Check that the uploads/database directories are writable and have free space for
input snapshots and replacement staging. Memory pressure can pause or stop work
safely; close other memory-intensive programs before retrying. Individual record
and format limits still apply. A server-local path avoids transferring files
already present on the server. See [resource limits](IMPORT-JOBS.md#memory-and-disk).

If OpenRouter export looks incomplete:

- Reopen the OpenRouter chat.
- Scroll to load the full history.
- Run the browser-console export script again.
- Parse the downloaded JSON with `npm run parse -- file.json`.

If real provider exports fail:

- Do not commit the real file.
- Create a tiny anonymized fixture with the same JSON shape.
- Add a failing parser test.
- Fix the parser.
