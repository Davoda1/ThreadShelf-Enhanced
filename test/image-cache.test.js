import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-image-cache-'));
process.env.THREADSHELF_IMAGE_CACHE_PATH = join(root, 'images-only');
process.env.LANCEDB_PATH = join(root, 'conversation-store-must-not-open');
const {
  clearImageCache, closeImageCache, configureImageCache, downloadImage,
  getImageResource, imageCacheStats, isPublicImageAddress, sniffImageMime,
  validateImageUrl,
} = await import('../src/image-cache.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = (bytes = png) => ({ bytes, mime: 'image/png', cacheable: true });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(async () => {
  await clearImageCache();
  await configureImageCache({ enabled: false, maxBytes: 512 * 1024 ** 2 });
});
after(async () => {
  closeImageCache();
  assert.ok(!(await readdir(root)).includes('conversation-store-must-not-open'));
  await rm(root, { recursive: true, force: true });
});

test('cache URL policy rejects local addresses, mapped encodings, credentials and non-HTTP schemes', () => {
  for (const url of [
    'file:///etc/passwd', 'data:image/png;base64,abc', 'https://user:pass@example.com/image.png',
    'http://127.0.0.1/x', 'http://2130706433/x', 'http://0x7f000001/x', 'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x', 'http://10.0.0.5/x', 'http://169.254.169.254/x',
    'http://192.168.1.2/x', 'http://host.local/x', 'http://host.localhost/x',
    'http://[2001:db8::1]/x', 'http://[3fff:fff::1]/x', 'http://[2002:7f00:1::]/x',
  ]) assert.throws(() => validateImageUrl(url), url);
  assert.equal(validateImageUrl('https://example.com/image.png#fragment').href, 'https://example.com/image.png');
  assert.equal(isPublicImageAddress('8.8.8.8'), true);
  assert.equal(isPublicImageAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicImageAddress('3fff:1000::1'), true);
});

const transportFor = (responses, calls = []) => (url, options, callback) => {
  calls.push({ url: url.href, options });
  const request = new EventEmitter();
  request.destroy = (error) => { if (error) request.emit('error', error); request.emit('close'); return request; };
  request.end = () => queueMicrotask(() => {
    const response = new PassThrough();
    const selected = responses.shift() ?? {};
    response.statusCode = selected.status ?? 200;
    response.headers = selected.headers ?? {};
    response.on('close', () => request.emit('close'));
    callback(response);
    response.end(selected.bytes ?? png);
  });
  return request;
};

test('DNS is checked once per request and the selected public address and family are pinned', async () => {
  const calls = [];
  let lookups = 0;
  const result = await downloadImage('https://public.example/image.png', {
    lookup: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; },
    transport: transportFor([{}], calls),
  });
  assert.equal(lookups, 1);
  assert.equal(calls[0].options.family, 4);
  assert.equal(calls[0].options.agent, false);
  assert.equal(calls[0].options.headers.Cookie, undefined);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  calls[0].options.lookup('public.example', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
  assert.deepEqual(result.bytes, png);
});

test('mixed public/private DNS answers and private redirects are blocked before connection', async () => {
  let connections = 0;
  await assert.rejects(downloadImage('https://public.example/image.png', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    transport: () => { connections++; throw new Error('must not connect'); },
  }), /blocked address/);
  assert.equal(connections, 0);
  const calls = [];
  await assert.rejects(downloadImage('https://public.example/image.png', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: transportFor([{ status: 302, headers: { location: 'http://127.0.0.1/private' } }], calls),
  }), /public network address/);
  assert.equal(calls.length, 1);
});

