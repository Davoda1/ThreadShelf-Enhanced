#!/usr/bin/env node
// Release gate: audit locked dependencies and the separately vendored browser assets.
// It sends only public dependency names/versions to the official npm registry.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import * as http from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org';
const inventoryPath = 'client/src/enhanced-renderer/licenses/dependencies.json';
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const maximumResponseBytes = 8 * 1024 * 1024;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateAuditReport(report, scope) {
  if (
    !object(report) ||
    report.auditReportVersion !== 2 ||
    report.error ||
    !object(report.vulnerabilities) ||
    !object(report.metadata?.vulnerabilities)
  ) {
    throw new Error(`${scope}: missing or unsupported npm audit report.`);
  }
  const counts = Object.fromEntries(severities.map((severity) => [severity, 0]));
  const findings = Object.entries(report.vulnerabilities).map(([name, finding]) => {
    if (
      !object(finding) ||
      finding.name !== name ||
      !severities.includes(finding.severity) ||
      !Array.isArray(finding.via) ||
      !Array.isArray(finding.nodes) ||
      typeof finding.range !== 'string'
    ) {
      throw new Error(`${scope}: malformed npm advisory entry.`);
    }
    counts[finding.severity] += 1;
    return `${name}: ${finding.severity} (${finding.range})`;
  });
  const received = report.metadata.vulnerabilities;
  if (
    !nonnegativeInteger(received.total) ||
    received.total !== findings.length ||
    severities.some(
      (severity) =>
        !nonnegativeInteger(received[severity]) || received[severity] !== counts[severity],
    )
  ) {
    throw new Error(`${scope}: inconsistent npm audit totals.`);
  }
  return findings;
}

export async function retryCheck(
  operation,
  { attempts = 3, wait = delay, log = console.error } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts) throw error;
      // Do not log registry response bodies, proxy URLs, npm config, or credentials.
      log(`Security check unavailable or invalid; retry ${attempt + 1}/${attempts}.`);
      await wait(attempt * 1000);
    }
  }
  throw new Error('Security check did not run.');
}

async function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next runtime layout. */
    }
  }
  throw new Error('Cannot locate npm; run this gate with npm run check:security.');
}

export function captureCommand(
  command,
  args,
  { cwd, timeoutMs = 45000, spawnProcess = spawn } = {},
) {
  return new Promise((resolveResult, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0;
    let problem;
    const stop = (message) => {
      problem ??= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('npm audit exceeded its time limit.'), timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumResponseBytes) stop('npm audit response exceeded its size limit.');
      else chunks.push(chunk);
    });
    child.stderr.resume(); // Warnings are not the machine-readable audit result.
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (problem) reject(problem);
      else if (signal || (code !== 0 && code !== 1))
        reject(new Error('npm audit did not complete.'));
      else resolveResult({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function auditLockfile(projectRoot, productionOnly, description) {
  const scope = description || (productionOnly ? 'Production dependencies' : 'All dependencies');
  const executable = await npmCli();
  return retryCheck(async () => {
    const { code, output } = await captureCommand(
      process.execPath,
      [
        executable,
        'audit',
        '--package-lock-only',
        '--json',
        '--ignore-scripts',
        '--audit-level=low',
        `--registry=${registry}`,
        '--fetch-retries=0',
        '--fetch-timeout=20000',
        '--include=optional',
        '--include=peer',
        productionOnly ? '--omit=dev' : '--include=dev',
      ],
      { cwd: projectRoot },
    );
    let report;
    try {
      report = JSON.parse(output);
    } catch {
      throw new Error(`${scope}: npm did not return JSON.`);
    }
    const findings = validateAuditReport(report, scope);
    if ((code === 0) !== (findings.length === 0)) {
      throw new Error(`${scope}: npm exit status disagrees with its report.`);
    }
    return { scope, findings };
  });
}

export async function validateBundleInventory(projectRoot, inventory) {
  if (
    !object(inventory) ||
    inventory.schemaVersion !== 1 ||
    !Array.isArray(inventory.assets) ||
    inventory.assets.length === 0 ||
    !Array.isArray(inventory.packages) ||
    inventory.packages.length === 0
  ) {
    throw new Error('Bundled dependency inventory is missing or invalid.');
  }
  const canonicalRoot = await realpath(projectRoot);
  const seenAssets = new Set();
  for (const asset of inventory.assets) {
    if (
      !object(asset) ||
      typeof asset.path !== 'string' ||
      !/^client\/public\/renderer\/[A-Za-z0-9._/-]+$/.test(asset.path) ||
      !/\.(?:[cm]?js)$/i.test(asset.path) ||
      asset.path.split('/').some((segment) => segment === '.' || segment === '..') ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      seenAssets.has(asset.path)
    ) {
      throw new Error('Bundled asset entry is missing, duplicated, or unsafe.');
    }
    seenAssets.add(asset.path);
    let current = projectRoot;
    for (const segment of asset.path.split('/')) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Bundled assets must not use symlinks.');
    }
    const destination = await realpath(current);
    const inside = relative(canonicalRoot, destination);
    if (
      isAbsolute(inside) ||
      inside === '..' ||
      inside.startsWith(`..${sep}`) ||
      !(await lstat(destination)).isFile()
    )
      throw new Error('Bundled asset is not a source file.');
    const digest = createHash('sha256')
      .update(await readFile(destination))
      .digest('hex');
    if (digest !== asset.sha256) throw new Error(`Bundled asset hash mismatch: ${asset.path}`);
  }
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Renderer directory contains a symlink.');
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else if (/\.(?:[cm]?js)$/i.test(entry.name) && !seenAssets.has(name)) {
        throw new Error(`Renderer asset has no audited inventory: ${name}`);
      }
    }
  }
  await visit(join(projectRoot, 'client/public/renderer'), 'client/public/renderer');
  const payload = Object.create(null);
  const seenPackages = new Set();
  for (const item of inventory.packages) {
    if (
      !object(item) ||
      typeof item.name !== 'string' ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(item.name) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(item.version) ||
      seenPackages.has(`${item.name}@${item.version}`)
    ) {
      throw new Error('Bundled package version is missing, duplicated, or invalid.');
    }
    seenPackages.add(`${item.name}@${item.version}`);
    (payload[item.name] ??= []).push(item.version);
  }
  return payload;
}

