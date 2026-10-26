# Native import adapters and attribution

These modules are adapted from **ThreadShelf Local Reader** by **davoda1**
(MIT). The importer and bounded JSON framer preserve the source implementation's
native-format behavior, with the Enhanced changes documented below. This
attribution does not assert identical code in any particular public release.

- `importers.mjs`, `stream-json.mjs`: Local Reader, MIT;
  see `Local-Reader-LICENSE.txt`.
- `providers/threadshelf-parser.mjs`: ThreadShelf 1.2.3 parser, with TypeScript
  annotations removed by the Local Reader project; MIT;
  see `ThreadShelf-LICENSE.txt`. The server adapter restores the v1.3.0 public
  conversation-key conventions.
- `providers/common.mjs`, `meta.mjs`, `gemini.mjs`, `venice.mjs`: AI Export
  Converter GUI modules as bundled and refined by Local Reader; MIT;
  see `AI-Export-Converter-LICENSE.txt`.

Changes in Enhanced preserve per-message raw data and metadata, the original
source index across streamed/empty records, normalized ThreadShelf keys, and
node IDs when ChatGPT omits the redundant ID inside a mapping value. Known
non-conversation account metadata files are skipped. The TypeScript adapter
retains the server's existing identity/continuation contract and checks every
turn before storage. Native source fields stay inert data.

Converted HTML support follows the **ChatGPT Export Processor GUI**
`jsonData` contract. Importing
`conversations-index.json` or `chat-index.html` parses its existing conversation
records without executing the viewer's scripts or applying text conversions
again. Original input files are never rewritten.

## Behavior and limits

Supported inputs include ChatGPT mappings; Claude top-level/project exports;
AI Studio chunked/Imagen exports (including extensionless files); OpenRouter;
LM Studio selected versions; Grok; Meta labeled transcripts; Gemini Takeout
HTML/activity JSON; Venice console JSON/native unencrypted v4 backups;
compatible converter outputs; and normalized ThreadShelf/Local Reader turns.
ZIP members are never extracted. Selected conversation members are checked for
CRC, size and safe paths. Missing or encrypted required data produces a source
error. Multipart Venice backups are grouped only when their manifests identify
one unambiguous backup. Encrypted Venice backups and JSONL inputs are unsupported.

A ZIP containing both `conversations.json` and `chat.html` can create duplicates;
use one conversation representation. Browser folder uploads include supported
raster image companions, while unrelated files are skipped.

UTF-8 top-level/wrapped conversation arrays above 8 MiB are validated in a first
streaming pass and normalized one record at a time in a second pass. Limits
are explicit in `IMPORT_LIMITS`: 64 MiB per streamed record and 512 MiB as the
absolute whole-document ceiling,
16 MiB of streaming wrapper metadata before whole-document fallback (64 MiB
maximum retained metadata), 256 GiB
per streamed input/expanded archive set, 1 TiB ZIP input, 100,000 archive entries,
and 64 folder levels. Native Gemini HTML has a 64 MiB adapter limit; Venice
native backup databases retain a 2 GiB expanded limit. Browser uploads are
limited to 4 GiB per file and 1,000 files; local-folder imports can exceed the
upload limit. These are rejection ceilings, not memory requirements or a
promise that every machine can process files that large. Whole-document adapters
also check a conservative projected allocation against the current available RAM
and process budget before reading/decoding; they may reject smaller inputs with
an actionable request to use conversation-array JSON. Native Venice database
parts apply that check cumulatively. A normalized conversation has a separate
128 MiB serialized staging limit.

The source reader and normalization iterator feed disk-backed, length-prefixed
record spools. A whole folder is no longer retained as a normalized conversation
array. Each input finishes validation before its spool is eligible for publication;
`clearFirst` validates every selected conversation export before replacing the
collection. Durable jobs retain completed parse checkpoints, with SHA-256 checks
of both source input and staged records before reuse. Cancellation and memory
pressure are checked during reads, ZIP chunks, normalization and staging.

Unsupported JSON structures, unrelated HTML, README files, metadata and other
non-conversation members are reported as skipped without blocking supported files
in the same directory or ZIP. Recognized but malformed exports, invalid ZIP
integrity, unsupported recognized-format versions and changed input remain fatal
for that file. With `clearFirst`, any such failure preserves the collection. A
selection with no valid conversations never clears existing data. Ordinary
additive imports can still accept other fully validated files when one fails. Original files retain binary attachments and unknown global
metadata even when a format cannot associate those with a conversation.

Unsafe JSON integer IDs are kept as exact decimal strings in normalized JSON,
as in Local Reader; original numeric spelling remains in the source bytes.
Node 24 is required. Displayed ChatGPT branch/LM Studio version selection does
not remove other branches/versions from each conversation's stored raw record.

`../media.ts` resolves only explicitly referenced raster images under the
selected source directory or in its ZIP. It rejects traversal, external folder
symlinks, SVG/HTML, ambiguous names, bad signatures and corrupt ZIP media.
Images are capped at 5 MiB each and 32 MiB per resolver, including a separate
attachment-output budget. Data URLs are stored for working local attachments;
remote media is never fetched by the importer. Unavailable images remain
placeholders. URLs are displayed only through the renderer's explicit image
loading controls.

Enhanced 1.3.0 adds typed unsupported/invalid outcomes and cooperative memory
checkpoints to the attributed reader. The compatibility `importEnhancedFile` API
still collects a bounded document for legacy callers; production ingestion uses
`iterateEnhancedFile`. All original licenses and adapter provenance are retained.
