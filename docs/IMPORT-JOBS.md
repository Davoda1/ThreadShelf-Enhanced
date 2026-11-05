# Imports, background jobs and resource limits

An upload has two stages. First the browser transfers files to the server. Keep
the tab open until the server confirms receipt. The accepted job then belongs
to the server: closing the browser, changing pages or losing the connection does
not cancel parsing/indexing. The Indexing page reads persistent job state and
offers explicit cancellation and retry.

Folder imports, the optional manual importer and watchers use the same job and
coordination layer. One index operation runs per database; additional jobs wait.
Only one HTTP server may use that database, even on a different port. These are
operating-system locks, not a check that merely looks for a process name.

## Selecting an import destination

Use **Target collection** on Add data to select the destination. The selector
reconciles changes to the collection list; a deleted collection or changed preview
cannot silently remain an accepted destination. Review a fresh preview after
changing the selected destination. The existing Chunks folder naming convention,
initial selection and clear-first choice are retained.

## Collection replacement

`--clear` reserves the destination collection for the active job. Other archive
mutations return a busy response; existing published conversations remain
readable. Clear does not immediately delete the old collection. Files are
validated and normalized into a private disk spool, rows and vectors are built
in bounded batches, and a small durable manifest publishes the matching archive
generation and vector table together.

Unsupported files, auxiliary metadata and empty exports are skipped with diagnostics.
A mixed folder or ZIP can still import supported conversations. An empty auxiliary
file does not veto a clear import containing other valid conversations; the valid
selection becomes the replacement. Recognized but malformed
exports, failed integrity checks, no valid conversations or cancellation before
publication preserve the previous collection. A completed publication cannot be
undone by closing the browser or pressing cancel afterward.

Interrupted jobs retain validated inputs/checkpoints. Recovery verifies input
hashes rather than trusting the saved percentage. Repeated interruption stops
automatic attempts and leaves a visible failure for explicit retry. Successful
jobs retain progress/history while disposable input/staging copies are cleaned.
Recovery of saved conversation edits continues to use durable pending-index
markers. Never remove SQLite sidecars or staging files while processes are active.

## Finished-job history

Completed, failed and cancelled jobs can be removed individually or cleared in
bulk for one collection or all collections. Bulk clearing covers the entire
matching finished history, including entries outside the current list's display
limit. Queued, running, paused and interrupted jobs are protected; cancel active
work through its explicit job action first.

Removing a history entry deletes that job's retained retry inputs/staging. It
does not delete imported conversations, their search index or published source
files. After removal, that job can no longer be retried; submit its source again
if another import is needed. Retrying and deleting the same job are coordinated
so removal cannot discard inputs claimed by a retry.

Successful completion records 100% progress. The interface also displays older
completed jobs at 100% when their last stored progress event stopped below it.
Failed or cancelled jobs retain their diagnostic state instead of appearing as
successful completion.

## Managing uploaded files

On **Add data**, select **Manage uploads** to open an in-page dialog. Choose a
collection to inspect its uploaded files by relative path and size, then select
files to delete or clear all uploaded files for that collection. Both actions
require confirmation. The dialog manages the server's configured upload storage
only; it does not delete files from other server-local import folders.

Upload cleanup does not remove the collection, indexed conversations, search
index or job history. It does remove original exports and uploaded media, so
attachments and legacy source-file fallbacks can become unavailable. Keep a
separate backup of originals you want to retain. This cleanup is independent of
finished-job history removal and the optional external-image cache.

Queued, running, paused and interrupted imports block cleanup for their
collection. A failed or cancelled folder import also blocks it when its input
snapshot is incomplete and its source folder overlaps those uploads. In that
case, retry the import or remove its finished history entry to abandon that
retry before deleting the files. Successful jobs and fully snapshotted finished
jobs do not block cleanup. Active CLI/watcher indexing and conflicting collection
mutations are also protected. Temporary upload-transfer directories and paths
outside the selected collection are excluded from management.

## Pending-index search safeguard

Search must exclude pending replacements and unreadable stored rows until their
index state is safe. That exclusion expression has a bounded 64 KiB-sized budget
(65,536 JavaScript string units), instead of growing with an unlimited backlog.
If it exceeds the budget, search reports that the collection has too many pending
or invalid index entries (`INDEX_RECOVERY_REQUIRED` internally). It does not return
partial results as a successful search, and it does not delete the archive.
Ordinary completed imports do not accumulate these exclusions.

For pending work, leave the server running and inspect its recovery diagnostic.
Recovery runs at startup and every 15 seconds, shares the indexer with imports,
and respects persisted retry backoff. Fix the reported resource or input problem
before retrying an import. Saved-edit recovery pauses after eight failures;
changing the affected thread resets that edit's retry state. There is no separate
HTTP recovery endpoint. Searches across all collections can also fail if one
included collection exceeds the guard; select a healthy collection meanwhile.

