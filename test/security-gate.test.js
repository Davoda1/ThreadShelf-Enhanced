import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureCommand,
  queryBulkAdvisories,
  retryCheck,
  validateAuditReport,
  validateBulkReport,
  validateBundleInventory,
} from '../scripts/check-security.mjs';

const cleanAudit = () => ({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
});

test('security gate does not mistake an error or incomplete npm report for zero findings', () => {
  assert.deepEqual(validateAuditReport(cleanAudit(), 'test'), []);
  for (const response of [
    {},
    [],
    null,
    { error: { code: 'NETWORK_ERROR' } },
    { ...cleanAudit(), metadata: {} },
    { ...cleanAudit(), auditReportVersion: 1 },
  ]) {
    assert.throws(() => validateAuditReport(response, 'test'), /missing|unsupported/);
  }
  const incorrect = cleanAudit();
  incorrect.metadata.vulnerabilities.total = 1;
  assert.throws(() => validateAuditReport(incorrect, 'test'), /inconsistent/);
});

test('security gate reports low-severity findings instead of accepting a high-only threshold', () => {
  const response = cleanAudit();
  response.vulnerabilities.example = {
    name: 'example',
    severity: 'low',
    via: [],
    nodes: ['node_modules/example'],
    range: '<1.0.1',
  };
  response.metadata.vulnerabilities.low = 1;
  response.metadata.vulnerabilities.total = 1;
  assert.deepEqual(validateAuditReport(response, 'test'), ['example: low (<1.0.1)']);
  response.vulnerabilities.example.severity = 'unknown';
  assert.throws(() => validateAuditReport(response, 'test'), /malformed/);
});

test('bundled advisory checking rejects unexpected response shapes and packages', () => {
  const payload = { example: ['1.0.0'] };
  assert.deepEqual(validateBulkReport({}, payload), []);
  for (const response of [
    [],
    null,
    { error: 'temporary outage' },
    { example: {} },
    { other: [] },
    { example: [{}] },
  ]) {
    assert.throws(() => validateBulkReport(response, payload));
  }
  assert.equal(
    validateBulkReport(
      {
        example: [
          {
            id: 1,
            title: 'Synthetic advisory',
            severity: 'moderate',
            vulnerable_versions: '<1.0.1',
            url: 'https://example.test/advisory',
          },
        ],
      },
      payload,
    ).length,
    1,
  );
});

async function bundleFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'client/public/renderer'), { recursive: true });
  const content = '// synthetic inert renderer fixture\n';
  const path = 'client/public/renderer/example.js';
  await writeFile(join(root, path), content);
  return {
    root,
    inventory: {
      schemaVersion: 1,
      assets: [{ path, sha256: createHash('sha256').update(content).digest('hex') }],
      packages: [{ name: 'example', version: '1.0.0' }],
    },
  };
}

test('bundled inventory verifies exact asset bytes and supports multiple nested package versions', async (t) => {
  const { root, inventory } = await bundleFixture(t);
  inventory.packages.push({ name: 'example', version: '1.0.1' });
  const payload = await validateBundleInventory(root, inventory);
  assert.deepEqual(payload.example, ['1.0.0', '1.0.1']);
  await writeFile(join(root, inventory.assets[0].path), '// changed bytes\n');
  await assert.rejects(validateBundleInventory(root, inventory), /hash mismatch/);
});

test('new renderer scripts cannot silently bypass the bundled inventory', async (t) => {
  const { root, inventory } = await bundleFixture(t);
  for (const filename of ['forgotten.js', 'forgotten.mjs', 'forgotten.cjs', 'forgotten.JS']) {
    const path = join(root, 'client/public/renderer', filename);
    await writeFile(path, '// inert fixture\n');
    await assert.rejects(validateBundleInventory(root, inventory), /no audited inventory/);
    await rm(path);
  }
});

test('bundled inventory rejects omitted, duplicate, and unsafe entries', async (t) => {
  const { root, inventory } = await bundleFixture(t);
  for (const invalid of [
    null,
    {},
    { ...inventory, packages: [] },
    { ...inventory, assets: [] },
    { ...inventory, assets: [...inventory.assets, ...inventory.assets] },
    {
      ...inventory,
      assets: [{ ...inventory.assets[0], path: 'client/public/renderer/../other.js' }],
    },
    { ...inventory, packages: [...inventory.packages, ...inventory.packages] },
    { ...inventory, packages: [{ name: 'example', version: '^1.0.0' }] },
  ]) {
    await assert.rejects(validateBundleInventory(root, invalid));
  }
});

test('bundled inventory rejects renderer symlinks', async (t) => {
  const { root, inventory } = await bundleFixture(t);
  const asset = join(root, inventory.assets[0].path);
  await rm(asset);
  const target = join(root, 'outside.js');
  await writeFile(target, '// synthetic inert renderer fixture\n');
  try {
    await symlink(target, asset);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows account cannot create file symlinks.');
      return;
    }
    throw error;
  }
  await assert.rejects(validateBundleInventory(root, inventory), /symlink/);
});

test('registry failures and non-JSON success bodies remain failed checks', async () => {
  const payload = { example: ['1.0.0'] };
  await assert.rejects(
    queryBulkAdvisories(payload, {
      fetchRegistry: async () => new Response('unavailable', { status: 503 }),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    queryBulkAdvisories(payload, {
      fetchRegistry: async () => new Response('<html>proxy error</html>'),
    }),
    /did not return JSON/,
  );
  assert.deepEqual(
    await queryBulkAdvisories(payload, {
      fetchRegistry: async (url, options) => {
        assert.equal(url, 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), payload);
        assert.ok(options.signal instanceof AbortSignal);
        return new Response('{}');
      },
    }),
    [],
  );
});

test('registry retries are bounded and never turn an outage into a pass', async () => {
  let calls = 0;
  const retryOptions = { wait: async () => {}, log: () => {} };
  await assert.rejects(
    retryCheck(async () => {
      calls += 1;
      throw new Error('Synthetic registry outage');
    }, retryOptions),
    /Synthetic registry outage/,
  );
  assert.equal(calls, 3);
  calls = 0;
  assert.equal(
    await retryCheck(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Synthetic transient failure');
      return 'verified';
    }, retryOptions),
    'verified',
  );
  assert.equal(calls, 2);
});

test(
  'npm audit subprocesses are stopped and reaped after the deadline',
  { timeout: 10000 },
  async () => {
    await assert.rejects(
      captureCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 300 }),
      /time limit/,
    );
    const result = await captureCommand(process.execPath, [
      '-e',
      'process.stdout.write("synthetic audit output")',
    ]);
    assert.equal(result.code, 0);
    assert.equal(result.output, 'synthetic audit output');
  },
);

test('invoking the security CLI through a symlink cannot silently skip the gate', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'threadshelf-security-cli-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const script = join(fixture, 'check-security.mjs');
  const alias = join(fixture, 'alias.mjs');
  await copyFile(new URL('../scripts/check-security.mjs', import.meta.url), script);
  try {
    await symlink(script, alias);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows account cannot create file symlinks.');
      return;
    }
    throw error;
  }
  const result = spawnSync(process.execPath, [alias], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, 'missing inventory must fail even through an aliased script path');
  assert.match(result.stderr, /Security verification failed or incomplete/);
});
