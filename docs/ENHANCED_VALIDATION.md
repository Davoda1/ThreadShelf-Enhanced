# Enhanced 1.3.0 validation

Required public-source checks use synthetic conversations and isolated temporary
stores. They do not require live archives, credentials or separately supplied
application source trees.

**Local public-source validation passed on 2026-10-26.** The complete
`npm run check` finished successfully after the import history, upload management
and Windows checkpoint fixes. These are local candidate results; the required
hosted commit/tag checks remain separate gates. See
[Actions history](https://github.com/Davoda1/ThreadShelf-Enhanced/actions) for
their exact outcomes. A successful check for an older commit is not evidence
for a newer candidate.

| Local check | Result |
| --- | --- |
| Dependency security | Zero reported findings in all four audit scopes; both bundled asset hashes verified |
| Source hygiene | 489 candidate files checked successfully |
| Lint, server/client TypeScript and client production build | Passed |
| Unit/regression tests | 723 passed; one native Windows-only test skipped on Linux; 724 total |
| HTTP API and MCP integration | 37 passed |
| Browser regressions | 107 passed |
| Compiled server and isolated health/API/UI/shutdown smoke | Passed, including uploaded-file endpoints |
| Source-packaging regressions | 17 passed |
| Optional public Reader-to-Analytics integration | Both 7z and ZIP profiles passed |

The local browser run used Chrome 156.0.8078.47 through
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Normal development and hosted CI retain
Playwright's pinned Chromium unless that override is explicitly set. The optional
[Reader-to-Analytics check](../test/compatibility/README.md) used the public
Local Suite v1.2.0 reference; it does not launch native desktop applications.

## Reproducible gates

| Gate | Command or scope |
| --- | --- |
| Dependency security | `npm run check:security`: application all/production lockfiles, renderer-build lockfile, bundled component inventory and asset hashes |
| Source hygiene | `npm run check:repo`: tracked/untracked candidates, secrets and private/runtime exclusions |
| Lint and server TypeScript | `npm run lint`; `npx tsc --noEmit` |
| Unit/regression tests | `npm test` |
| HTTP API and MCP integration | `npm run test:e2e` |
| Client TypeScript and production build | `npm run build:client` |
| Chromium browser regressions | `npm run test:playwright` |
| Compiled server | `npm run build:server` and isolated HTTP health/UI smoke |
| Source packaging | `python3 test/source-release.test.py`; committed ZIP/TAR inventory, byte/mode parity, reproducibility and SHA-256 checks |

`npm run check` executes the security, source hygiene, lint, TypeScript, unit,
HTTP/MCP, client build and browser gates. Advisory results apply to the available
public advisory data at run time. An unavailable or malformed advisory response
fails the security gate; it is not treated as a clean audit.

Setup pins Node 24.22.1 and npm 12.2.1. Repository workflows require Linux and
Windows setup/core checks, with source packaging on both platforms. The release
workflow must pass the required gates again for the version tag before publishing
its two source archives and one consolidated `SHA256SUM.txt`, including checks
of the actual committed archives. Previous releases remain unchanged. Local
results above do not assert that those hosted or final archive gates have passed;
consult the workflow runs for the exact platform and tag outcomes.

## Coverage for 1.3.0

- Bounded normalization/spooling, large-record safety, mixed supported and
  unsupported files, image companions and lossless provider/source identities.
- Durable checkpoint writes through writable flush handles, including Windows
  requirements, and prevention of reusable completion after a checkpoint flush fails.
- Generation publication, cancellation and staging failure; old published reads
  during preparation; retained local continuations; embedding reuse tied to
  verified model/runtime identity; retirement protected by reader leases.
- Process termination before/after publication, orphan staging cleanup,
  cross-process cache visibility and durable pending-index recovery.
- Accepted uploads surviving browser disconnection, checksummed inputs,
  restart/retry/cancellation, one server/indexer ownership, collection replacement
  reservations and deletion coordinated with queued imports.
- Finished-job history removal, active-job protection and completed progress at
  100%; uploaded-file management with cross-collection input dependencies,
  bounded traversal and protected storage paths.
- Effective host/container memory limits, reclaimable cache accounting, bounded
  pressure handling and cancellation while waiting.
- Existing Reader/Alternative adapter contracts, collection pagination, filtering,
  stored threads, raw content, Insights, and keyword/semantic search.
- Basic/full rendering for each role, animated accessible switches, six interface
  languages, deferred expensive rendering, source copy/export, scroll anchoring
  and short/narrow viewport reachability.
- Inline click/automatic image loading, compact/wide placeholders, no link
  navigation on load, cache partitions/quota/purge and in-flight invalidation.
- Image-proxy destination/redirect validation, DNS pinning, response signature and
  size limits, inert response headers and blocked private destinations.
- Portable runtime setup, public launcher behavior, source-package exclusions
  and retained license/provenance checks.

Existing geometry, visibility and interaction assertions remain part of the
browser suite. Runtime or storage failures must be reproduced with synthetic
fixtures; no real conversation payload belongs in source or CI diagnostics.

## Opt-in scale checks

`test/import-storage-stress.js` exercises actual storage with deterministic
synthetic embeddings, allowing archive/index scaling to be measured separately
from model inference. `test/snapshot-fingerprint-stress.js` checks incremental
fingerprinting against the former single-string size limit. These are opt-in
stress programs, not ordinary unit-test timings or real-export benchmarks.

Two fresh public-source storage checks passed with a 512 MiB old-space ceiling:
4,096 records containing 256 KiB of synthetic raw payload each, and 64 records
containing 16 MiB each. Both represent 1 GiB of raw payload, exceeding the former
single-string fingerprint limit. Each check exercised fresh, unchanged-repeat
and changed-record publication, embedding reuse and reads of the previous
generation during preparation. These scenarios use deterministic synthetic
embeddings and do not measure production-model import throughput.

Example from the source directory:

```bash
node --import tsx --experimental-test-module-mocks --max-old-space-size=512 test/import-storage-stress.js
```

The storage program supports `THREADSHELF_STRESS_ROWS` and
`THREADSHELF_STRESS_ROW_BYTES`. It writes isolated temporary data and removes it
after completion. A heap ceiling is not a total-process memory limit; report RSS,
heap usage, record sizes, available system/container memory and embedding scope
with any published measurements. Production-model integration is tested
separately from synthetic stress embeddings.

## Platform, interoperability and format limits

Linux/Windows server and source checks do not by themselves certify native
Reader/Alternative desktop installers, every Electron build or ARM64 execution.
Adapter coverage establishes the documented API/data contract for the recorded
fixtures; it is not a promise for every future client or undocumented export.
The [compatibility contract](ENHANCED_COMPATIBILITY.md) identifies the supported
scope and import limits.

Bounded processing still needs disk capacity and has per-record/per-format
safety limits. Another process can exhaust system memory between checks. Remote
image availability depends on the hosting service and network; controlled image
fixtures test loader/cache behavior independently. Rich widgets without enough
source data remain readable source or placeholders.

## Historical records

Earlier public validation records remain with their immutable releases:
[1.2.0](https://github.com/Davoda1/ThreadShelf-Enhanced/blob/v1.2.0/docs/ENHANCED_VALIDATION.md),
[1.1.0](https://github.com/Davoda1/ThreadShelf-Enhanced/blob/v1.1.0/docs/ENHANCED_VALIDATION.md)
and [1.0.0](https://github.com/Davoda1/ThreadShelf-Enhanced/blob/v1.0.0/docs/ENHANCED_VALIDATION.md).
Their test totals, desktop observations and platform limitations describe those
versions, not fresh 1.3.0 results.
