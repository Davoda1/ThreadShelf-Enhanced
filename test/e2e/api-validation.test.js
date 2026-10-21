/**
 * End-to-end validation tests for the HTTP API. We boot the server once and
 * fire a battery of malformed requests to confirm:
 *   - validation errors return HTTP 400 with `{ error, field? }`
 *   - API routes reject cross-site origins and rebinding-style Host headers
 *   - the server never crashes (process stays up across all probes)
 *   - traversal-y inputs cannot escape the configured sandbox
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { startApiServer } from './helpers.js';

const getJsonWithHeaders = (baseUrl, path, headers) => {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: raw ? JSON.parse(raw) : {},
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
};

describe('API validation E2E', () => {
  it(
    'rejects malformed and cross-site inputs while staying healthy',
    { timeout: 180_000 },
    async () => {
      const ctx = await startApiServer({
        prefix: 'threadshelf-validation-',
        env: { ALLOWED_HOSTS: 'allowed.test' },
      });

      try {
        let res = await fetch(`${ctx.baseUrl}/api/search`);
        let body = await res.json();
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.match(body.error, /Missing q/i);

        res = await fetch(`${ctx.baseUrl}/api/search?q=hi&n=-1`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/search?q=hi&n=999`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/search?q=hi&n=abc`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/search?q=hi&roles=user,system`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/search?q=hi&keywordBoost=maybe`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/search?q=hi&from=2026-02-01&to=2026-01-01`);
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/collections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/collections`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'all' }),
        });
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/collections/all/clear`, { method: 'POST' });
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/collections/chunks`, { method: 'DELETE' });
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/thread`);
        assert.strictEqual(res.status, 400);

        res = await fetch(
          `${ctx.baseUrl}/api/thread?sourceFile=${encodeURIComponent('/nope/not-indexed.json')}&collection=chunks`,
        );
        assert.strictEqual(res.status, 404);

        res = await fetch(
          `${ctx.baseUrl}/api/thread?sourceFile=${encodeURIComponent('x'.repeat(5000))}`,
        );
        assert.strictEqual(res.status, 400);

        res = await fetch(`${ctx.baseUrl}/api/ingest-preview`);
        assert.strictEqual(res.status, 400);

        res = await fetch(
          `${ctx.baseUrl}/api/ingest-progress?folderPath=${encodeURIComponent(ctx.tempRoot)}`,
        );
        assert.strictEqual(res.status, 404);

        res = await fetch(`${ctx.baseUrl}/api/ingest-progress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clearFirst: 'maybe' }),
        });
        body = await res.json();
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.strictEqual(body.field, 'clearFirst');

        const formData = new FormData();
        formData.append('clearFirst', 'maybe');
        formData.append(
          'conversation.json',
          new Blob(['{}'], { type: 'application/json' }),
          'conversation.json',
        );
        res = await fetch(`${ctx.baseUrl}/api/ingest-upload-progress`, {
          method: 'POST',
          body: formData,
        });
        body = await res.json();
        assert.strictEqual(res.status, 400, JSON.stringify(body));
        assert.strictEqual(body.field, 'clearFirst');
        const incoming = await readdir(join(ctx.tempRoot, '.uploads', '.incoming'));
        assert.deepStrictEqual(incoming, []);

        let raw = await getJsonWithHeaders(ctx.baseUrl, '/api/health', {
          Origin: 'https://example.invalid',
        });
        assert.strictEqual(raw.status, 403, JSON.stringify(raw.body));
        assert.match(raw.body.error, /Forbidden origin/);

        raw = await getJsonWithHeaders(ctx.baseUrl, '/api/health', {
          Host: 'evil.example',
        });
        assert.strictEqual(raw.status, 403, JSON.stringify(raw.body));
        assert.match(raw.body.error, /Forbidden host/);

        raw = await getJsonWithHeaders(ctx.baseUrl, '/api/health', {
          Host: 'allowed.test',
          Origin: 'http://allowed.test',
        });
        assert.strictEqual(raw.status, 200, JSON.stringify(raw.body));
        assert.strictEqual(raw.body.ok, true);

        res = await fetch(`${ctx.baseUrl}/api/health`);
        assert.strictEqual(res.headers.get('access-control-allow-origin'), null);

        res = await fetch(`${ctx.baseUrl}/api/does-not-exist`);
        body = await res.json();
        assert.strictEqual(res.status, 404, JSON.stringify(body));
        assert.strictEqual(body.error, 'Not found');

        res = await fetch(`${ctx.baseUrl}/api/health`);
        assert.strictEqual(res.ok, true);
      } catch (e) {
        e.message += `\nServer output:\n${ctx.output.join('')}`;
        throw e;
      } finally {
        await ctx.stop();
      }
    },
  );
});
