/** Opt-in released-source integration; see README.md in this directory. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ingestViaNdjson, repoRoot, startApiServer } from '../e2e/helpers.js';
import { ThreadShelfClient } from '../fixtures/compatibility-clients/reader/server.mjs';

const readerHashes = {
  'archive.mjs': 'cb47c6f8680acecfd5b94f8a40c8cff3614d631a',
  'storage.mjs': '2ebf7cbfb93b108f7987bb0d8042bcfe4303a86b',
  'content-packs.mjs': 'd13fb7bc1290a3cc5682338dfeab9a932efd8dea',
  'codec.mjs': '0279819b8d6e7c387884767dbbb2714e5bf1844a',
  'search-index.mjs': 'b0725f4b728d5c02a459e7a95d9db3dc860844ad',
};
const analyticsHashes = {
  'reader-capture.mjs': 'ead571a4391513ed05edadfd7c3a8f5bb20e15f4',
  'storage-versions.mjs': '0d6b25225cf593a91824035eddb29275c85512ba',
};
const sharedAnalyticsHashes = {
  'codec.mjs': '0279819b8d6e7c387884767dbbb2714e5bf1844a',
  'source-access.mjs': '4c15a4e2959c23d7193720f55e71a2147612777c',
};
const gitHash = (bytes) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const load = (file) => import(pathToFileURL(file).href);

async function fingerprint(directory, relative = '') {
  const result = {};
  for (const entry of await fs.readdir(join(directory, relative), { withFileTypes: true })) {
    const name = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fingerprint(directory, name));
    else
      result[name] = createHash('sha256')
        .update(await fs.readFile(join(directory, name)))
        .digest('hex');
  }
  return result;
}

describe('Enhanced → released Reader archive → Analytics capture', () => {
  let root;
  let dataRoot;
  let document;
  let ArchiveStore;
  let CompressedStorage;
  let capture;

  before(
    async () => {
      const readerReference = process.env.THREADSHELF_READER_REFERENCE;
      const analyticsReference = process.env.THREADSHELF_ANALYTICS_REFERENCE;
      assert.ok(
        readerReference && analyticsReference,
        'Set the two public released reference directories described in test/compatibility/README.md.',
      );
      assert.ok(
        Number(process.versions.node.split('.')[0]) >= 24,
        'Use Node 24 for the released node:sqlite storage modules.',
      );
      const codecRelative = process.platform === 'win32' ? 'win32-x64/7za.exe' : 'linux-x64/7zz';
      assert.ok(
        ['linux', 'win32'].includes(process.platform) && process.arch === 'x64',
        'The released codec supports Windows/Linux x64.',
      );
      const codec = join(readerReference, 'vendor', '7zip', codecRelative);
      const codecBytes = await fs.readFile(codec);
      assert.equal(
        gitHash(codecBytes),
        process.platform === 'win32'
          ? '1389d08f39ccf33f61ed48c5ac0934af4b7b6169'
          : 'af1473472481d36453d2232d9569959c72c486b4',
      );
      root = await fs.mkdtemp(join(tmpdir(), 'threadshelf-analytics-compat-'));
      dataRoot = await fs.mkdtemp(
        join(
          process.env.THREADSHELF_COMPAT_STORAGE_TMPDIR || tmpdir(),
          'threadshelf-analytics-data-',
        ),
      );

      const stage = async (name, reference, expected) => {
        const target = join(root, name);
        await fs.mkdir(join(target, 'src', 'core'), { recursive: true });
        for (const [file, hash] of Object.entries(expected)) {
          const bytes = await fs.readFile(join(reference, 'src', 'core', file));
          assert.equal(gitHash(bytes), hash, `${name}/${file} must be the actual released module`);
          await fs.writeFile(join(target, 'src', 'core', file), bytes);
        }
        const native = join(target, 'vendor', '7zip', codecRelative);
        await fs.mkdir(dirname(native), { recursive: true });
        await fs.writeFile(native, codecBytes, { mode: 0o755 });
        await fs.symlink(
          join(repoRoot, 'node_modules'),
          join(target, 'node_modules'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        return join(target, 'src', 'core');
      };
      const readerCore = await stage('reader', readerReference, readerHashes);
      ({ ArchiveStore } = await load(join(readerCore, 'archive.mjs')));
      ({ CompressedStorage } = await load(join(readerCore, 'storage.mjs')));
      const analyticsCore = await stage('analytics', analyticsReference, {
        ...sharedAnalyticsHashes,
        ...analyticsHashes,
      });
      const versions = await load(join(analyticsCore, 'storage-versions.mjs'));
      assert.equal(versions.STORAGE_FORMAT_VERSION, 2);
      assert.equal(versions.PRODUCT_VERSION, '1.0.0');
      capture = await load(join(analyticsCore, 'reader-capture.mjs'));

      const server = await startApiServer({ prefix: 'threadshelf-analytics-api-' });
      try {
        const folder = join(server.tempRoot, 'synthetic-exports');
        await fs.mkdir(folder);
        await fs.copyFile(
          join(repoRoot, 'test', 'fixtures', 'openai-polish.json'),
          join(folder, 'conversation.json'),
        );
        const result = await ingestViaNdjson(server.baseUrl, folder, 'analytics_bridge');
        assert.deepEqual(result.errors, []);
        const client = new ThreadShelfClient(server.baseUrl);
        const [summary] = await client.allFiles('analytics_bridge');
        document = await client.thread(summary);
        assert.ok(document.turns.length >= 2);
        assert.equal(document.provider, 'openai');
        assert.ok(document.raw && typeof document.raw === 'object');
      } finally {
        await server.stop();
      }
    },
    { timeout: 180_000 },
  );

  after(async () => {
    if (dataRoot) await fs.rm(dataRoot, { recursive: true, force: true });
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  for (const profile of ['7z', 'zip6']) {
    it(
      `Analytics repeatedly captures schema 3/storage 2 ${profile} snapshots and committed journals without modifying Reader`,
      { timeout: 60_000 },
      async () => {
        const source = join(dataRoot, `profile-${profile}`);
        const storage = await new CompressedStorage({
          dataDir: source,
          profile,
          tempRoot: join(dataRoot, 'reader-work'),
        }).init();
        const archive = new ArchiveStore({
          dataDir: storage.workingDir,
          contentDir: storage.objectsDir,
          compression: profile,
        }).init();
        try {
          assert.equal(archive.db.prepare('PRAGMA user_version').get().user_version, 3);
          assert.equal(
            archive.db.prepare('PRAGMA application_id').get().application_id,
            0x54534c52,
          );
          archive.upsert(document);
          await storage.checkpoint({ archiveDb: archive.db });
          assert.equal(storage.pointer.version, 2);
          assert.equal(storage.pointer.format, 'threadshelf-local-storage-v2');
          const mutation = archive.prepareUpsert({
            ...document,
            title: 'Synthetic journal continuation',
            conversationKey: 'synthetic-journal',
            sourceIdentity: { ...document.sourceIdentity, conversationKey: 'synthetic-journal' },
          });
          await storage.commit({ kind: 'archive', mutation }, (record) =>
            archive.applyMutation(record.mutation),
          );
          await fs.writeFile(
            join(source, 'settings.json'),
            JSON.stringify({ excludedSentinel: 'synthetic-preferences' }),
          );
          const before = await fingerprint(source);
          const results = [];
          for (const attempt of [1, 2]) {
            const workspace = join(dataRoot, `capture-${profile}-${attempt}`);
            const access = [];
            const result = await capture.captureReader(source, {
              workspace,
              onAccess: (event) => access.push(event),
            });
            assert.equal(result.conversations.length, 2);
            assert.equal(result.commit.baseSequence, 0);
            assert.equal(result.commit.sequence, 1);
            assert.equal(result.stale, false);
            assert.equal(result.collections[0].count, 2);
            assert.ok(result.conversations.every((item) => item.provider === 'openai'));
            assert.deepEqual(result.conversations[0].turns, document.turns);
            assert.deepEqual(result.conversations[0].raw, document.raw);
            assert.ok(
              result.conversations.every((item) => item.sourceIdentity.kind === 'threadshelf'),
            );
            assert.ok(!JSON.stringify(result).includes('synthetic-preferences'));
            assert.ok(access.length > 0 && access.every((event) => event.flags === 'O_RDONLY'));
            assert.ok(
              !access.some((event) =>
                /writer|gate|settings|reading|activity|search|vectors/.test(event.relative),
              ),
            );
            assert.deepEqual(await fs.readdir(workspace), []);
            assert.deepEqual(
              await fingerprint(source),
              before,
              'Analytics must not modify the live Reader profile',
            );
            results.push(result);
          }
          assert.deepEqual(results[0].conversations, results[1].conversations);
          assert.deepEqual(results[0].collections, results[1].collections);
          assert.equal(results[0].snapshotId, results[1].snapshotId);
        } finally {
          archive.close();
          await storage.close();
        }
      },
    );
  }
});
