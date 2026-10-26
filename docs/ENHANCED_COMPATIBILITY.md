# Compatibility contract

ThreadShelf Enhanced 1.3.0 retains the existing server routes, public conversation
identities and integrated Reader pagination. Import processing now uses persistent
jobs and atomic archive/index publication. The current public client reference is
[ThreadShelf Local Suite v1.2.0](https://github.com/Davoda1/ThreadShelf-Local-Suite/tree/v1.2.0),
commit `c1030b0f014332a9b746ed4e2d93cd672bcb2a09` (Reader and Alternative 1.2.0,
Analytics 1.0.0). The retained HTTP adapter fixtures originated in Suite v1.0.0;
their exact bytes have been verified unchanged in this v1.2.0 reference.

| Reference | Scope |
| --- | --- |
| ThreadShelf v1.3.0 | Existing REST routes, MCP, stored turns, path/environment names and continuation behavior |
| Local Suite v1.2.0 Reader and Alternative | Collections, files, threads, Insights, bounded legacy search and Reader v1 cursor API through released HTTP adapters |
| Local Suite v1.2.0 / Analytics 1.0.0 | Consumes archives published by Local Reader; Enhanced does not generate or migrate the Analytics archive format |
| Supported converted exports | Conversation JSON, `conversations-index.json` and embedded `chat-index.html` data |

Exact public adapter provenance and blob hashes are documented in
[test/fixtures/compatibility-clients/README.md](../test/fixtures/compatibility-clients/README.md).
Those hashes identify only the named adapter files; they do not imply that other
application code is identical. Bundled adapter tests do not launch Electron or
validate desktop installers. See [validation](ENHANCED_VALIDATION.md) for the
current public-source gate.

The embedding model and 384-dimensional vectors are unchanged. Existing archives
remain readable without a mandatory reimport, and compatible clients retain their
own database formats. Storage publication metadata and generation-tagged archive
rows are new in 1.3.0, so this is not a promise of backward storage compatibility
with older server executables. Earlier Enhanced releases remain available.

## Upgrading an existing store

Stop every HTTP server, MCP process, importer and watcher using the store before
upgrading. Back up the complete database directory, uploads, collection registry,
settings and environment configuration, including any configured external paths.
Copy the entire stopped database when moving it: publication/job SQLite files,
staging records and sidecars belong with the LanceDB tables, not just the visible
collection table directories. Do not remove these files while processes are active.

Upgrade every process sharing a writable store to 1.3.0 together. Older writers
do not implement its generation/publication and job-reservation protocol. Never
open a store modified by 1.3.0 with an older server as a downgrade procedure;
rollback uses the stopped backup. Preserve the server URL, source paths and
external resources required by existing bookmarks and legacy source fallbacks.

After startup, verify collections, stored threads, keyword/semantic search,
attachments and client connections before retiring the backup. A newly prepared
publication may reclaim older physical generations later; copying an individual
old table is not a consistent database backup.

## Shared-store writes

Conversation and vector data remain in LanceDB. SQLite provides OS-backed lock
coordination, durable import-job/publication metadata and temporary disk staging;
the collection registry retains its JSON format. One HTTP server and one active
index operation are allowed per database. Separate HTTP, MCP and CLI processes
must share the same correctly resolved storage paths.

An active clear import reserves its collection against other archive mutations,
which receive a busy response, while the published collection remains readable.
An interrupted clear job retains a durable reservation until recovery or explicit
cancellation. Collection deletion/clearing coordinates with queued jobs and
rejects running or interrupted imports, preventing later recreation by accepted
work. Unrelated collections can still be read and edited.

Low-level storage locks wait asynchronously and fail explicitly after bounded
contention; they never proceed without ownership. Malformed/unreadable registry
JSON is preserved and reported rather than treated as empty. Transient Windows
registry-replacement failures are retried before returning a persistent error.
The locking contract assumes a local filesystem with working operating-system
file locks; network-mounted database storage is not a tested deployment mode.

## Import endpoint behavior

The existing ingest endpoints remain available, including their NDJSON progress
streams. They observe a persistent job. **After server acceptance, disconnecting
the request no longer cancels indexing.** Complete the upload transfer first;
then use the job's explicit Cancel action if processing should stop. Clients
that previously cancelled by aborting their progress request must use the new
job-cancellation endpoint. Cancellation after publication is not an undo action.

The additive `/api/import-jobs` API exposes acceptance, persisted progress,
cancellation, retry and finished-history removal. `/api/uploads` manages stored
uploaded originals independently of indexed conversations; removing those
originals can affect file-based media and legacy source fallbacks. See
[IMPORT-JOBS.md](IMPORT-JOBS.md). The thread response
may include its resolved `collection`; older clients can ignore the added field.
Existing search, files, Reader pagination, generation and MCP contracts remain.

## Stable identity

Existing JSON imports retain upstream ThreadShelf v1.3.0 conversation-key rules. Local clients identify
a thread by server URL, collection, `sourceFile` and `conversationKey`: keep the
same URL and paths when moving an installation. ZIP imports use the physical ZIP
as `sourceFile`; its member path prefixes conversation keys to avoid collisions
between files with positional IDs. Source-member identity remains attached to each
stored conversation.

`/api/files` still returns its legacy array. `/api/search` stays bounded at 50.
`/api/reader/capabilities` advertises Reader search version 1, maximum page 50,
keyword/semantic modes, cursor/provider filters, exact totals and a 900-second
snapshot TTL. `/api/reader/search` serves stable cached snapshots; expired cursors
return 410 and changed query parameters return 400. Do not install an external
pagination patch over this fork.

## Preservation

Source imports are read-only. Normalized turns retain message metadata and
source-role/channel identifiers. Conversation raw data is stored separately once
per thread, with source identity and per-conversation provider. Unselected
branches and otherwise undisplayed messages remain available in that raw data.
JavaScript-unsafe integer tokens become exact decimal strings, matching the
Reader's JSON-safe policy; originals retain their original numeric JSON type.
This is semantic preservation, not a byte-for-byte re-export of the input file.

ThreadShelf JSON export includes the original conversation data, source identity
and enriched normalized turns. Markdown export remains a readable textual export.
Local Analytics' source archive format is generated by Local Reader; Enhanced
does not replace that publication format.

Future vendor formats may require an adapter update. Unsupported rich widgets
remain readable source or placeholders. Per-role rich-rendering preferences affect
presentation only: basic mode retains Markdown formatting, visibility controls
remain separate, and copy/export use the underlying source.

## Import behavior and resource limits

Source records are read incrementally where their format permits, then normalized
into bounded disk spools. Old/new joins, retries and embedding preparation use
disk staging and bounded batches. The complete folder is no longer retained in
memory or serialized into one giant fingerprint string. The memory governor
accounts for V8 heap, native/process RSS and effective host/container headroom.
It can reduce batches, pause or fail safely; it cannot guarantee survival if
another process exhausts the system's memory.

Unsupported/unrelated files, account metadata and empty exports are reported as
skipped. They do not block supported conversations in a mixed folder or ZIP.
Recognized malformed exports, integrity failures, no valid conversations or
pre-publication cancellation preserve the prior collection during a clear import.
An empty auxiliary file does not veto a clear selection with other valid records;
that valid selection becomes the replacement. Additive imports can retain
successfully completed sources while reporting failures for other sources.

The principal declared safety limits are:

| Input or resource | Limit |
| --- | --- |
| Browser upload transport | 4 GiB per file and 1,000 files per request |
| One streamed JSON record | 64 MiB |
| One normalized staging record | 128 MiB |
| Formats requiring whole-document processing | 512 MiB, also subject to available heap/headroom checks |
| Streamed conversation data | 256 GiB and 2,000,000 records |
| ZIP input and expansion | 1 TiB compressed, 256 GiB expanded and 100,000 entries |
| Imported local images | 5 MiB per image, 32 MiB total per source |
| Downloaded external image | 16 MiB and a 20-second download deadline |

These are rejection ceilings, not promises that every input below them can be
processed on a particular machine. Staging needs free disk space for accepted
inputs, a replacement and retained published data. Limits are defined in
`src/enhanced-import/vendor/importers.mjs`, `src/enhanced-import/spool.ts`,
`src/enhanced-import/media.ts`, `src/routes/ingest.ts` and `src/image-cache.ts`.

Pending/invalid index exclusions are also bounded. An extreme backlog returns
`INDEX_RECOVERY_REQUIRED` instead of growing an unbounded search expression or
returning incomplete results as success. Retained corrupt rows are not repaired
by automatic retry; see [recovery guidance](IMPORT-JOBS.md#pending-index-search-safeguard).

## Image behavior

Referenced local images are resolved within the selected export or ZIP without
extracting arbitrary paths. Checked PNG/JPEG/GIF/WebP data is retained within the
limits above. Browser folder selection now includes supported image companions;
server-local folders and ZIPs remain supported. Missing attachments keep their
placeholders, and arbitrary filesystem paths are never exposed as web resources.

Remote images load inline on click by default; automatic loading is optional.
The server fetches supported raster images from validated public HTTP(S) hosts,
including AVIF, with DNS pinning and redirect checks. Browser credentials, cookies
and referrers are not forwarded; active HTML/SVG payloads and private-network
addresses are rejected. Loading contacts the image host from the server.

Optional caching is server-only, disabled by default and partitioned by collection.
Its shared total limit defaults to 512 MiB and can be set from 16 to 4096 MiB.
Collection/all-cache clearing does not change conversation or search data, nor
other clients' local caches. The default source-install location is
`.threadshelf/image-cache`; `THREADSHELF_IMAGE_CACHE_PATH` overrides it. Proxy
responses use `Cache-Control: no-store`. This cache is independent of archive
attachments, embedding-model caches and Local Reader's own resource cache.

## Known limitations

- A ZIP containing both `conversations.json` and `chat.html` imports both
  representations and can create duplicate conversations. Use one conversation
  representation per import.
- Venice native version 4 backups must be unencrypted. Encrypted Venice backups
  are unsupported.
- JSONL is unsupported; the importer expects a supported JSON document, HTML
  export or ZIP.
- Unknown binary attachments, export-global metadata and unsupported layouts may
  not have a normalized representation. Keep the original export as the complete
  source archive.