test('redirect targets receive a new DNS check and image content is verified', async () => {
  const hosts = [];
  const calls = [];
  const result = await downloadImage('https://first.example/image.png', {
    lookup: async (host) => { hosts.push(host); return [{ address: '8.8.4.4', family: 4 }]; },
    transport: transportFor([
      { status: 302, headers: { location: 'https://second.example/redirected.png' } },
      { headers: { 'content-type': 'text/plain', 'cache-control': 'private, no-store' } },
    ], calls),
  });
  assert.deepEqual(hosts, ['first.example', 'second.example']);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.cacheable, false);
  assert.equal(sniffImageMime(Buffer.from('<svg><script>bad()</script></svg>')), undefined);
  await assert.rejects(downloadImage('https://public.example/not-an-image', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: transportFor([{ bytes: Buffer.from('<html>Login required</html>') }]),
  }), /invalid image content/);
});

test('disabled caching returns validated images without persisting image bytes', async () => {
  let downloads = 0;
  const fetchImage = async () => { downloads++; return image(); };
  await getImageResource('https://example.com/a.png', 'collection_a', fetchImage);
  await getImageResource('https://example.com/a.png', 'collection_a', fetchImage);
  assert.equal(downloads, 2);
  assert.equal(imageCacheStats().count, 0);
  assert.equal((await readdir(process.env.THREADSHELF_IMAGE_CACHE_PATH)).filter((name) => name.endsWith('.image')).length, 0);
});

test('cache entries and collection-specific purge remain isolated from each other and conversation data', async () => {
  await configureImageCache({ enabled: true });
  let downloads = 0;
  const fetchImage = async () => { downloads++; return image(); };
  const url = 'https://example.com/shared.png';
  await getImageResource(url, 'collection_a', fetchImage);
  await getImageResource(url, 'collection_b', fetchImage);
  await getImageResource(url, 'collection_a', fetchImage);
  assert.equal(downloads, 2);
  assert.equal(imageCacheStats().count, 2);
  await clearImageCache('collection_a');
  assert.deepEqual(imageCacheStats().collections.map((entry) => entry.collection), ['collection_b']);
  await getImageResource(url, 'collection_b', fetchImage);
  assert.equal(downloads, 2);
  await getImageResource(url, 'collection_a', fetchImage);
  assert.equal(downloads, 3);
  assert.ok(!(await readdir(root)).includes('conversation-store-must-not-open'));
});

test('global purge, collection purge and disabling cache fence already-running downloads', async () => {
  for (const action of [() => clearImageCache(), () => clearImageCache('fenced'), () => configureImageCache({ enabled: false })]) {
    await configureImageCache({ enabled: true });
    const gate = deferred();
    const started = deferred();
    const pending = getImageResource('https://example.com/inflight.png', 'fenced', async () => {
      started.resolve();
      await gate.promise;
      return image();
    });
    await started.promise;
    await action();
    gate.resolve();
    assert.deepEqual((await pending).bytes, png);
    assert.equal(imageCacheStats().count, 0);
  }
});

test('cache quotas evict old entries and invalid settings never silently change limits', async () => {
  await configureImageCache({ enabled: true, maxBytes: 16 * 1024 ** 2 });
  const large = Buffer.alloc(9 * 1024 ** 2);
  png.copy(large);
  await getImageResource('https://example.com/first.png', 'quota', async () => image(large));
  await getImageResource('https://example.com/second.png', 'quota', async () => image(large));
  assert.equal(imageCacheStats().count, 1);
  assert.equal(imageCacheStats().bytes, large.length);
  assert.equal((await readdir(process.env.THREADSHELF_IMAGE_CACHE_PATH)).filter((name) => name.endsWith('.image')).length, 1);
  for (const settings of [{ enabled: 'false' }, { maxBytes: 0 }, { maxBytes: Infinity }, { maxBytes: '100' }])
    await assert.rejects(configureImageCache(settings), /Invalid cache setting|Cache limit/);
  assert.equal(imageCacheStats().maxBytes, 16 * 1024 ** 2);
});

test('corrupt cache files are reloaded instead of being returned to the browser', async () => {
  await configureImageCache({ enabled: true });
  const url = 'https://example.com/corrupt.png';
  await getImageResource(url, 'cache_validation', async () => image());
  const filename = (await readdir(process.env.THREADSHELF_IMAGE_CACHE_PATH)).find((name) => name.endsWith('.image'));
  await writeFile(join(process.env.THREADSHELF_IMAGE_CACHE_PATH, filename), '<html>corrupt</html>');
  let downloads = 0;
  assert.deepEqual((await getImageResource(url, 'cache_validation', async () => { downloads++; return image(); })).bytes, png);
  assert.equal(downloads, 1);
  assert.equal(imageCacheStats().count, 1);
});