Unreadable rows marked `invalid` are retained for recovery and are not repaired
by automatic indexing. Reimport also preserves unreadable originals, so reimport
alone may not resolve a large invalid-row backlog. Keep a backup and diagnose the
damaged rows before a targeted repair; do not delete database files to bypass the
guard. The import-job Retry action and saved-edit index recovery are separate.

## Memory and disk

The 16 GB system target includes the OS and native memory: a 4 GiB JavaScript
heap limit alone is not a whole-system memory limit. The governor checks process
resident memory, heap headroom and available host/container memory. Clean
reclaimable file cache is accounted for separately from dirty, mapped and shared
pages. Under pressure batches shrink, processing waits for headroom, or the job
fails safely with its diagnostic after sustained pressure.

Defaults reserve approximately 15% of effective system memory (512 MiB–2 GiB)
and cap an import process's resident-memory budget at 45% of effective RAM,
up to 6 GiB. Optional environment settings are `THREADSHELF_MEMORY_RESERVE_MB`
and `THREADSHELF_PROCESS_MEMORY_MB`. `EMBED_BATCH_SIZE` remains the requested
maximum batch size. The manual importer defaults to a 4 GiB heap ceiling;
`THREADSHELF_MANUAL_HEAP_MB` overrides it. A ceiling does not reserve that much RAM.

Streaming removes the whole-folder memory requirement, but individual records
and formats that require whole-document parsing still have explicit safety limits.
Oversized inputs return actionable errors. Disk staging requires free space for
inputs, a replacement and retained published data. Insufficient space must leave
the previous published collection intact. A memory watcher cannot guarantee
survival if another program suddenly exhausts all system memory.

## Image loading and cache

Image clicks load within the conversation; automatic loading is optional.
Basic Markdown and full rich rendering both honor this setting. Unavailable,
click-to-load and failed images use the Reader's compact and wide placeholders.

The optional cache is server-only, disabled initially, and partitioned by
collection. Its default total limit is 512 MiB, configurable from 16–4096 MiB.
Older entries are evicted to stay within the limit. Disabling caching retains
existing bytes for later reuse but does not read or add cache entries while off.
Clear one collection or the complete cache independently of the archive.
Responses use `Cache-Control: no-store` so this feature does not create another
persistent application-managed browser cache.

External image requests omit credentials, cookies and referrers, validate public
HTTP(S) addresses and redirects, pin DNS resolution, enforce download limits and
reject active formats such as HTML/SVG. Explicit local/imported image assets do
not use the external image proxy. `THREADSHELF_IMAGE_CACHE_PATH` optionally changes
the cache directory. Loading an external image contacts its hosting service.

## Additive HTTP APIs

Existing ingestion, search, Reader pagination, thread and MCP contracts remain.
Existing progress endpoints observe durable jobs; disconnecting is no longer a
cancel command. New clients can use:

| Method/path                                            | Purpose                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `POST /api/import-jobs`                                | Enqueue `{folderPath,collection,clearFirst}`; returns `202 {job}`.                  |
| `POST /api/import-jobs/upload`                         | Accept multipart files with `collectionName` and `clearFirst`; returns `202 {job}`. |
| `GET /api/import-jobs?collection=...`                  | Read persisted recent jobs.                                                         |
| `GET /api/import-jobs/:id`                             | Read one job.                                                                       |
| `POST /api/import-jobs/:id/cancel`                     | Request safe cancellation.                                                          |
| `POST /api/import-jobs/:id/retry`                      | Retry retained inputs/checkpoints.                                                  |
| `DELETE /api/import-jobs/:id` | Remove one completed/failed/cancelled job; returns `200 {deleted:true,id}`, `404` when absent, or `409` for a protected job. |
| `DELETE /api/import-jobs?collection=...` | Remove all matching finished jobs; omit the filter for all collections. Returns `200 {deleted:number}`. |
| `GET /api/uploads` | List collections with uploaded files as `{collections:[{collection}]}`. |
| `GET /api/uploads/:collection?cursor=...&limit=100` | List relative file paths, byte sizes and modification timestamps with `nextCursor` and `locked` state. |
| `DELETE /api/uploads/:collection` | Delete selected `{paths:[relativePaths]}` or `{all:true}` uploaded files; returns `{deleted,bytes}`. |
| `GET /api/memory`                                      | Read current memory pressure and budgets.                                           |
| `GET /api/image-cache`                                 | Read settings, total usage and per-collection usage.                                |
| `PUT /api/image-cache`                                 | Set `{enabled,maxBytes}`.                                                           |
| `DELETE /api/image-cache?collection=...`               | Clear a collection cache; omit the parameter to clear all.                          |
| `GET /api/image-cache/resource?url=...&collection=...` | Load a validated image; only named collections can persist it.                      |

The thread response additionally reports its resolved collection when available.
Other clients may ignore that field. Conversation identities, raw content, role
keys, embedding model and vector dimensions are retained. All server/MCP/CLI
processes sharing a writable database must be upgraded together to 1.3.0.
