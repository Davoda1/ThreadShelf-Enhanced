# Enhanced 1.1.0 validation

Validation uses synthetic conversations and isolated stores. No live archive or
credentials are needed for the public-source checks.

**Local release candidate validation: 2026-10-21, Enhanced 1.1.0.** The complete
local gate passed after a fresh locked dependency installation. The original
`v1.0.0` tag and assets remain unchanged; `v1.1.0` identifies this separate release.
Hosted Linux and Windows checks are required before either release asset can be
published. Their results are recorded in the repository's
[Actions history](https://github.com/Davoda1/ThreadShelf-Enhanced/actions).

## Reproducible checks

| Check | Command or scope | Local 1.1.0 result |
| --- | --- | --- |
| Dependency security | Application lockfile, all and production; renderer-build lockfile; 83 bundled package versions and both asset hashes | Passed; zero advisory findings in all four scopes |
| Repository hygiene | `npm run check:repo`; public source privacy review and retained license verification | Passed |
| Lint and server TypeScript | `npm run lint`; `npx tsc --noEmit` | Passed |
| Unit and regression tests | `npm test` | 598 passed; one native-Windows-only case skipped on Linux |
| HTTP API and MCP integration | `npm run test:e2e` | 30 passed |
| Client TypeScript and production build | `npm run build:client` | Passed |
| Chromium browser regressions | `npm run test:playwright` | 88 passed |
| Compiled server | `npm run build:server`; isolated health and collection API smoke | Passed |
| Launcher | Actual terminal Ctrl+C, project-root and environment-override launches, `;` and `&&` continuation | Passed; exact marker, status zero, children reaped |
| Source packaging regressions | `python3 test/source-release.test.py` | 12 passed; committed archives are audited again by Linux and Windows CI |
| Renderer reproduction | Clean locked source rebuild and component inventory verification | Byte-identical Mermaid; 79 Mermaid package versions verified |
| Existing archive compatibility | Synthetic 1.0.0-to-1.1.0 LanceDB handoff with real embeddings | Stored rows, identities, source bytes, vectors and search ordering unchanged |

The synthetic upgrade rehearsal retained six rows across three threads and
compared three 384-dimensional query vectors with a maximum component difference
of zero. The model and database format are unchanged; this update does not require
reimporting archives or rebuilding the index. The renderer regressions exercise
15 diagram families offline and the patched KaTeX mathematical-label path.

`npm run check` includes dependency security, repository hygiene, lint, server
TypeScript, unit tests, HTTP/MCP integration, the client build and browser
regressions. Security checking requires access to the current public advisory
service and fails when a reliable audit response is unavailable. A clean result
is limited to the advisory data available at the time of that run.

Browser tests require the Playwright Chromium installation. Embedding tests may
download the model on their first run; the functional tests can use a previously
prepared model cache. Integration stores must remain isolated from user data.
Native Windows setup/core checks and source packaging are required GitHub jobs;
release publication waits for all required jobs to succeed on the version tag.

### Historical 1.0.0 baseline

The previous public-source functional gate passed 586 unit tests (one
Windows-only test skipped on Linux), 27 HTTP API/MCP tests, 86 Chromium tests,
and 12 source-packaging regressions. Subsequent dependency auditing found
advisories in inherited lockfile packages and in the separately inventoried
browser bundle. Those functional results did not constitute a clean dependency
security audit. The 1.1.0 gate adds that missing coverage and revalidates behavior
against the updated dependencies.

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
- Ordinary invalid-upload rejection, canceled-upload cleanup, subsequent successful
  uploads and continued server health in bounded, isolated test processes.
- Dependency compatibility checks that retain the embedding model, stored vector
  dimension, source identities and pre-existing synthetic archive behavior.
- Test infrastructure regressions for stalled HTTP headers/bodies, health-check
  deadlines, child shutdown escalation, inherited pipes and Fetch-compatible
  ephemeral ports. Generation mock cleanup is registered before server startup;
  a fault-injected startup failure reports its error and exits without hanging.

The public checks do not require separately supplied application source trees.
Launcher checks also verified actual terminal Ctrl+C handling: cleanup completes,
the exact `CTRL-C` block prints, and subsequent `;` and `&&` commands run.
Unexpected exits still fail. Source packaging excludes untracked and dirty
working-tree content and rejects private paths, nested dependencies and symlinks.

CI exposes separate Linux gates and native Windows setup/core checks, with source
packaging regressions on both platforms. Stages have explicit deadlines. Failure
artifacts contain bounded isolated-server logs and browser diagnostics, retained
for seven days. User configuration and stores are excluded. Source releases run
these required jobs, including dependency security, again on the version tag
before publishing either archive. The existing workflow also runs scheduled
security auditing; application and bundled-dependency findings both block a
release.

## Platform and format scope

Setup pins Node 24.22.1 and npm 12.2.1. Linux x64 is the primary verification
platform. Windows PowerShell setup and ARM64 runtime selection are included;
native Windows is a separate required GitHub CI job. Native ARM64 and native Windows renderer-source reproduction were not
executed in this local gate. Full dependency installation is repeated by both
platform setup jobs; 1.1.0 requires a fresh locked dependency installation before
its release gate. The dependency advisory service is required for security
validation even when functional tests can use cached models.
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