test('identical concurrent requests share one bounded download and no-store responses are not cached', async () => {
  await configureImageCache({ enabled: true });
  const gate = deferred();
  let downloads = 0;
  const fetchImage = async () => { downloads++; await gate.promise; return { ...image(), cacheable: false }; };
  const a = getImageResource('https://example.com/shared.png', 'inflight', fetchImage);
  const b = getImageResource('https://example.com/shared.png', 'inflight', fetchImage);
  gate.resolve();
  await Promise.all([a, b]);
  assert.equal(downloads, 1);
  assert.equal(imageCacheStats().count, 0);
});


test('an empty collection selector cannot accidentally purge every collection', async () => {
  await configureImageCache({ enabled: true });
  await getImageResource('https://example.com/retained.png', 'retained', async () => image());
  await assert.rejects(clearImageCache(''), /empty after normalization/);
  assert.equal(imageCacheStats().count, 1);
});

test('cache mutation recovers orphan files from interrupted publication without touching unrelated files', async () => {
  const cacheRoot = process.env.THREADSHELF_IMAGE_CACHE_PATH;
  const orphan = 'a'.repeat(64) + '-11111111-2222-3333-4444-555555555555.image';
  const temporary = 'b'.repeat(64) + '-11111111-2222-3333-4444-555555555555.image.tmp';
  await writeFile(join(cacheRoot, orphan), png);
  await writeFile(join(cacheRoot, temporary), png);
  await writeFile(join(cacheRoot, 'unrelated.txt'), 'Retain this unrelated file.');
  closeImageCache();
  await configureImageCache({ enabled: true });
  const names = await readdir(cacheRoot);
  assert.ok(!names.includes(orphan));
  assert.ok(!names.includes(temporary));
  assert.ok(names.includes('unrelated.txt'));
});


test('a wall of six distinct images queues without exceeding four active downloads', async () => {
  let active = 0, maximum = 0, downloads = 0;
  const gate = deferred();
  const firstFour = deferred();
  const requests = Array.from({ length: 6 }, (_, index) => getImageResource(
    `https://example.com/wall-${index}.png`, 'image_wall', async () => {
      downloads++;
      active++;
      maximum = Math.max(maximum, active);
      if (downloads === 4) firstFour.resolve();
      await gate.promise;
      active--;
      return image();
    },
  ));
  await firstFour.promise;
  assert.equal(downloads, 4);
  gate.resolve();
  const images = await Promise.all(requests);
  assert.equal(images.length, 6);
  assert.equal(downloads, 6);
  assert.equal(maximum, 4);
});


test('image-cache HTTP routes validate selectors, preserve other collections and serve inert image bytes', async (t) => {
  const { default: express } = await import('express');
  const { default: router } = await import('../src/routes/image-cache.js');
  const { requireLocalOrigin } = await import('../src/routes/local-origin.js');
  const app = express();
  app.use(express.json());
  app.use('/api', requireLocalOrigin);
  app.use(router);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  await configureImageCache({ enabled: true });
  const url = 'https://example.com/route.png';
  await getImageResource(url, 'route_a', async () => image());
  await getImageResource(url, 'route_b', async () => image());
  const response = await fetch(`${base}/api/image-cache/resource?${new URLSearchParams({ url, collection: 'route_a' })}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/png/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/image-cache?collection=`, { method: 'DELETE' })).status, 400);
  assert.equal(imageCacheStats().count, 2);
  assert.equal((await fetch(`${base}/api/image-cache?collection=route_a`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(imageCacheStats().collections.map((entry) => entry.collection), ['route_b']);
  assert.equal((await fetch(`${base}/api/image-cache`, { headers: { Origin: 'https://outside.example' } })).status, 403);
});
