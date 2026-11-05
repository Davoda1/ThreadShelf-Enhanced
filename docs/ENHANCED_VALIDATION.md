# Enhanced validation

Release preparation uses synthetic conversations and isolated temporary stores.
It does not read live archives, use paid-provider credentials or require private
application source trees. Hosted Linux/Windows checks remain mandatory before
release assets are published; local results do not assert hosted CI has passed.
See [Actions](https://github.com/Davoda1/ThreadShelf-Enhanced/actions) for the exact
commit/tag status. The [1.3.0 record](ENHANCED_VALIDATION_1.3.0.md) is historical.

## Release 1.4.1 coverage

The release suite includes JSON visibility and lossless code formatting, the full
code-download language/alias catalog, original-text copy/download behavior,
SVG validation and inert previews, wrapped code and display-only line numbers.
Browser regressions cover the new recessed explanations, action placement,
persisted settings, speech-subtab state and import-destination changes. Existing
storage, migration, security, API/MCP, public-client and source-packaging gates
remain required. Hosted results are reported in Actions for the exact commit/tag.

## Historical local release checks — 1.4.0, 2026-11-02

| Check | Result |
| --- | --- |
| Dependency security | No reported findings in four audit scopes; both renderer asset hashes verified |
| Repository hygiene | 600 public candidates checked; no populated environment, data stores, downloaded runtimes or credentials included |
| Lint and server/client TypeScript | Passed |
| Production client and compiled server builds | Passed |
| Unit/regression suite | 1,032 passed; three platform-specific skips; 1,035 total |
| HTTP API and MCP | 59 passed |
| Chromium browser regressions | 150 passed |
| Source-packaging regressions | 17 passed |
| Compiled-server smoke | Unrelated-directory startup, UI, collection/config/speech endpoints and shutdown passed; speech starts disabled |
| Migration | Synthetic stopped copies, source preservation, refusal of existing data/custom layouts, dependency audits (including aliased parents of missing paths) and explicit-path requirements passed |
| Documentation screenshots | Ten fresh light/dark images from 24 synthetic conversations; captured with actual storage/search/UI routes |

The local runtime is Node 26.13.0 LTS with npm 12.2.1. Local browser checks use
an available Chromium executable through `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`;
CI installs the browser pinned by Playwright. The screenshot script uses a fresh
browser profile, temporary storage and synthetic content only. It never downloads
voices or synthesizes audio. Public launchers and the optional manual importer
remain part of the ordinary regression suite.

## Feature coverage

- Both independent LAN flags: disabled defaults, exact `1` enabling, `.env`
  lifecycle/process precedence, host/origin guards, settings and actual HTTP chat
  and speech transports. The `/v1` key policy and separate network listener remain
  independently controlled. LAN cases use forwarded client addresses; they do not
  test a particular physical network or firewall.
- Speech: opt-in settings, no automatic model download, verified CPU readiness,
  response-only metadata exclusion, previews/playback, cancellation, private-mode
  isolation, queue ownership, cache pins, credentials, transactional installation
  and retained Windows runtime hashes. Recorded real CPU-engine component checks
  are described in [TTS.md](TTS.md); paid-provider inference and physical speaker
  quality are outside these release-preparation checks.
- Search: independent lexical/semantic candidates, complete filters, deterministic
  ranking, lexical-cache fallback, legacy Reader totals/cursors and actual released
  public Reader/Alternative HTTP adapters against 384-dimensional embeddings.
- Generation and notes: bounded archive tools, live Markdown access, revision and
  permission checks, chat-write approval, private memory-only state, Strata/API
  transport, vision/projector guards and provider-error handling.
- Interface: six languages, desktop/narrow layouts, tab and control stability,
  search-row sizing, rich rendering and speech-player behavior.

## Public distribution

The source packager reads only a committed Git tree and rejects private/runtime
paths, symlinks, generated archives and unsafe filenames. ZIP and TAR.GZ contain
the same regular files and modes. One `SHA256SUM.txt` covers the two archives.
The release workflow validates the matching version tag through reusable Linux,
Windows, security and packaging jobs and confirms the tagged commit has reached protected `master` before creating
the GitHub release. Previous
release tags/assets remain unchanged; Enhanced is not published to npm.

The public tree excludes machine-specific configuration, launchers, deployment
instructions and conversation exports. `scripts/migrate-installation.mjs` instead
requires explicit paths and retains stopped-copy verification and rollback. Its
local reports are runtime data and are excluded from releases.

A complete stopped backup is still necessary for upgrades. Synthetic migration
coverage is not a test of any particular archive, external note folder or model
layout. Native Windows execution is delegated to required hosted CI. Desktop
installers are not launched by the HTTP adapter checks.
