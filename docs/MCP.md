# MCP Setup

ThreadShelf includes a stdio MCP server so local AI tools can query indexed conversations.

MCP is useful when you want Cursor, Claude Desktop, or another MCP-aware client to search your local AI chat archive without manually opening the web UI.

## Server metadata

- Transport: stdio
- Authentication: none
- Language: TypeScript
- License: MIT
- Runtime: Node.js 24+; the setup pins project-local Node.js 26.13.0 LTS
- Install: clone the repository and run `npm ci`
- Start: `npm run mcp`
- Data location: local LanceDB / ThreadShelf archive
- Network service required for archive search: no
- MCP tools: 9

The tools are:

- `list_collections`
- `list_files`
- `get_stats`
- `search`
- `read_thread`
- `obsidian_search`
- `obsidian_read`
- `obsidian_create`
- `obsidian_edit`

## Markdown note tools

Connect folders under **Settings → Server → Markdown notes**. MCP uses the active
folder and rechecks its current per-folder write policy. Notes remain live files;
no separate conversation database records or embeddings are created.

| Tool              | Arguments                        | Behavior                                                                      |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `obsidian_search` | `query`, optional `limit` (1–30) | Live lexical matches with relative paths, headings, line numbers and snippets |
| `obsidian_read`   | `path`                           | Read a relative `.md` file and its SHA-256 revision                           |
| `obsidian_create` | `path`, `content`                | Create a new note without overwriting; requires writes enabled                |
| `obsidian_edit`   | `path`, `content`, `revision`    | Replace exactly the revision previously read; retains recovery history        |

There is no MCP delete tool: deletion requires the interactive web chat's browser
approval. MCP create/edit follow the explicit persistent write permission, rather
than a browser prompt. Keep that permission off if connected tools should only
read notes. Hidden paths, links, traversal and unsafe files are rejected. Model
reads above 60,000 characters are marked truncated and carry no editable revision.
See [Live Markdown notes](NOTES.md) for scan limits and recovery.

## What MCP Uses

The MCP server does not create a separate index. It reads the same local data as the web app:

- LanceDB path from `LANCEDB_PATH`, default `.lancedb`.
- Uploaded/source files from paths stored during ingest.
- The same collections created by the UI/API.

Index data first with the web UI or API. Then connect an MCP client.

The stdio server defaults to MCP protocol `2024-11-05` for broad Claude Desktop
compatibility, and negotiates `2025-03-26` or `2025-06-18` when a client requests
one of those versions during `initialize`.

## Install and start

From the unpacked Enhanced source root, run `bash setup-threadshelf.sh` on Linux
or `setup-threadshelf.ps1` on Windows to install local dependencies and build.
Use the Enhanced repository or release source for this guide.
For Linux x64, the built stdio entry point can be started without global Node/npm:

```bash
.local/node-v26.13.0-linux-x64/bin/node dist/mcp/server.js
```

If ThreadShelf is already installed, start the server from the repository root:

```bash
npm run mcp
```

The server communicates over stdio. It is not an HTTP server and should not be opened in a browser.

## Tested MCP clients

The automated compatibility test starts the real ThreadShelf process over stdio,
initializes an MCP session, confirms that `tools/list` returns all nine tools, and
calls `list_collections` and `get_stats` against an isolated LanceDB directory.

Claude Desktop and Cursor are documented configuration targets. Claude Desktop,
Cursor, Codex, and VS Code MCP are protocol-compatible, but are not currently
included in the project's manual compatibility test matrix. This documentation
does not mark a client as tested based only on protocol compatibility.

## Client Command

Most MCP clients need:

```bash
npm run mcp --silent
```

The `--silent` flag keeps npm's lifecycle banner off the MCP stdout channel. Set
the working directory to the repository root.

If your database lives somewhere else, pass environment variables in the MCP client config:

```json
{
  "LANCEDB_PATH": "D:\\threadshelf\\.lancedb",
  "UPLOADS_DIR": "D:\\threadshelf\\.uploads"
}
```

