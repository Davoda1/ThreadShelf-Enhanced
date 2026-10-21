# Enhanced 1.0.0 validation

Validation uses synthetic conversations and isolated stores. No live archive or
credentials are needed for the public-source checks.

**Public-source validation: 2026-10-21, Enhanced 1.0.0.** The Linux gate below
was run on the public release candidate using Node 24.22.1 and npm 12.2.1.
The `v1.0.0` tag identifies the shipped source. GitHub release CI repeats the
gate on a fresh Linux installation and runs native Windows setup/core checks
before publishing the two archives.

## Reproducible checks

| Check | Command or scope | Public release result |
| --- | --- | --- |
| Repository hygiene | `npm run check:repo` | Passed; public files and inherited history also audited |
| Lint and server TypeScript | `npm run lint`; `npx tsc --noEmit` | Passed |
| Unit and regression tests | `npm test` | 577 passed; 1 Windows-only test skipped on Linux |
| HTTP API and MCP integration | `npm run test:e2e` | 27 passed |
| Client TypeScript and production build | `npm run build:client` | Passed |
| Chromium browser regressions | `npm run test:playwright` | 86 passed |
| Compiled server | `npm run build:server` | Passed |
| Setup and launcher | Runtime-only setup, runtime check, health/UI/Reader API smoke | Passed on Linux x64 |
| Source archives | Committed-tree-only ZIP/TAR.GZ packaging | Exclusion and reproducibility checks passed; final assets carry SHA-256 checksums |

`npm run check` runs repository hygiene, lint, server TypeScript, unit tests,
HTTP/MCP integration, the client build and browser regressions in that order.
Browser tests require the Playwright Chromium installation. Embedding tests may
download the model on their first run. Integration stores must remain isolated
from user data.

## Coverage included in the public tree

- Released Reader and Alternative HTTP adapter fixtures with recorded public blob
  hashes, API browsing, stored threads, Insights, keyword/semantic search and
  Reader pagination.
- Cursor snapshots, totals, filtering, parameter mismatch and expiration.
- Rich rendering, math, diagrams, citations, readable fallbacks, local image
  binding, explicit remote image loading and constrained viewport layouts.
- Native and converted imports, embedded HTML JSON, ZIP validation, cancellation,
  unsafe integer preservation, media bounds, traversal rejection, unencrypted
  Venice backup grouping, legacy identities and recovery behavior.
- Portable setup and source-distribution checks that can run from public files.

The public checks do not require separately supplied application source trees.
Launcher checks also verified actual terminal Ctrl+C handling: cleanup completes,
the exact `CTRL-C` block prints, and subsequent `;` and `&&` commands run.
Unexpected exits still fail. Source packaging excludes untracked and dirty
working-tree content and rejects private paths, nested dependencies and symlinks.

## Platform and format scope

Setup pins Node 24.22.1 and npm 12.2.1. Linux x64 is the primary verification
platform. Windows PowerShell setup and ARM64 runtime selection are included;
native Windows is a separate required GitHub CI job. Native ARM64 was not
executed in this local gate. Full dependency installation is repeated by both
platform setup jobs; the local public gate reused the locked dependency install.
Desktop Electron windows and installers are outside this gate. Local Analytics
consumes Reader-published archives; the server API adapter checks do not validate
that separate archive pipeline.

Known import limits include duplicate conversations when a ZIP contains both
`conversations.json` and `chat.html`, image companions excluded by browser folder
uploads, unsupported JSONL, and unsupported encrypted Venice backups. See the
[compatibility contract](ENHANCED_COMPATIBILITY.md) for workarounds and details.

No claim is made that every undocumented widget or future export is supported.
Unsupported content remains source or a placeholder. Rendering libraries are
bundled; first setup and model use require network downloads.
