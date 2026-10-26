# Optional public application compatibility check

`analytics-capture.test.mjs` exercises the complete public data path:

1. Enhanced ingests a synthetic ChatGPT export using the real embedding pipeline.
2. The released Reader HTTP adapter fetches the conversation from Enhanced.
3. Unmodified Reader storage modules publish a schema-3 SQLite catalog in storage
   format 2 and append a committed journal operation.
4. The public Analytics capture module reads the archive without modifying it.

Both 7z and ZIP profiles are checked for conversation/raw-content equality, source
identities, journal replay, stable repeated captures, exclusion of preferences and
unrelated files, read-only access, and temporary capture cleanup. This does not
launch Electron or validate desktop installers.

The references are the public [ThreadShelf Local Suite v1.2.0 source at commit
`c1030b0f014332a9b746ed4e2d93cd672bcb2a09`](https://github.com/Davoda1/ThreadShelf-Local-Suite/tree/c1030b0f014332a9b746ed4e2d93cd672bcb2a09).
Only the named storage/capture modules and bundled codec are read; their Git blob
hashes are pinned in the test. Application sources and native codecs are not
copied into this server release. Synthetic profiles and module staging are
isolated in temporary directories and removed afterward.

Use Node 24 on Linux or Windows x64 and install this project's dependencies.
Set these variables to application roots in the unpacked public Suite source:

| Variable                          | Source directory |
| --------------------------------- | ---------------- |
| `THREADSHELF_READER_REFERENCE`    | `apps/reader`    |
| `THREADSHELF_ANALYTICS_REFERENCE` | `apps/analytics` |

The Reader root must include its released `vendor/7zip` codec for the current
platform. Run:

```sh
node --import tsx --test test/compatibility/analytics-capture.test.mjs
```

This optional integration is separate from `npm test` and `npm run test:e2e`,
because desktop reference packages are not server dependencies. The embedding
model downloads on first use if it is not cached. The bundled HTTP adapter
fixtures remain covered by the ordinary server integration suite.

Reader storage performs a free-space preflight. To put synthetic profiles and
captures on another volume, set `THREADSHELF_COMPAT_STORAGE_TMPDIR` to an existing
writable directory. Reference module staging uses the normal temporary folder.
