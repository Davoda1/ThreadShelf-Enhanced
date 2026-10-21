# Released Local client adapters

These small fixtures execute the actual released HTTP adapters against the Enhanced
server in `test/e2e/compatibility-clients.test.js`. They are MIT-licensed source,
not recreated clients. They contain no exports, user settings or credentials.

The files come from [ThreadShelf Local Suite v1.0.0](https://github.com/Davoda1/ThreadShelf-Local-Suite/tree/v1.0.0),
commit `e17d5874342ce0069acba2ed387d46eefbf61f24`:

| Fixture                  | Public source path                 | Git blob SHA-1                             |
| ------------------------ | ---------------------------------- | ------------------------------------------ |
| `reader/server.mjs`      | `apps/reader/src/core/server.mjs`  | `5884a4f03d437a31a773b371da31e08d09431dcf` |
| `alternative/server.cjs` | `apps/alternative/core/server.cjs` | `6f1f5cc2d4da2312045db5358c86c7e9165c2045` |

The test verifies these two public adapter blob hashes before exercising the
clients. This identifies the named adapter files only; it does not establish
identity of other application code. `reader/state.mjs` contains only the adapter's original URL
normalization helper, extracted to avoid copying unrelated application preferences. App licenses are retained in each fixture subdirectory.

The server pagination extension and `test/reader-pagination.test.js` originate in
the same public release's `server-patch/`; see `PAGINATION-NOTICES.md`. The native
pagination regression uses deterministic vectors, while the separate end-to-end
test ingests synthetic ChatGPT conversations through the production embedding model.

This validates server API interoperability; it does not claim to launch Electron
or test desktop installers. Analytics reads Local Reader archives rather than the
server API. These adapter tests do not validate the separate Analytics archive
pipeline.
