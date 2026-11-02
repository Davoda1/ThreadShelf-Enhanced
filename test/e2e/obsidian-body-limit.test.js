import { before, after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
let ctx, vault;
before(async () => {
  ctx = await startApiServer({ prefix: 'notes-body-limit-' });
  vault = join(ctx.tempRoot, 'vault');
  await mkdir(vault);
  const response = await fetch(`${ctx.baseUrl}/api/obsidian/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vaultPath: vault, allowWrites: true }),
  });
  assert.equal(response.status, 200);
});
after(async () => {
  await ctx?.stop();
});
const write = (path, content, revision) =>
  fetch(`${ctx.baseUrl}/api/obsidian/note`, {
    method: revision ? 'PUT' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, ...(revision ? { revision } : {}) }),
  });
it('creates and edits the maximum valid UTF-8 note including worst-case JSON escaping', async () => {
  const plain = 'x'.repeat(512 * 1024);
  const created = await write('maximum.md', plain);
  assert.equal(created.status, 201);
  const revision = (await created.json()).revision;
  const escaped = '\x01'.repeat(512 * 1024);
  const edited = await write('maximum.md', escaped, revision);
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).content, escaped);
  assert.equal(await readFile(join(vault, 'maximum.md'), 'utf8'), escaped);
});
it('rejects oversized note content and leaves the generic API body limit unchanged', async () => {
  const oversized = await write('too-large.md', 'x'.repeat(512 * 1024 + 1));
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).error, /512 KiB/);
  const generic = await fetch(`${ctx.baseUrl}/api/generation/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(512 * 1024) }),
  });
  assert.equal(generic.status, 413);
});
