import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ServerTts } from '../src/tts/service.ts';
import { TtsAssetManager } from '../src/tts/assets.ts';
import { safeMember, extractTarGz } from '../src/tts/archive.ts';
import { gzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { wav } = require('../tts/providers.cjs');
const ownerA = 'owner-a-1234567890',
  ownerB = 'owner-b-1234567890';
const audio = wav(Buffer.alloc(480, 5));
async function fixture(t, dependencies = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'threadshelf-tts-'));
  const service = new ServerTts(
    new TtsAssetManager(join(dir, 'assets-test')),
    join(dir, 'profile'),
    dependencies,
  );
  t.after(async () => {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, service };
}
const args = (id, text = 'A test reading.') => ({
  requestId: id,
  sourceId: 'synthetic-archive/conversation',
  messageId: id,
  text,
});

test('TTS defaults do not create persistent directories or download assets', async (t) => {
  const { dir, service } = await fixture(t);
  assert.equal((await service.settings()).enabled, false);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(
    service.synthesize(ownerA, args('one'), false, () => {}),
    /disabled/,
  );
  assert.deepEqual(await readdir(dir), []);
});
test('enabling speech only saves settings; no model files or network request', async (t) => {
  const { dir, service } = await fixture(t);
  await service.save({ enabled: true });
  assert.deepEqual(await readdir(join(dir, 'profile')), ['tts-settings-v1.json']);
  assert.equal((await service.settings()).streamingEnabled, true);
  await service.save({ streamingEnabled: false });
  assert.equal((await service.settings()).streamingEnabled, false);
});
test('owner FIFO does not cancel another tab and cancel only affects its owner', async (t) => {
  let releases = [],
    seen = [];
  const { service } = await fixture(t, {
    synthesizeCPU: ({ text, signal }) =>
      new Promise((resolve, reject) => {
        seen.push(text);
        releases.push(() => resolve(audio));
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      }),
  });
  await service.save({ enabled: true });
  const first = service.synthesize(ownerA, args('first', 'first'), false, () => {});
  while (!seen.length) await new Promise((r) => setImmediate(r));
  const second = service.synthesize(ownerB, args('second', 'second'), false, () => {});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['first']);
  assert.deepEqual(await service.invoke(ownerB, 'tts.cancel', { requestId: 'first' }), {
    cancelled: false,
  });
  releases.shift()();
  assert.equal((await first).requestId, 'first');
  while (seen.length < 2) await new Promise((r) => setImmediate(r));
  releases.shift()();
  assert.equal((await second).requestId, 'second');
});
test('master off cancels active and queued jobs across owners', async (t) => {
  let began = false;
  const { service } = await fixture(t, {
    synthesizeCPU: ({ signal }) =>
      new Promise((_r, reject) => {
        began = true;
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      }),
  });
  await service.save({ enabled: true });
  const first = service.synthesize(ownerA, args('first'), false, () => {});
  const a = assert.rejects(first);
  while (!began) await new Promise((r) => setImmediate(r));
  const second = service.synthesize(ownerB, args('second'), false, () => {});
  const b = assert.rejects(second);
  await service.save({ enabled: false });
  await Promise.all([a, b]);
});
test('private requests neither read nor retain saved or session audio', async (t) => {
  let calls = 0;
  const { service, dir } = await fixture(t, {
    synthesizeCPU: async () => {
      calls++;
      return audio;
    },
  });
  await service.save({ enabled: true, cacheEnabled: true });
  const one = await service.synthesize(ownerA, args('one'), false, () => {});
  assert.equal(one.stored, true);
  const before = await readFile(join(dir, 'profile', 'tts-cache', 'index-v1.json'), 'utf8');
  const privateResult = await service.synthesize(
    ownerA,
    { ...args('private'), messageId: 'one', private: true },
    false,
    () => {},
  );
  assert.equal(calls, 2);
  assert.equal(privateResult.cached, false);
  assert.equal(privateResult.stored, false);
  assert.equal(privateResult.sessionRetained, false);
  assert.equal(privateResult.cacheKey, null);
  assert.equal(await readFile(join(dir, 'profile', 'tts-cache', 'index-v1.json'), 'utf8'), before);
  assert.deepEqual(
    await service.invoke(ownerA, 'tts.availability', { private: true, messages: [{ id: 'one' }] }),
    { revision: 0, items: [{ id: 'one', available: false }] },
  );
});
test('playback leases protect completed audio from another tabs cache cleanup', async (t) => {
  const { service } = await fixture(t, { synthesizeCPU: async () => audio });
  await service.save({ enabled: true, cacheEnabled: true });
  const first = await service.synthesize(ownerA, args('one'), false, () => {});
  await service.synthesize(ownerB, args('two'), false, () => {});
  assert.equal(
    (
      await service.invoke(ownerA, 'tts.playback', {
        requestId: 'one',
        cacheKey: first.cacheKey,
        active: true,
      })
    ).protected,
    true,
  );
  const preview = await service.invoke(ownerB, 'tts.cache.preview', { filter: { scope: 'all' } });
  assert.equal(preview.protectedCount, 2);
  assert.equal(
    (
      await service.invoke(ownerB, 'tts.playback', {
        requestId: 'one',
        cacheKey: first.cacheKey,
        active: false,
      })
    ).protected,
    false,
  );
  await service.invoke(ownerA, 'tts.playback', {
    requestId: 'one',
    cacheKey: first.cacheKey,
    active: false,
  });
  assert.equal(
    (await service.invoke(ownerB, 'tts.cache.preview', { filter: { scope: 'all' } })).count,
    1,
  );
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fakeAssets = () =>
  ['pocket', 'kokoro'].map((engine) => {
    const bytes = Buffer.from(engine);
    return {
      engine,
      kind: 'file',
      target: `common/models/${engine}/test.bin`,
      url: `https://assets.invalid/${engine}`,
      sha256: hash(bytes),
      size: bytes.length,
    };
  });
test('asset installer requires review, validates downloaded bytes, activates atomically, repairs and removes one engine', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-installer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let requests = 0;
  const assets = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => {
      requests++;
      return new Response(Buffer.from(new URL(url).pathname.slice(1)));
    },
    smoke: async (root, engines) => {
      for (const e of engines)
        assert.equal(await readFile(join(root, 'models', e, 'test.bin'), 'utf8'), e);
    },
  });
  const plan = await assets.plan(['pocket', 'kokoro']);
  assert.equal(requests, 0);
  await assert.rejects(
    assets.install(['pocket'], plan.fingerprint, () => {}),
    /changed/,
  );
  assert.equal(requests, 0);
  await assets.install(['pocket', 'kokoro'], plan.fingerprint, () => {});
  assert.equal(requests, 2);
  assert.equal((await assets.status()).engines.pocket.installed, true);
  const active = JSON.parse(await readFile(join(dir, 'assets', 'active.json'), 'utf8'));
  await writeFile(
    join(dir, 'assets', 'versions', active.version, 'models', 'pocket', 'test.bin'),
    'broken',
  );
  assert.equal((await assets.status()).engines.pocket.installed, false);
  const repair = await assets.plan(['pocket', 'kokoro']);
  await assets.install(['pocket', 'kokoro'], repair.fingerprint, () => {});
  assert.equal(requests, 2);
  assert.equal((await assets.status()).engines.pocket.installed, true);
  await assets.uninstall(['pocket']);
  assert.equal((await assets.status()).engines.kokoro.installed, true);
  assert.equal((await assets.status()).engines.pocket.installed, false);
  await assets.uninstall(['kokoro']);
  assert.equal((await assets.status()).engines.kokoro.installed, false);
});
test('hash mismatch cannot publish a ready asset installation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-bad-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assets = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets().slice(0, 1),
    fetchImpl: async () => new Response('wrong!'),
    smoke: async () => {
      throw new Error('Must not smoke unverified bytes');
    },
  });
  const plan = await assets.plan(['pocket']);
  await assert.rejects(
    assets.install(['pocket'], plan.fingerprint, () => {}),
    /SHA-256/,
  );
  assert.equal((await assets.status()).engines.pocket.installed, false);
});
test('repeated voice repairs retire superseded versions without removing settings or audio', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-repair-retirement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assets = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => new Response(Buffer.from(new URL(url).pathname.slice(1))),
    smoke: async () => {},
  });
  await writeFile(join(dir, 'tts-settings-v1.json'), 'settings remain unchanged');
  await mkdir(join(dir, 'saved-audio'));
  await writeFile(join(dir, 'saved-audio', 'pinned.wav'), audio);
  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await assets.plan(['pocket', 'kokoro']);
    await assets.install(['pocket', 'kokoro'], plan.fingerprint, () => {});
    const active = JSON.parse(await readFile(join(dir, 'assets', 'active.json'), 'utf8'));
    assert.deepEqual(await readdir(join(dir, 'assets', 'versions')), [active.version]);
    assert.equal((await assets.status()).engines.pocket.installed, true);
    assert.equal((await assets.status()).engines.kokoro.installed, true);
    assert.equal(assets.verified.size, active.inventory.length);
    assert.ok([...assets.verified.keys()].every((key) => key.startsWith(active.version + '/')));
  }
  assert.equal(
    await readFile(join(dir, 'tts-settings-v1.json'), 'utf8'),
    'settings remain unchanged',
  );
  assert.deepEqual(await readFile(join(dir, 'saved-audio', 'pinned.wav')), audio);
  assert.equal((await readdir(join(dir, 'assets', 'downloads'))).length, 2);
  const anotherManager = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    smoke: async () => {},
  });
  const plan = await anotherManager.plan(['pocket', 'kokoro']);
  await anotherManager.install(['pocket', 'kokoro'], plan.fingerprint, () => {});
  await assets.withAssets('pocket', async () => {});
  const active = JSON.parse(await readFile(join(dir, 'assets', 'active.json'), 'utf8'));
  assert.equal(assets.verified.size, active.inventory.length);
  assert.ok([...assets.verified.keys()].every((key) => key.startsWith(active.version + '/')));
});
test('repair retains a worker previous version until its usage lease is released', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-repair-reader-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installer = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => new Response(Buffer.from(new URL(url).pathname.slice(1))),
    smoke: async () => {},
  });
  const plan = await installer.plan(['pocket']);
  await installer.install(['pocket'], plan.fingerprint, () => {});
  const before = JSON.parse(await readFile(join(dir, 'assets', 'active.json'), 'utf8'));
  const reader = new TtsAssetManager(dir, 'linux-x64');
  let release, entered;
  const ready = new Promise((resolve) => (entered = resolve));
  const hold = new Promise((resolve) => (release = resolve));
  const work = reader.withAssets('pocket', async (folder) => {
    entered();
    await hold;
    assert.equal(await readFile(join(folder, 'models', 'pocket', 'test.bin'), 'utf8'), 'pocket');
  });
  try {
    await ready;
    await installer.install(['pocket'], plan.fingerprint, () => {});
    const active = JSON.parse(await readFile(join(dir, 'assets', 'active.json'), 'utf8'));
    assert.notEqual(active.version, before.version);
    assert.equal((await readdir(join(dir, 'assets', 'versions'))).length, 2);
  } finally {
    release();
    await work;
  }
  const active = JSON.parse(await readFile(join(dir, 'assets', 'active.json'), 'utf8'));
  assert.deepEqual(await readdir(join(dir, 'assets', 'versions')), [active.version]);
});
test('failed or cancelled repair preserves the previous working activation and version', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-repair-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let outcome = 'success';
  const controller = new AbortController();
  const assets = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => new Response(Buffer.from(new URL(url).pathname.slice(1))),
    smoke: async () => {
      if (outcome === 'failure') throw new Error('Synthetic readiness failed');
      if (outcome === 'cancel') controller.abort(new Error('Synthetic repair cancelled'));
    },
  });
  const plan = await assets.plan(['pocket']);
  await assets.install(['pocket'], plan.fingerprint, () => {});
  const before = await readFile(join(dir, 'assets', 'active.json'), 'utf8');
  for (outcome of ['failure', 'cancel']) {
    await assert.rejects(
      assets.install(['pocket'], plan.fingerprint, () => {}, controller.signal),
      /Synthetic (readiness failed|repair cancelled)/,
    );
    assert.equal(await readFile(join(dir, 'assets', 'active.json'), 'utf8'), before);
    assert.deepEqual(await readdir(join(dir, 'assets', 'versions')), [JSON.parse(before).version]);
    assert.equal((await assets.status()).engines.pocket.installed, true);
  }
});
test('status retries a snapshot retired during verification instead of reporting corruption', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-status-retired-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writer = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => new Response(Buffer.from(new URL(url).pathname.slice(1))),
    smoke: async () => {},
  });
  const plan = await writer.plan(['pocket']);
  await writer.install(['pocket'], plan.fingerprint, () => {});
  const reader = new TtsAssetManager(dir, 'linux-x64');
  const originalActive = reader.active.bind(reader);
  let snapshots = 0;
  // Hold the snapshot across a real successful repair/removal, deterministically
  // reproducing the filesystem race between reading active.json and lstat.
  reader.active = async () => {
    const snapshot = await originalActive();
    if (++snapshots === 1) await writer.install(['pocket'], plan.fingerprint, () => {});
    return snapshot;
  };
  const status = await reader.status();
  assert.equal(status.engines.pocket.installed, true);
  assert.equal(status.warning, undefined);
  assert.equal(snapshots, 4);
});
test('status rechecks the active version after successful verification', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-status-recheck-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const writer = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => new Response(Buffer.from(new URL(url).pathname.slice(1))),
    smoke: async () => {},
  });
  const plan = await writer.plan(['pocket', 'kokoro']);
  await writer.install(['pocket', 'kokoro'], plan.fingerprint, () => {});
  const reader = new TtsAssetManager(dir, 'linux-x64');
  const originalActive = reader.active.bind(reader);
  let snapshots = 0;
  reader.active = async () => {
    if (++snapshots === 2) await writer.uninstall(['pocket']);
    return originalActive();
  };
  const status = await reader.status();
  assert.equal(status.engines.pocket.installed, false);
  assert.equal(status.engines.kokoro.installed, true);
  assert.equal(status.warning, undefined);
});
test('status bounds repeated snapshot changes and reports a retry rather than corruption', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-status-bounded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assets = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets(),
    fetchImpl: async (url) => new Response(Buffer.from(new URL(url).pathname.slice(1))),
    smoke: async () => {},
  });
  const plan = await assets.plan(['pocket']);
  await assets.install(['pocket'], plan.fingerprint, () => {});
  const active = await assets.active();
  let snapshots = 0;
  assets.active = async () => ({
    ...active,
    version: snapshots++ % 2 === 0 ? active.version : 'f'.repeat(64),
  });
  const status = await assets.status();
  assert.equal(snapshots, 6);
  assert.equal(status.engines.pocket.installed, false);
  assert.equal(status.busy, true);
  assert.match(status.warning, /changed while checking.*retry/);
  assert.doesNotMatch(status.warning, /missing|repair|verification/i);
});
test('archive paths reject traversal, absolute paths, Windows drive names, links and special names', () => {
  for (const path of [
    '../escape',
    '/escape',
    'a/../escape',
    'C:/escape',
    'a\\escape',
    'a//b',
    'a\0b',
  ])
    assert.throws(() => safeMember(path));
  assert.equal(safeMember('./safe/file'), 'safe/file');
});
function tarEntry(name, text = '', type = '0', link = '') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(text.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write('ustar\0', 257);
  const sum = header.reduce((n, b) => n + b, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([
    header,
    Buffer.from(text),
    Buffer.alloc((512 - (text.length % 512)) % 512),
  ]);
}
test('tar extractor materializes internal links and refuses links escaping staging', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-tar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = join(dir, 'archive.gz');
  await writeFile(
    archive,
    gzipSync(
      Buffer.concat([
        tarEntry('python/bin/python3.11', 'synthetic'),
        tarEntry('python/bin/python3', '', '2', 'python3.11'),
        Buffer.alloc(1024),
      ]),
    ),
  );
  await extractTarGz(archive, join(dir, 'safe'));
  assert.equal(await readFile(join(dir, 'safe', 'python', 'bin', 'python3'), 'utf8'), 'synthetic');
  await writeFile(
    archive,
    gzipSync(Buffer.concat([tarEntry('bad', '', '2', '../../outside'), Buffer.alloc(1024)])),
  );
  await assert.rejects(extractTarGz(archive, join(dir, 'bad')), /Unsafe/);
});

