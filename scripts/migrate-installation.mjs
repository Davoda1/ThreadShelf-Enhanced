#!/usr/bin/env node
/** Copy a stopped installation and audit old-directory dependencies. */
import {
  cp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  lstat,
  readlink,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, relative, isAbsolute, sep, delimiter } from 'node:path';
import { parseEnv } from 'node:util';
let interrupted = false;
const onSignal = () => {
  interrupted = true;
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
const checkInterrupted = () => {
  if (interrupted)
    throw Error(
      'Migration interrupted; staged copy will be discarded and committed entries rolled back.',
    );
};
const args = process.argv.slice(2);
let source = '';
let target = '';
let stopped = false,
  caches = false,
  auditOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source' || args[i] === '--target') {
    const name = args[i],
      value = args[++i];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${name}.`);
    if (name === '--source') source = value;
    else target = value;
  } else if (args[i] === '--stopped') stopped = true;
  else if (args[i] === '--include-caches') caches = true;
  else if (args[i] === '--audit-only') auditOnly = true;
  else if (args[i] === '--help') {
    console.log(
      'Usage: node scripts/migrate-installation.mjs --stopped --source OLD --target NEW [--include-caches]\n       node scripts/migrate-installation.mjs --audit-only --source OLD --target NEW\nStop both servers, all indexers/watchers and MCP writers first. Copies data, verifies SHA-256 and preserves old files. Refuses existing target data. The read-only audit checks configuration and symlinks, never rewrites identities, and exits 2 if dependencies on OLD remain.',
    );
    process.exit(0);
  } else throw Error(`Unknown argument: ${args[i]}`);
}
if (!auditOnly && !stopped)
  throw Error('Stop both servers, indexers/watchers and MCP writers; then pass --stopped.');
if (!source || !target)
  throw Error('Both --source OLD and --target NEW are required; no default paths are used.');
source = resolve(source);
target = resolve(target);
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const exists = async (p) => {
  try {
    await lstat(p);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
if (!(await lstat(source)).isDirectory() || !(await lstat(target)).isDirectory())
  throw Error('Both installation directories must exist.');
source = await realpath(source);
target = await realpath(target);
if (within(source, target) || within(target, source))
  throw Error('Source and target must be separate, non-nested directories.');
// Catch normal local Node writers. --stopped remains required for other users,
// remote writers and applications this process cannot inspect.
if (!auditOnly && process.platform === 'linux') {
  // /proc may expose host PIDs while process.pid is namespaced (containers).
  // Exclude our actual proc entry as well, otherwise a script installed inside
  // the target mistakes its own command line/cwd for a running writer.
  const selfPids = new Set([String(process.pid)]);
  try {
    selfPids.add(await readlink('/proc/self'));
  } catch {
    /* Best effort. */
  }
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid) || selfPids.has(pid)) continue;
    try {
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
      if (!/node|tsx|threadshelf/.test(command[0])) continue;
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (
        [source, target].some((root) => within(root, cwd)) ||
        command.some((arg) => arg.startsWith(source + sep) || arg.startsWith(target + sep))
      )
        throw Object.assign(Error(`Process ${pid} may be using an installation; stop it first.`), {
          busy: true,
        });
    } catch (error) {
      if (error.busy) throw error;
    }
  }
}
const entries = ['.lancedb', '.uploads', '.collections.json', '.threadshelf', '.env'];
if (caches || auditOnly) entries.push('.cache', '.config', '.home', '.local/share');
const selected = [];
for (const name of entries) {
  if (!(await exists(join(source, name)))) continue;
  if (!auditOnly && name !== '.env' && (await exists(join(target, name))))
    throw Error(
      `Target ${name} already exists. Keep it safe; use a fresh target before migration.`,
    );
  selected.push(name);
}
if (!selected.includes('.lancedb'))
  throw Error('No .lancedb found. Check custom LANCEDB_PATH/THREADSHELF_DATA_DIR settings first.');
if (!auditOnly && (await lstat(join(source, '.lancedb'))).isSymbolicLink())
  throw Error(
    'The source database is a symlink. No files were copied; migrate its real data directory explicitly.',
  );
if (!auditOnly && selected.includes('.env')) {
  const config = parseEnv(await readFile(join(source, '.env'), 'utf8'));
  if (config.THREADSHELF_DATA_DIR?.trim())
    throw Error(
      'Custom THREADSHELF_DATA_DIR uses a different storage layout. No files were copied; migrate that separately configured data root explicitly.',
    );
  for (const [key, expected] of [['LANCEDB_PATH', '.lancedb']]) {
    if (!config[key]) continue;
    const value = resolve(target, config[key]);
    if (value !== resolve(target, expected) && value !== resolve(source, expected))
      throw Error(
        `Custom ${key} is outside the supported installation layout. No files were copied; preserve the separately configured data root before continuing.`,
      );
  }
}
const fingerprint = async (root) => {
  const digest = createHash('sha256');
  async function visit(path, name) {
    checkInterrupted();
    const stat = await lstat(path);
    digest.update(name + '\0');
    if (stat.isSymbolicLink()) {
      if (name === '.lancedb' || name.startsWith('.lancedb/'))
        throw Error(`A database symlink cannot be copied as an independent archive: ${name}`);
      digest.update('link\0' + (await readlink(path)));
      return;
    }
    if (stat.isDirectory()) {
      digest.update('dir\0');
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), name + '/' + child);
    } else if (stat.isFile()) {
      digest.update('file\0' + stat.size + '\0');
      for await (const chunk of createReadStream(path)) {
        checkInterrupted();
        digest.update(chunk);
      }
    } else throw Error(`Unsupported special file: ${path}`);
  }
  for (const name of selected) await visit(join(root, name), name);
  return digest.digest('hex');
};
// Reports contain field names and relative locations, never configuration values or secrets.
const auditDependencies = async () => {
  const issues = [],
    external = [];
  const recordPath = async (value, location) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const path = resolve(target, value.trim());
    let canonical = path;
    try {
      canonical = await realpath(path);
    } catch {
      /* Missing directories may be created later. */
    }
    if (within(source, path) || within(source, canonical))
      issues.push({ kind: 'old-directory-path', location });
    else if (!within(target, path) || !within(target, canonical))
      external.push({ kind: 'external-resource', location });
  };
  const visit = async (path, name) => {
    checkInterrupted();
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const direct = resolve(path, '..', await readlink(path));
      if (within(source, direct)) issues.push({ kind: 'old-directory-symlink', location: name });
      else {
        try {
          const actual = await realpath(path);
          if (within(source, actual))
            issues.push({ kind: 'old-directory-symlink', location: name });
          else if (!within(target, actual))
            external.push({ kind: 'external-symlink', location: name });
        } catch {
          issues.push({ kind: 'unresolved-symlink', location: name });
        }
      }
    } else if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child), `${name}/${child}`);
    }
  };
  for (const name of entries)
    if (await exists(join(target, name))) await visit(join(target, name), name);
  let env = {};
  if (await exists(join(target, '.env'))) {
    env = parseEnv(await readFile(join(target, '.env'), 'utf8'));
    for (const key of [
      'LANCEDB_PATH',
      'UPLOADS_DIR',
      'COLLECTIONS_PATH',
      'THREADSHELF_DATA_DIR',
      'GENERATION_CONFIG_PATH',
      'MASTER_PROMPTS_PATH',
      'OBSIDIAN_CONFIG_PATH',
      'THREADSHELF_MODELS_PATH',
      'THREADSHELF_MODEL_CACHE',
      'THREADSHELF_IMAGE_CACHE_PATH',
      'LLAMA_CPP_SERVER',
      'LLAMA_SERVER_PATH',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'HF_HOME',
      'HF_HUB_CACHE',
      'TRANSFORMERS_CACHE',
    ])
      await recordPath(env[key], `.env:${key}`);
    for (const [index, value] of (env.LLAMA_MODEL_PATHS || '')
      .split(delimiter)
      .filter(Boolean)
      .entries())
      await recordPath(value, `.env:LLAMA_MODEL_PATHS[${index}]`);
    if ((env.NODE_OPTIONS || '').includes(source))
      issues.push({ kind: 'old-directory-node-options', location: '.env:NODE_OPTIONS' });
  }
  const generation = resolve(target, env.GENERATION_CONFIG_PATH || '.threadshelf/generation.json');
  if (within(target, generation) && (await exists(generation))) {
    const config = JSON.parse(await readFile(generation, 'utf8'));
    for (const key of ['executablePath', 'downloadDirectory'])
      await recordPath(config.llamaCpp?.[key], `generation.llamaCpp.${key}`);
    for (const [index, value] of (config.llamaCpp?.modelDirectories || []).entries())
      await recordPath(value, `generation.llamaCpp.modelDirectories[${index}]`);
    for (const [index, [model, projector]] of Object.entries(
      config.llamaCpp?.projectorPaths || {},
    ).entries()) {
      await recordPath(model, `generation.llamaCpp.projectorPaths[${index}].model`);
      await recordPath(projector, `generation.llamaCpp.projectorPaths[${index}].projector`);
    }
  }
  const vaultConfig = resolve(target, env.OBSIDIAN_CONFIG_PATH || '.threadshelf/obsidian.json');
  if (within(target, vaultConfig) && (await exists(vaultConfig))) {
    const config = JSON.parse(await readFile(vaultConfig, 'utf8'));
    await recordPath(config.vaultPath, 'obsidian.vaultPath');
    for (const [index, vault] of (Array.isArray(config.vaults) ? config.vaults : []).entries())
      await recordPath(vault?.vaultPath, `obsidian.vaults[${index}].vaultPath`);
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    source,
    target,
    issues,
    external,
    scope:
      'Configuration paths and copied symlinks only. Verify conversations, attachments and search in the application before deleting the old installation.',
  };
};
const printAudit = (report) => {
  if (report.issues.length) {
    console.log(
      `Keep the old installation: ${report.issues.length} dependency warning(s) need review.`,
    );
    for (const issue of report.issues) console.log(`  ${issue.kind}: ${issue.location}`);
  } else
    console.log(
      'No dependencies on the old directory were found in the checked configuration and symlinks.',
    );
  if (report.external.length) {
    console.log(
      `${report.external.length} external resource reference(s) remain unchanged; they were not copied.`,
    );
    for (const item of report.external) console.log(`  ${item.kind}: ${item.location}`);
  }
  console.log(
    'Conversation identities were preserved. Before deleting OLD, verify conversations, attachments, keyword/semantic search and model availability in the new installation.',
  );
};
if (auditOnly) {
  const report = await auditDependencies();
  printAudit(report);
  process.exit(report.issues.length ? 2 : 0);
}
const stage = join(target, `.migration-stage-${process.pid}`);
const committed = [];
let envBackup;
await mkdir(stage, { mode: 0o700 });
try {
  const before = await fingerprint(source);
  for (const name of selected) {
    await mkdir(resolve(join(stage, name), '..'), { recursive: true });
    await cp(join(source, name), join(stage, name), {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  }
  if (before !== (await fingerprint(source)) || before !== (await fingerprint(stage)))
    throw Error('Source changed or copied bytes differ; no data was installed.');
  for (const name of selected) {
    checkInterrupted();
    const dest = join(target, name);
    if (name === '.env' && (await exists(dest))) {
      envBackup = join(target, `.env.before-migration-${Date.now()}`);
      await rename(dest, envBackup);
    } else if (await exists(dest)) throw Error(`Target appeared during copy: ${name}`);
    await mkdir(resolve(dest, '..'), { recursive: true });
    await rename(join(stage, name), dest);
    committed.push(name);
  }
  if (before !== (await fingerprint(target))) throw Error('Post-copy verification failed.');
  const report = await auditDependencies();
  // Additional metadata is written only after every copied source byte has been verified.
  const reportDirectory = join(target, '.threadshelf');
  const linkedDirectory =
    (await exists(reportDirectory)) && (await lstat(reportDirectory)).isSymbolicLink();
  // A copied configuration symlink may point into OLD. Never write metadata
  // through it, because that would modify the untouched source installation.
  if (!linkedDirectory) await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  let reportPath = linkedDirectory
    ? join(target, `.migration-report-${Date.now()}.json`)
    : join(reportDirectory, 'migration-report.json');
  if (await exists(reportPath))
    reportPath = join(reportDirectory, `migration-report-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify({ ...report, copyVerified: true }, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`Verified migration complete (${selected.join(', ')}). Source remains untouched.`);
  if (envBackup) console.log('Previous target .env retained in a timestamped backup.');
  printAudit(report);
} catch (error) {
  for (const name of committed.reverse()) await rename(join(target, name), join(stage, name));
  if (envBackup) await rename(envBackup, join(target, '.env'));
  throw error;
} finally {
  await rm(stage, { recursive: true, force: true });
}
