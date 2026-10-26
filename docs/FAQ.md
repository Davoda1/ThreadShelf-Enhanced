# FAQ

## Is my data sent to a cloud service?

No for the core search flow. Exports are parsed locally, embeddings are generated locally, and vectors are stored locally in LanceDB.

The first embedding model load may download model files through the Transformers/Xenova stack if they are not already cached. After that, search/indexing uses the local model cache.

The optional OpenRouter generation provider is the explicit exception: selecting
**OpenRouter · external** sends the selected user/assistant context and new prompt
off-device. Local `llama.cpp` generation remains on loopback. Loading an external
image also contacts its hosting service through the server image proxy; click-to-load
is the default, and automatic loading is optional.

## What problem is this trying to solve?

The practical problem is archive recovery. AI tools can accumulate hundreds or thousands of useful conversations, article drafts, research notes, and backup snippets, but provider search/export workflows are often limited or missing. ThreadShelf focuses on making services like Google AI Studio and OpenRouter easier to back up, normalize, index, and use later from one local place.

## What files should never be committed?

Do not commit:

- Real chat exports.
- `.lancedb/`
- `.uploads/`
- `.collections.json`
- `.threadshelf/`, local configuration and resource caches.
- Logs.
- Temp folders.
- Screenshots with private chats.

See [Security And Privacy](../SECURITY.md).

## What is a collection?

A collection is a logical namespace for archived conversations and their search
index. Its physical storage can span published generations; applications should
use the collection API instead of selecting internal tables directly.

Use collections to separate:

- Providers.
- Projects.
- Time periods.
- Test data versus real data.

## Should I use `All`?

Use `All` when you do not know where something is. Use a specific collection when:

- You want faster, narrower search.
- You are testing a provider parser.
- You want to avoid exposing unrelated results to an MCP client.

## Why are there chunks instead of full conversations in search results?

Embeddings work better on focused pieces of text than on very long full conversations. ThreadShelf stores chunks for search, then reconstructs the full source thread when you open a result.

## How do I find an exact ID, filename, or error string?

Switch the search mode from **Semantic** to **Exact**. Exact mode performs a
case-insensitive substring search and is intended for identifiers, filenames,
package names, code fragments, and error messages.

## Why is first indexing slow?

The local embedding model may need to download and initialize. Large exports also require parsing, chunking, embedding, and LanceDB writes.

## Can I index multiple providers in one folder?

Yes. The parser detects supported formats per file. For real testing, separate collections are easier to debug, but mixed-provider folders are supported.

## Can I close the browser during an import?

Yes, after file transfer finishes and the server confirms the job was accepted.
Parsing and indexing then continue on the server. Return to **Add data** to see its
persisted progress, cancel it or retry a failed job. Closing a tab is not a cancel
command. See [background jobs](IMPORT-JOBS.md).

## Can I remove uploaded files after importing them?

Open **Add data → Manage uploads**, choose a collection and confirm deletion of
selected files or all its uploaded files. The dialog shows relative paths and
sizes. It manages uploaded originals and media, not other server-local import
folders, job history or the separate image cache.

Indexed conversations and their search index remain, but attachments and older
source-file fallbacks may need the originals and can stop working after deletion.
Keep a backup of files you need. Cleanup is blocked while imports or indexing
still depend on those files. See [managing uploaded files](IMPORT-JOBS.md#managing-uploaded-files).

## What does turning rich rendering off do?

Each role has an independent switch in Settings: user prompts, thinking and
responses. Off retains basic Markdown, including emphasis, underline, tables,
lists, links and code. Advanced math, diagrams and widgets remain readable as
source. The existing visibility controls still decide which roles are shown.

## Is the image cache part of my conversation archive?

No. It is an optional server-only cache with separate storage and per-collection
partitions. You can inspect its size or clear one collection/all cached images
without removing conversations. Disabling it stops cache use while retaining
existing cached bytes for later reuse. Remote images still load inline through
the checked proxy when caching is off. See [image loading and cache](IMPORT-JOBS.md#image-loading-and-cache).

## What does the OpenRouter script do?

It runs in the browser DevTools Console on OpenRouter. The bulk script walks
sidebar chats, scrolls each thread to load its history, extracts user/assistant
text, and downloads one JSON file per chat. The single-chat script exports the
currently open conversation.

See [OpenRouter Export](OPENROUTER.md).

## Does MCP create another database?

No. MCP reads the same local LanceDB collections used by the web UI.

## Can I host ThreadShelf for multiple users?

That is not the supported deployment model. ThreadShelf is a single-user local
application with no account system or API authentication. Keep the default
`127.0.0.1` binding. LAN exposure is intended only for a trusted network and
requires deliberate `HOST`/`ALLOWED_HOSTS` configuration.
