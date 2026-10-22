# Enhanced 1.2.0 validation

Validation uses synthetic conversations and isolated stores. No live archive or
credentials are needed for the public-source checks.

**Local release candidate validation: 2026-10-22, Enhanced 1.2.0.** The complete
local gate passed after a fresh locked dependency installation. This release
preserves existing database, identity, embedding and API contracts. The previous
version commits, tags and assets remain separate and unchanged. Required hosted
Linux and Windows checks run before publication; their results are recorded in
[Actions history](https://github.com/Davoda1/ThreadShelf-Enhanced/actions).

## Reproducible checks

| Check | Command or scope | Local 1.2.0 result |
| --- | --- | --- |
| Dependency security | Application lockfile, all and production; renderer-build lockfile; bundled inventory and asset hashes | Passed; zero advisory findings in all four scopes |
| Repository hygiene, lint and server TypeScript | `npm run check:repo`; `npm run lint`; `npx tsc --noEmit` | Passed |
| Unit and regression tests | `npm test` | 627 passed; one native-Windows-only case skipped on Linux |
| HTTP API and MCP integration | `npm run test:e2e` | 30 passed |
| Client TypeScript and production build | `npm run build:client` | Passed |
| Chromium browser regressions | `npm run test:playwright` | 88 passed |
| Compiled server | `npm run build:server`; isolated HTTP smoke from unrelated working directory | Passed; 24 concurrent collection registrations retained and upload deletion used the configured root |
| Source packaging regressions | `python3 test/source-release.test.py` | 12 passed; committed archives are audited again by Linux and Windows CI |
| Enhanced upgrade | Synthetic 1.1.0-to-1.2.0 LanceDB handoff with real embeddings | Existing schemas, rows, identities, source bytes, vectors, API responses and search ordering unchanged |
| Original ThreadShelf upgrade | Synthetic 1.3.0-to-Enhanced-1.2.0 handoff with real embeddings | Original fields, vectors, source bytes and registry retained; existing additive raw-source columns supported |

`npm run check` includes security, hygiene, lint, server TypeScript, unit tests,
HTTP/MCP integration, client build and Chromium regressions. Advisory results are
limited to the public advisory data available at the time of the run. The gate
fails if that service cannot supply a reliable result.

### Bug-fix and upgrade validation

The new regressions cover concurrent appends across independent processes,
rename/append interleavings, schema initialization and legacy normalization, reads during embedding,
process death and lock recovery, cancellation and timeout, nested lock scopes,
queued sibling operations, expired asynchronous contexts, legacy-to-primary
migration races, and the lookup window between legacy and primary storage.
Collection tests cover concurrent registry registration and removal, corrupt
registry preservation, atomic replacement, overridden upload paths, and failure
ordering when a database cannot be deleted. SQLite lock sidecars and their
journal/WAL companions are excluded from source archives.

The upgrade rehearsals each start with four conversations and 11 indexed chunks.
They compare persisted data and search results before exercising rename, append,
reimport and native-chat continuation. Enhanced 1.1.0 retains its exact schema;
original ThreadShelf 1.3.0 retains every original field and vector while the
existing migration adds empty `rawJson` and `sourceIdentityJson` columns. No
embedding-model or dependency change is included in 1.2.0. All processes writing
the same store must upgrade together because older writers do not use the new
interprocess locks.

### Public desktop compatibility

Additional external checks used unmodified public Local Suite 1.0.0 applications
at commit `1be2ceb8cd5fec04fc852861fc0f3173dc0d3155`. These app sources remain in
their own repository and are not server dependencies or release contents.
Reader's core suite passed 519 tests with four conditional skips; Analytics passed
316; Alternative passed 21. Production application sources were unchanged.

Native Linux Electron tests exercised all three applications against an isolated
compiled Enhanced server with 65 synthetic conversations. Reader browsed and
searched across page boundaries, displayed full conversations, imported 35 into
its real compressed local archive, and reopened the archive and appearance
settings after restart. Analytics captured that archive, rendered all 35
conversations and 175 records, reopened its owned capture after restart, and left
every Reader profile file byte-identical. Alternative passed 11 checks covering
connection, pagination, rich thread rendering, navigation, pins/history, in-thread
find, clipboard/export, retained settings and reading position, small-window
layout and visible errors. No renderer errors were recorded. A separate real-embedding pipeline also
passed both 7z and ZIP storage profiles through Reader and Analytics, including
committed journal replay, exact source identity and read-only archive access.

These native checks used a virtual X display and the apps' pinned Electron
versions. The root-only test host required `--no-sandbox` and a test-only
single-instance override; production source and configured context isolation,
renderer sandbox settings and disabled Node integration were verified unchanged.
This is evidence for the tested source applications, not desktop installer or
native Windows desktop certification. No live user database was opened.

### Historical 1.1.0 baseline

The 2026-10-21 local 1.1.0 gate passed 598 unit tests (one Windows-only skip),
30 HTTP/MCP tests, 88 Chromium tests and 12 packaging regressions, with zero
advisory findings in four scopes. A synthetic 1.0.0-to-1.1.0 rehearsal preserved
six rows across three threads and three 384-dimensional query vectors exactly.
A clean renderer rebuild reproduced Mermaid byte-for-byte and verified its
79-package inventory. Launcher terminal Ctrl+C checks verified status zero,
child cleanup and subsequent shell continuation. Those are historical results;
the 1.2.0 gate above records the current run.

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
platform setup jobs; 1.2.0 requires a fresh locked dependency installation before
its release gate. The dependency advisory service is required for security
validation even when functional tests can use cached models.
Native Linux Electron windows and the Reader-to-Analytics archive pipeline were
additionally checked against unmodified public Local Suite sources, as described
above. Desktop installers, native Windows desktop windows and ARM64 desktop
execution were not exercised locally.

Known import limits include duplicate conversations when a ZIP contains both
`conversations.json` and `chat.html`, image companions excluded by browser folder
uploads, unsupported JSONL, and unsupported encrypted Venice backups. See the
[compatibility contract](ENHANCED_COMPATIBILITY.md) for workarounds and details.

No claim is made that every undocumented widget or future export is supported.
Unsupported content remains source or a placeholder. Rendering libraries are
bundled; first setup and model use require network downloads.
