# ThreadShelf Enhanced

[![CI](https://github.com/Davoda1/ThreadShelf-Enhanced/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Davoda1/ThreadShelf-Enhanced/actions/workflows/ci.yml)
[![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/Davoda1/ThreadShelf-Enhanced/releases)
[![MIT license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](#installation)
[![Source distribution](https://img.shields.io/badge/distribution-source_ZIP_%2F_TAR.GZ-6f42c1)](https://github.com/Davoda1/ThreadShelf-Enhanced/releases)

Import, search, read and continue AI conversations on your own machine. ThreadShelf Enhanced adds richer rendering, broader export support and responsive layouts to [ThreadShelf v1.3.0](https://github.com/ChrystianSchutz/ThreadShelf/tree/v1.3.0), while preserving its API routes, storage identities and light/dark interface.

[Installation](#installation) · [Configuration](#configuration) · [Import support](#import-support-and-known-limits) · [Compatibility](docs/ENHANCED_COMPATIBILITY.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## What Enhanced adds

- Rich Markdown, tables, highlighted code, mathematics, diagrams, citations and supported ChatGPT rich content, with bundled rendering libraries and readable fallbacks.
- Native and converted JSON, HTML and ZIP imports, with original conversation data and per-message metadata retained alongside normalized turns.
- Checked local image attachments and explicit controls for loading remote images.
- A bounded application layout, scrollable sidebar and responsive dialogs for small or short windows.
- Integrated Reader pagination for compatible [ThreadShelf Local Suite](https://github.com/Davoda1/ThreadShelf-Local-Suite) clients. No separate pagination patch is needed.
- Project-local Node/npm setup and a Linux launcher for repeated starts and folder indexing.

Search embeddings and storage run locally. First setup and model use require network downloads. OpenRouter generation is an optional external service: using it sends selected conversation content to OpenRouter and its provider. See [security and privacy](SECURITY.md).

## Installation

Download a source **ZIP** or **TAR.GZ** from [Releases](https://github.com/Davoda1/ThreadShelf-Enhanced/releases), or clone the repository's `master` branch. Extract into a writable directory and run setup there. Enhanced is distributed as source; it is not published to npm.

The setup scripts download official **Node 24.22.1 LTS**, verify its SHA-256 against the official checksum list, install **npm 12.2.1** into the project-local runtime, install locked dependencies and build the application. They do not change your global Node installation or shell profile. Administrator access is not required.

### Linux

Requires x64 or ARM64 Linux, Bash, curl or wget, tar and sha256sum.

```bash
bash setup-threadshelf.sh
./threadshelf-enhanced
```

Use `bash setup-threadshelf.sh --start` to set up and start in one command. For subsequent starts, run `./threadshelf-enhanced`; it uses the compiled server and the downloaded runtime. Ctrl+C stops the child process, prints `CTRL-C`, and returns success so following `;` or `&&` commands continue. Startup and runtime failures retain their nonzero exit status. No terminal multiplexer is required.

The launcher resolves its project directory from its own location, including when reached through a symlink. Set `THREADSHELF_ENHANCED_DIR` to choose another installation explicitly.

| Launcher command | Purpose |
| --- | --- |
| `./threadshelf-enhanced` | Start the server |
| `./threadshelf-enhanced --help` | Show usage (`-h` also works) |
| `./threadshelf-enhanced --version` | Show version information (`-V` also works) |
| `./threadshelf-enhanced --check-runtime` | Check the selected runtime |
| `./threadshelf-enhanced --index /path/to/exports archive` | Import a server-local folder into the `archive` collection |
| `./threadshelf-enhanced --index /path/to/exports archive --clear` | Replace that collection from the folder |

Use `--clear` only when you intend to replace the collection. An older Linux distribution may need a newer system libc to run official Node binaries; setup checks the runtime before replacing an existing installation.

### Windows

Requires x64 or ARM64 Windows and PowerShell.

```powershell
.\setup-threadshelf.ps1 -Start
```

For subsequent starts on x64:

```powershell
.\.local\node-v24.22.1-win-x64\node.exe dist\src\server.js
```

Substitute `arm64` for `x64` on ARM machines. If execution policy blocks a downloaded script, review it and use `Unblock-File .\setup-threadshelf.ps1`; organization-managed policy still applies. See [validation](docs/ENHANCED_VALIDATION.md) for platform verification scope.

### Setup options and an existing Node installation

| Purpose | Bash | PowerShell |
| --- | --- | --- |
| Install only the local Node/npm runtime | `--runtime-only` | `-RuntimeOnly` |
| Select Node | `--node-version 24.22.1` | `-NodeVersion 24.22.1` |
| Select npm | `--npm-version 12.2.1` | `-NpmVersion 12.2.1` |

Environment overrides are `THREADSHELF_NODE_VERSION` and `THREADSHELF_NPM_VERSION`. Node 24+ is required for lossless JSON numeric-token handling; npm 12 requires Node 24.15+ within the 24.x line. Setup rejects incompatible combinations. The root package explicitly allows the install scripts needed by its pinned dependencies. CPU embeddings are used by default; optional CUDA downloads are skipped unless `ONNXRUNTIME_NODE_INSTALL=cuda12` is set.

If a compatible Node/npm runtime is already installed:

```bash
npm ci
npm run build
npm start
```

## Configuration

Setup preserves an existing `.env` and copies `.env.example` when it is absent. The default UI address is [http://localhost:3000](http://localhost:3000).

| Setting | Purpose |
| --- | --- |
| `HOST` | Bind address; the supplied default is `127.0.0.1` for this computer only |
| `PORT` | HTTP port; default `3000` |
| `ALLOWED_HOSTS` | Comma-separated request hostnames/IP addresses, without schemes or ports |
| `THREADSHELF_DATA_DIR` | Override the common data directory |
| `LANCEDB_PATH`, `UPLOADS_DIR`, `COLLECTIONS_PATH` | Override individual storage locations |
| `OPENROUTER_API_KEY`, `HF_TOKEN`, `GITHUB_TOKEN` | Optional credentials for the corresponding integrations |

Host checks do not provide authentication. Remote access requires an appropriate network boundary or authenticated reverse proxy. Keep `.env`, uploaded exports, databases and model files out of source control. The [upstream manual](docs/UPSTREAM_README.md) explains inherited generation, MCP, search and configuration features; its npm publishing and installation instructions apply to upstream ThreadShelf.

## Import support and known limits

The adapters support ChatGPT, Claude, Google AI Studio, OpenRouter, selected LM Studio formats, Grok, Meta AI, Gemini/Takeout, Venice, normalized ThreadShelf conversations and supported converted exports. JSON and embedded HTML data are parsed without executing export scripts, and original input files are never rewritten.

- **Duplicate export representations:** a ZIP containing both `conversations.json` and `chat.html` imports both and can create duplicate conversations. Keep one conversation representation per import.
- **Images in browser folder uploads:** the browser's folder selection filters out image companions. To retain supported local images, use a server-local folder or a ZIP containing one conversation JSON representation and its image companions.
- **Venice:** native unencrypted version 4 backups are supported; encrypted backups are unsupported.
- **JSONL:** newline-delimited JSON is unsupported. Use a supported JSON document, HTML export or ZIP.
- **Resource limits:** large imports still require memory for normalized conversations. Images and archives have explicit size and safety limits. Unknown export layouts and rich widgets may remain readable source or placeholders.

See the [compatibility contract](docs/ENHANCED_COMPATIBILITY.md) and [import adapter notes](src/enhanced-import/vendor/README.md) for exact behavior and limits.

## Existing deployments and clients

Back up `.lancedb`, `.uploads`, `.collections.json`, `.threadshelf` and `.env`, or their configured external locations, before moving a deployment. Validate the new source in a separate directory against a backup first. Preserve the server URL and configured source paths when client bookmarks or thread identities depend on them.

Enhanced adds metadata columns while preserving existing normalized turns and identity keys. Compatible Local Suite clients keep their own archive formats; Enhanced does not migrate their databases. Do not install the older Reader pagination patch over Enhanced. The [compatibility matrix](docs/ENHANCED_COMPATIBILITY.md) distinguishes server API checks from desktop and archive behavior.

## Development, help and licensing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, focused tests and pull request guidance, and [validation](docs/ENHANCED_VALIDATION.md) for the current release gate. Report reproducible bugs with synthetic examples in [GitHub Issues](https://github.com/Davoda1/ThreadShelf-Enhanced/issues). For vulnerabilities, follow [SECURITY.md](SECURITY.md).

Enhanced **1.0.0** starts from upstream commit `3430dd04f50218fdea916b104709d24a651017fc` (v1.3.0). It is a distinct fork maintained by **davoda1**. Original copyright and MIT licensing are retained; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