export function validateBulkReport(report, payload) {
  if (!object(report)) throw new Error('Bundled advisory response is not an object.');
  const findings = [];
  for (const [name, advisories] of Object.entries(report)) {
    if (!Object.hasOwn(payload, name) || !Array.isArray(advisories)) {
      throw new Error('Bundled advisory response contains an unexpected package or error.');
    }
    for (const advisory of advisories) {
      if (
        !object(advisory) ||
        !Number.isSafeInteger(advisory.id) ||
        advisory.id <= 0 ||
        typeof advisory.title !== 'string' ||
        !advisory.title ||
        !severities.includes(advisory.severity) ||
        typeof advisory.vulnerable_versions !== 'string' ||
        typeof advisory.url !== 'string' ||
        !advisory.url.startsWith('https://')
      ) {
        throw new Error('Bundled advisory response contains a malformed advisory.');
      }
      findings.push(`${name}: ${advisory.severity} — ${advisory.title} (${advisory.url})`);
    }
  }
  return findings;
}

export async function queryBulkAdvisories(
  payload,
  { fetchRegistry = fetch, timeoutMs = 20000 } = {},
) {
  const response = await fetchRegistry(`${registry}/-/npm/v1/security/advisories/bulk`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Bundled advisory service returned HTTP ${response.status}.`);
  let bytes = 0;
  const chunks = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Bundled advisory service returned no body.');
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maximumResponseBytes) throw new Error('Bundled advisory response is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let report;
  try {
    report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Bundled advisory service did not return JSON.');
  }
  return validateBulkReport(report, payload);
}

export async function runSecurityChecks(projectRoot = root) {
  // Node's supported proxy handling covers fetch as well as HTTP(S); TLS remains verified.
  if (typeof http.setGlobalProxyFromEnv === 'function') http.setGlobalProxyFromEnv();
  const inventory = JSON.parse(await readFile(join(projectRoot, inventoryPath), 'utf8'));
  const payload = await validateBundleInventory(projectRoot, inventory);
  // Always report all scopes, even when an earlier scope finds vulnerabilities.
  const reports = [];
  reports.push(await auditLockfile(projectRoot, false));
  reports.push(await auditLockfile(projectRoot, true));
  reports.push(
    await auditLockfile(
      join(projectRoot, 'scripts/renderer-build'),
      false,
      'Renderer build dependencies',
    ),
  );
  reports.push({
    scope: 'Bundled browser dependencies',
    findings: await retryCheck(() => queryBulkAdvisories(payload)),
  });
  let failed = false;
  for (const report of reports) {
    console.log(`${report.scope}: ${report.findings.length} advisory finding(s).`);
    for (const finding of report.findings) console.error(`  ${finding}`);
    failed ||= report.findings.length !== 0;
  }
  if (failed)
    throw new Error('Security gate failed; resolve the reported dependencies before release.');
  console.log(`Security gate passed; ${inventory.assets.length} renderer asset hashes verified.`);
}

const invokedPath = process.argv[1]
  ? await realpath(resolve(process.argv[1])).catch(() => null)
  : null;
if (import.meta.main === true || invokedPath === (await realpath(fileURLToPath(import.meta.url)))) {
  runSecurityChecks().catch((error) => {
    console.error(`Security verification failed or incomplete: ${error.message}`);
    process.exitCode = 1;
  });
}
