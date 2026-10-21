import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import { groupNativeBackupFiles } from '../src/enhanced-import/venice-groups.js';
import { importPaths } from '../src/enhanced-import/vendor/importers.mjs';

// Synthetic complete-container backups; no private data or database is used.
const temp = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadshelf-venice-groups-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const zip = async (directory, filename, members) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, value] of members)
    await writer.add(name, new TextReader(JSON.stringify(value)), { level: 0 });
  const target = join(directory, filename);
  await writeFile(target, await writer.close());
  return target;
};
const manifest = (owner = 'synthetic-owner') => ({
  backupVersion: 4,
  encrypted: false,
  ownerId: owner,
  databaseVersion: 1,
  chunkCount: 2,
});
const database = (tableName, rows) => ({
  formatName: 'dexie',
  formatVersion: 1,
  data: { databaseVersion: 1, data: [{ tableName, inbound: true, rows }] },
});

test('groups Venice multipart backup and importer reconstructs it without extracting anything', async (t) => {
  const directory = await temp(t);
  const first = await zip(directory, 'backup-01.zip', [
    ['manifest.json', manifest()],
    [
      'db/chunk-0.json',
      database('conversations', [
        { id: 'synthetic-conversation', title: 'Multipart backup', ownerId: 'synthetic-owner' },
      ]),
    ],
  ]);
  const second = await zip(directory, 'backup-02.zip', [
    [
      'db/chunk-1.json',
      database('messages', [
        {
          id: 'synthetic-message',
          conversationId: 'synthetic-conversation',
          role: 'user',
          content: 'Preserved from another part',
          createdAtUnixTimestamp: 1780000000,
        },
      ]),
    ],
  ]);
  const result = await groupNativeBackupFiles([second, first]);
  assert.deepEqual(result, { groups: [[first, second]], diagnostics: [] });
  const records = [];
  for await (const record of importPaths(result.groups[0])) records.push(record);
  assert.equal(records.length, 1);
  assert.equal(records[0].turns[0].user, 'Preserved from another part');
});

test('matching manifests group independent of JSON property order and file selection order', async (t) => {
  const directory = await temp(t);
  const m = manifest();
  const a = await zip(directory, 'a.zip', [
    ['manifest.json', m],
    ['db/chunk-0.json', {}],
  ]);
  const b = await zip(directory, 'b.zip', [
    ['manifest.json', Object.fromEntries(Object.entries(m).reverse())],
    ['db/chunk-1.json', {}],
  ]);
  assert.deepEqual(await groupNativeBackupFiles([b, a, a]), { groups: [[a, b]], diagnostics: [] });
});

test('distinct complete backups remain separate and ambiguous manifestless parts are diagnosed', async (t) => {
  const directory = await temp(t);
  const a = await zip(directory, 'a.zip', [['manifest.json', manifest('owner-a')]]);
  const b = await zip(directory, 'b.zip', [['manifest.json', manifest('owner-b')]]);
  const orphan = await zip(directory, 'orphan.zip', [['db/chunk-1.json', {}]]);
  const result = await groupNativeBackupFiles([b, orphan, a]);
  assert.deepEqual(result.groups, [[a], [b], [orphan]]);
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], /Cannot associate manifestless Venice backup parts/);
});

test('ordinary exports, malformed archives, unrelated manifests and incomplete parts remain visible', async (t) => {
  const directory = await temp(t);
  const json = join(directory, 'conversations.json');
  const broken = join(directory, 'broken.zip');
  await writeFile(json, '[]');
  await writeFile(broken, 'not a ZIP');
  const ordinary = await zip(directory, 'ordinary.zip', [
    ['manifest.json', { version: 4 }],
    ['conversations.json', []],
  ]);
  const orphan = await zip(directory, 'orphan.zip', [['db/chunk-0.json', {}]]);
  const result = await groupNativeBackupFiles([json, broken, ordinary, orphan]);
  assert.deepEqual(result.groups.flat().sort(), [json, broken, ordinary, orphan].sort());
  assert.ok(result.groups.every((group) => group.length === 1));
  assert.deepEqual(result.diagnostics, []);
});

test('manifest CRC is checked before associating archives with another backup', async (t) => {
  const directory = await temp(t);
  const good = await zip(directory, 'good.zip', [['manifest.json', manifest()]]);
  const bad = await zip(directory, 'bad.zip', [['manifest.json', manifest()]]);
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(bad);
  const position = bytes.indexOf(Buffer.from('synthetic-owner'));
  assert.ok(position > 0);
  bytes[position] ^= 1;
  await writeFile(bad, bytes);
  assert.deepEqual(await groupNativeBackupFiles([good, bad]), {
    groups: [[bad], [good]],
    diagnostics: [],
  });
});

test('pre-cancelled grouping aborts without opening sources', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(groupNativeBackupFiles(['/not-opened.zip'], controller.signal), {
    name: 'AbortError',
  });
});
