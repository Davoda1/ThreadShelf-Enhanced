# Migrating a stopped installation

The source release includes `scripts/migrate-installation.mjs`. It copies a
standard repository-layout installation into a fresh installation, verifies the
copied bytes with SHA-256, preserves the source, and audits configuration paths
and symlinks for dependencies on the old directory. It has no default paths.

1. Stop every server, importer, watcher and MCP writer using either installation.
   Keep a complete backup. `--stopped` is your confirmation; Linux process checks
   are an additional best-effort safeguard, not proof that every writer has stopped.
2. Extract the new source into a separate, non-nested directory. Run setup there
   without `--start` / `-Start`. Do not launch the new server before migration.
3. Run the new installation's helper with both explicit paths.

Linux x64, from the new source directory:

```bash
bash setup-threadshelf.sh
.local/node-v26.13.0-linux-x64/bin/node scripts/migrate-installation.mjs \
  --stopped --source /path/to/old-installation --target /path/to/new-installation
```

Windows x64, from the new source directory:

```powershell
.\setup-threadshelf.ps1
.\.local\node-v26.13.0-win-x64\node.exe scripts\migrate-installation.mjs `
  --stopped --source 'D:\Apps\ThreadShelf-OLD' --target 'D:\Apps\ThreadShelf'
```

Use `arm64` in the runtime path on a supported ARM64 system. Add
`--include-caches` to copy `.cache`, `.config`, `.home` and `.local/share` if used
by the old installation. Standard `.lancedb`, `.uploads`, `.collections.json`,
`.threadshelf` and `.env` are copied when present. The complete `.threadshelf`
includes model/setup configuration, local speech assets, credentials and optional
recordings; these do not require `--include-caches`.

The destination must not already contain any selected data entry. A setup-created
`.env` is the only replacement exception: it is retained in a timestamped backup
before the source `.env` is installed. Source changes, interrupted copying and
verification failures abort the migration; committed entries are rolled back on
failure. Old code, dependencies, local Node binaries and generated builds are not
copied. The helper never deletes the old installation.

## Review before starting

- Review the copied `.env`, particularly absolute paths, host/origin permissions
  and the independent `ALLOW_LAN_AI` / `ALLOW_LAN_TTS` flags. Editing the template
  before migration does not change the source configuration that replaces it.
- Read dependency warnings and the local migration report. Model roots, executable
  paths, image caches, projector mappings, note vaults and symlinks may still point
  to the old installation. External resources are reported and remain unchanged.
- Custom `THREADSHELF_DATA_DIR` layouts, a custom database path and database
  symlinks require a separately planned copy of their real data roots; the helper
  refuses them instead of claiming a complete migration. It does not copy external
  vaults or rewrite stored conversation identities/source paths.
- Start the new server and verify collection counts, stored conversations, all
  search modes, media, configured models, note folders, speech and desktop clients.
  Only remove the old installation after those checks and all dependency warnings
  are resolved. A clean audit covers configuration and symlinks, not every stored
  source reference or attachment.

Repeat the audit without copying or modifying either installation:

```bash
node scripts/migrate-installation.mjs --audit-only \
  --source /path/to/old-installation --target /path/to/new-installation
```

Audit exit status is `2` when old-directory dependencies remain and `0` when the
checked locations are clear. Copy failures return a nonzero exit status. A
successful copy may still report dependencies needing review. Local reports
contain installation paths and relative configuration locations; keep them private.

Upgrade all processes sharing the writable store together. Rollback after the new
server has written data means restoring the complete stopped backup, not running
an older server against the modified store.