test('parallel requests cannot race past the queue limits or duplicate request identity', async (t) => {
  const { service } = await fixture(t, {
    synthesizeCPU: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        ),
      ),
  });
  await service.save({ enabled: true });
  const pending = Array.from({ length: 12 }, (_, i) =>
    service.synthesize(
      `owner-parallel-${String(i).padStart(4, '0')}`,
      args('parallel' + i),
      false,
      () => {},
    ),
  );
  const settled = Promise.allSettled(pending);
  await new Promise((r) => setTimeout(r, 20));
  await service.save({ enabled: false });
  const results = await settled;
  assert.equal(
    results.filter((r) => r.status === 'rejected' && /queue is full/.test(r.reason.message)).length,
    4,
  );
  await service.save({ enabled: true });
  const duplicates = Promise.allSettled([
    service.synthesize(ownerA, args('duplicate'), false, () => {}),
    service.synthesize(ownerA, args('duplicate'), false, () => {}),
  ]);
  await new Promise((r) => setTimeout(r, 20));
  await service.save({ enabled: false });
  const duplicateResults = await duplicates;
  assert.equal(
    duplicateResults.filter(
      (r) => r.status === 'rejected' && /already queued/.test(r.reason.message),
    ).length,
    1,
  );
});
test('abandoned playback leases expire before cache cleanup, including the last completed request', async (t) => {
  const { service } = await fixture(t, { synthesizeCPU: async () => audio });
  await service.save({ enabled: true, cacheEnabled: true });
  await service.synthesize(ownerA, args('expiring'), false, () => {});
  const now = Date.now;
  try {
    Date.now = () => now() + 301000;
    const preview = await service.invoke(ownerA, 'tts.cache.preview', { filter: { scope: 'all' } });
    assert.equal(preview.count, 1);
    assert.equal(preview.protectedCount, 0);
  } finally {
    Date.now = now;
  }
});

test('disabling speech can cancel an active installer without publishing assets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tts-installer-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let started = false;
  const assets = new TtsAssetManager(dir, 'linux-x64', {
    manifest: fakeAssets().slice(0, 1),
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        started = true;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      }),
    smoke: async () => {
      throw new Error('Cancelled payload must not reach readiness');
    },
  });
  const plan = await assets.plan(['pocket']);
  const install = assets.install(['pocket'], plan.fingerprint, () => {});
  const failed = assert.rejects(install, { name: 'AbortError' });
  while (!started) await new Promise((r) => setImmediate(r));
  assets.cancelInstallation();
  await failed;
  assert.equal((await assets.status()).engines.pocket.installed, false);
  assert.equal((await assets.status()).busy, false);
});
