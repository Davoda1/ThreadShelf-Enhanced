# Live Markdown notes

Enhanced 1.4.0 connects existing Obsidian vaults, Logseq graphs, OpenClaw workspaces and ordinary Markdown folders from **Settings → Server → Markdown notes**. Files remain in their original folders and are read live. This feature does not import notes into LanceDB or change the archive format, embeddings or desktop-reader protocols.

Connect an absolute folder on the server computer, or choose a detected Obsidian/OpenClaw folder. Up to 32 folders may be connected. Each has a separate write permission, initially off. Select the folder to search; chat's **Notes tools** control selects one folder for that conversation request. Changing the default folder in another tab cannot redirect a pinned request into a different folder. Disconnecting a folder or disabling its writes prevents new operations against the old permission.

Search matches all words against Markdown paths and text. Results contain the note path, heading, matching line and a snippet. Search is lexical, live and separate from conversation semantic/hybrid search. It reports skipped unsafe/unreadable notes and explicitly warns if its bounded scan is incomplete. Use a smaller connected folder when a vault exceeds the scan limits. The UI can open a note in Obsidian on the computer running the browser; that application must be installed there and able to access the same path.

## Reading and editing

Read-only folders support search and reading. Enabling writes permits explicit creation and editing through the UI and connected MCP clients. Interactive chat always requires a browser preview and a separate approval for creating, editing or deleting files. A note's content and a model's claim of consent cannot approve a change. The browser capability expires after five minutes and is invalidated on disconnect or cancellation. The exact content/revision is captured before approval, and a changed note must be reread and reviewed.

Direct UI edits show a before/after change preview before **Save reviewed changes**. Existing frontmatter and links are preserved by retaining the entire original note in the editor; a proposed change can still modify them, so review the preview. Only regular UTF-8 `.md` files of at most 512 KiB are accessible. Hidden paths, traversal, Windows device names, symlinks, junctions, hard links and binary content are rejected. Parent directories must already exist. Creation installs a complete file atomically without overwriting an existing name. Edits use revision checks and atomic replacement.

Models only receive selected note content when notes tools are enabled. With an external or LAN provider, retrieved text goes to that selected provider. Private chat does not make approved vault writes temporary: notes are independent files. Archive-search tools remain a separate control.

## Recovery

Before editing, Enhanced retains the exact previous UTF-8 content in the vault's hidden `.threadshelf-history` directory. Each JSON entry contains the original relative `path`, SHA-256 `revision` and `content`. These backups are excluded from note search. They are retained until you remove them yourself. To recover one, stop competing writers, inspect the entry and restore its `content` into the recorded path using a text editor or a reviewed new edit. Do not copy JSON metadata into the note itself.

Deletion moves notes into `.trash/threadshelf-<id>/`, never permanently removes them. Its `manifest.json` maps each original relative path to the stored file and revision, including partially completed deletion batches. Inspect the mapping and move the desired files back without overwriting newer notes. Partial failures report which notes actually moved. Do not remove SQLite lock sidecars while any ThreadShelf writer is running.

## MCP and API

MCP offers `obsidian_search`, `obsidian_read`, `obsidian_create` and `obsidian_edit`. They use the active folder and its current write policy. MCP cannot delete notes because it has no browser approval surface. Large tool reads are explicitly truncated at 60,000 characters and omit the revision, preventing an accidental edit from an incomplete read.

Management routes live under `/api/obsidian`. They require loopback by default;
`ALLOW_LAN_AI=1` also permits trusted-LAN web access. Vault scope, write permissions
and browser approvals still apply:

| Route                         | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `GET /vaults`, `POST /active` | List connected folders and select the active identifier |
| `GET/PUT/PATCH /config`       | Read/connect a folder or change its write policy        |
| `GET /detected`               | Discover registered Obsidian/OpenClaw folders           |
| `GET /search?q=…`             | Live bounded lexical search                             |
| `GET /note?path=…`            | Read exact UTF-8 content and its revision               |
| `POST/PUT /note`              | Create or revision-check an explicit edit               |
| `POST /approvals/:id`         | Decide a pending browser-only capability                |

Search/read/write routes accept an optional `vaultId` query parameter to pin a connected folder without changing the active one. Configuration defaults to `.threadshelf/obsidian.json`, with `OBSIDIAN_CONFIG_PATH` as an explicit override. The registry is written atomically under a cross-process lock; legacy single-vault configuration is read without an automatic rewrite. Corrupt configuration is preserved and reported, never silently reset. Moving a connected folder requires reconnecting its new path; archive migration does not move your external vault files.

This implementation adapts MIT-licensed ThreadShelf v1.4.1 note code and adds multi-vault scoping, reviewed chat writes, recoverable edit history, exact trash mappings, strict UTF-8 validation and operating-system write coordination.
