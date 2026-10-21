# Contributing to ThreadShelf Enhanced

Contributions should preserve local archive privacy, existing ThreadShelf API and
data identities, and the source distribution workflow. Use
[GitHub Issues](https://github.com/Davoda1/ThreadShelf-Enhanced/issues) for bugs and
feature discussions. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.

## Development setup

Use Node 24+ and a compatible npm version. The setup scripts install the pinned
project-local Node 24.22.1/npm 12.2.1 runtime and build the application; see the
[installation guide](README.md#installation).

With Node/npm available in your shell:

```bash
npm ci
npm run build
npm start
```

Open [http://localhost:3000](http://localhost:3000). For development, run
`npm run dev` and `npm run dev:client` in separate terminals. The Vite UI proxies
API calls to the server. The root and client are npm workspaces sharing one
lockfile; install dependencies at the root.

## Validation

Use focused checks while iterating, then run the complete gate before submitting
behavior changes:

| Command | Scope |
| --- | --- |
| `npm run check:security` | Locked dependency and bundled-renderer advisories plus asset integrity; requires advisory-service access |
| `npm test` | Parsers, validation, chunking, import behavior and unit regressions |
| `npm run test:e2e` | HTTP API, LanceDB, search, threads and MCP integration |
| `npm run build:client` | Client TypeScript and production UI build |
| `npm run test:playwright` | UI and browser workflows; requires the built UI and Chromium |
| `npm run build:server` | Compiled server and MCP output |
| `npm run check` | Dependency security, repository hygiene, lint, TypeScript, unit, integration, UI build and browser checks |
| `python3 test/source-release.test.py` | Source archive contents, permissions, exclusions and reproducibility (use `python` on Windows) |

Install the browser once with `npx playwright install chromium`. Integration
tests use temporary stores; never redirect them to a live archive. Report which
commands ran and any skips or platform limitations. The first embedding run may
need a model download. Security checks need access to the current advisory service;
service failures must not be treated as a clean audit. Update bundled-component
inventory, asset hashes and license provenance with any browser-library change.

GitHub CI runs the full Linux gate, native Windows setup/core checks, and source
packaging tests on both platforms. Each stage has a timeout. Failed runs retain
bounded logs from isolated test servers and browser results for seven days;
configuration, user stores and dependency caches are not diagnostic artifacts.

## Fixtures and privacy

Fixtures must be synthetic and anonymized. Do not commit real prompts, assistant
answers, account metadata, API keys, emails, names or private project content.
When an export breaks, preserve only the shape needed to reproduce it, substitute
synthetic multilingual content, add a fixture and a focused regression, then fix
the behavior. Keep original input handling read-only.

## Code and pull requests

- Use ES modules, two-space indentation, semicolons and single quotes.
- Keep HTTP behavior in `src/routes/` and shared logic in `src/services/`.
- Prefer structured parsing over fragile string substitutions.
- Preserve adjacent source attribution and licenses for adapted components.
- Describe the problem, resulting behavior and validation in the pull request.
- Include screenshots for visible UI changes and note storage, environment or
  privacy effects.
- Check `git status --short --ignored` before committing. Exclude `.env`, exports,
  generated databases, logs, local runtimes and credentials.
- Update user-facing docs when behavior changes, including known limitations.

Enhanced releases contain source ZIP and TAR.GZ archives. The npm package remains
private. Do not re-enable the upstream npm publishing workflow. See [AGENTS.md](AGENTS.md)
for the repository map and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
component provenance.