Use your real local paths.

## Example MCP Config Shape

Different clients use slightly different config files, but the shape usually looks like this:

```json
{
  "mcpServers": {
    "threadshelf": {
      "command": "npm",
      "args": ["run", "mcp", "--silent"],
      "cwd": "C:\\Users\\you\\path\\to\\threadshelf",
      "env": {
        "LANCEDB_PATH": "C:\\Users\\you\\path\\to\\threadshelf\\.lancedb"
      }
    }
  }
}
```

For the project-local installation, prefer the absolute path to its local
Node executable as `command`, with the absolute built `dist/mcp/server.js` path
as its sole argument. On Windows the executable is
`.local/node-v26.13.0-win-x64/node.exe`; on Linux x64 it is
`.local/node-v26.13.0-linux-x64/bin/node`. This also works for clients without
`cwd` and avoids relying on a global Node version. The built entry point is
created by the setup script.

## Tools

Current tools:

`list_collections`

- Lists local LanceDB collections.
- Use first to understand what can be searched.

`list_files`

- Arguments: `collection`.
- Lists indexed source files in one collection or across `all`.
- `collection` defaults to `all`.
- Useful before asking for a full thread.

`get_stats`

- Optional argument: `collection`.
- Returns the same stats as `/api/collections/all/stats` or
  `/api/collections/:name/stats`.
- `collection` defaults to `all`.
- Useful before broad searches so agents can see whether anything is indexed.

`search`

- Required argument: `query`.
- Optional arguments: `collection`, `n`, `roles`, `mode`, `keywordBoost`, `model`, `from`, `to`.
- Returns ranked snippets with source metadata.
- `collection` defaults to `all`; pass a collection name to narrow the search.
- `roles` can include `user`, `thinking`, and `ai`.
- `mode` is `semantic` (default, embedding similarity) or `keyword` (exact
  case-insensitive substring match — use for identifiers, error strings, code).
- `model` performs a case-insensitive substring filter.
- `from` and `to` accept ISO timestamps or `YYYY-MM-DD` date bounds.

Example arguments:

```json
{
  "query": "where did I discuss OpenRouter export automation?",
  "collection": "all",
  "n": 10,
  "roles": ["user", "ai"],
  "keywordBoost": true,
  "from": "2026-01-01"
}
```

`read_thread`

- Arguments: `sourceFile`, optional `collection` and `conversationKey`.
- Loads and parses the full source conversation.
- `collection` defaults to `all`.
- Pass the `conversationKey` returned by `search` when one export file contains
  multiple conversations.
- Use after `search` returns a promising source file.

## Resources

The server also declares resource templates:

- `threadshelf://collections`
- `threadshelf://collections/{collection}/files`
- `threadshelf://thread?path={absolutePath}`

Tools are usually easier for agents. Resources are useful for clients that expose MCP resources directly.

## Recommended Agent Workflow

Ask the MCP client to:

1. Call `list_collections`.
2. Call `get_stats` to check indexed volume.
3. Call `search` with `collection: "all"` or a specific collection.
4. Inspect returned snippets and metadata.
5. Call `read_thread` only for the most relevant result.
6. Use the full thread as context.

This avoids dumping huge conversations into context unnecessarily.

## Manual Verification

After configuring an MCP client:

- List collections.
- Search a known query in a real test collection.
- Retrieve one thread.
- Confirm the response contains source file, collection, role, turn index, and useful snippet text.

You can also run:

```bash
npm run test:e2e
```

The E2E suite includes a stdio MCP smoke test.

## Safety

MCP exposes your local indexed chat archive to the connected client. Only connect clients you trust.

Practical safety rules:

- Do not index archives you do not want the MCP client to access.
- Prefer separate collections for sensitive projects.
- Use `collection`-scoped searches when possible.
- Do not expose the local app or MCP process to untrusted users.
