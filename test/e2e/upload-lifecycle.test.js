import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApiServer } from './helpers.js';

const entries = async (path) => {
  try {
    return await readdir(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
};

const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(message);
};

const source = (id) =>
  JSON.stringify([
    {
      id,
      title: 'Synthetic upload lifecycle notes',
      current_node: 'answer',
      mapping: {
        prompt: {
          id: 'prompt',
          parent: null,
          message: {
            author: { role: 'user' },
            content: { parts: ['How should a bicycle chain be maintained?'] },
          },
        },
        answer: {
          id: 'answer',
          parent: 'prompt',
          message: {
            author: { role: 'assistant' },
            content: { parts: ['Clean and lubricate the bicycle chain regularly.'] },
          },
        },
      },
    },
  ]);

const uploadForm = (text) => {
  const form = new FormData();
  form.append(
    'synthetic/conversations.json',
    new Blob([text], { type: 'application/json' }),
    'conversations.json',
  );
  return form;
};

// An ordinary interrupted upload, not an exploit input: send a small file prefix,
// wait until disk storage has started, then cancel before the multipart body ends.
const cancelStartedUpload = async (url, incoming) => {
  const boundary = 'threadshelf-lifecycle-boundary';
  const req = request(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  const closed = new Promise((resolve) => req.once('close', resolve));
  req.on('error', () => {}); // Cancellation intentionally closes an incomplete request.
  req.on('response', (response) => response.resume());
  req.setTimeout(10_000, () => req.destroy(new Error('Synthetic upload timed out')));
  try {
    req.write(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="synthetic/conversations.json"; filename="conversations.json"\r\n' +
        'Content-Type: application/json\r\n\r\n' +
        '[{"id":"unfinished-synthetic-upload","title":"Upload cancellation',
    );
    await waitFor(
      async () => (await entries(incoming)).length > 0,
      'The request must reach disk storage before cancellation is tested',
    );
  } finally {
    req.destroy();
    await closed;
  }
  await waitFor(
    async () => (await entries(incoming)).length === 0,
    'Canceled upload left an incoming temporary file',
  );
};

test(
  'Upload rejection and cancellation clean up disk files and allow subsequent imports',
  { timeout: 180_000 },
  async (t) => {
    const ctx = await startApiServer({ prefix: 'threadshelf-upload-lifecycle-' });
    t.after(() => ctx.stop());
    const incoming = join(ctx.tempRoot, '.uploads', '.incoming');

    for (const [index, route] of ['/api/ingest-upload', '/api/ingest-upload-progress'].entries()) {
      await t.test(route, async () => {
        const url = ctx.baseUrl + route;
        const text = source(`upload-lifecycle-${index}`);

        // Eleven simple text fields exceed the documented ten-field limit.
        // Put the tiny file first so error cleanup must also remove a disk file.
        const tooManyFields = uploadForm(text);
        for (let field = 0; field < 11; field++)
          tooManyFields.append(`field${field}`, 'ordinary-value');
        const limited = await fetch(url, {
          method: 'POST',
          body: tooManyFields,
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(limited.status, 400);
        assert.match((await limited.json()).error, /too many fields/i);
        await waitFor(
          async () => (await entries(incoming)).length === 0,
          'Rejected upload left temporary files',
        );

        const invalidOption = uploadForm(text);
        invalidOption.append('clearFirst', 'not-a-boolean');
        const invalid = await fetch(url, {
          method: 'POST',
          body: invalidOption,
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).field, 'clearFirst');
        assert.deepEqual(await entries(incoming), []);

        await cancelStartedUpload(url, incoming);
        const health = await fetch(`${ctx.baseUrl}/api/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        assert.equal(health.status, 200);
        assert.equal((await health.json()).ok, true);
        assert.equal(ctx.server.exitCode, null, 'Server must remain running after cancellation');

        const collection = `upload_lifecycle_${index}`;
        const accepted = uploadForm(text);
        accepted.append('collectionName', collection);
        const response = await fetch(url, {
          method: 'POST',
          body: accepted,
          signal: AbortSignal.timeout(120_000),
        });
        assert.equal(response.status, 200);
        const body = await response.text();
        const completed = route.endsWith('-progress')
          ? body
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
              .at(-1)
          : JSON.parse(body);
        assert.equal(completed.status, 'completed', body);
        assert.deepEqual(completed.result.errors, []);
        assert.equal(completed.result.conversations, 1);
        assert.equal(completed.result.ingested, 2);
        assert.equal(
          await readFile(join(ctx.tempRoot, '.uploads', collection, 'conversations.json'), 'utf8'),
          text,
        );
        assert.deepEqual(await entries(incoming), []);
        const files = await fetch(
          `${ctx.baseUrl}/api/files?${new URLSearchParams({ collection })}`,
          { signal: AbortSignal.timeout(5_000) },
        );
        assert.equal(files.status, 200);
        assert.equal((await files.json()).files.length, 1);
      });
    }
  },
);
