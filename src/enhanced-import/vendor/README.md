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

A ZIP containing both `conversations.json` and `chat.html` imports both and can
create duplicate conversations. Use one conversation representation per import.
Browser folder uploads filter out image companion files; use a server-local
folder or a ZIP containing one conversation JSON representation and its image
companions to retain supported local assets.

UTF-8 top-level/wrapped conversation arrays above 8 MiB are validated in a first
streaming pass and normalized one record at a time in a second pass. Limits
are explicit in `IMPORT_LIMITS`: 512 MiB per record or whole-document adapter,
16 MiB of streaming wrapper metadata before whole-document fallback, 256 GiB
per streamed input/expanded archive set, 1 TiB ZIP input, 100,000 archive entries,
and 64 folder levels. Native Gemini HTML has a 64 MiB adapter limit; Venice
native backup databases retain a 2 GiB expanded limit. Browser uploads are
limited to 4 GiB per file and 1,000 files; local-folder imports can exceed the
upload limit. These are rejection ceilings, not memory requirements or a
promise that every machine can process files that large.

The source reader is bounded; normalized turns/raw conversations are staged
in memory before a file replacement. Whole-folder `clearFirst` also stages
all files/embeddings, preserving the upstream atomic replacement behavior.
Cancellation is checked during filesystem reads, ZIP chunks and record yields.
A damaged file/archive is never partially committed by Enhanced ingestion.
Unsupported metadata may be skipped; unsupported required conversation inputs
are reported. Original files retain binary attachments and unknown global
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
