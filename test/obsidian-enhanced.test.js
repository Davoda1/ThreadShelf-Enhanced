import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { useTempVault, trySymlink } from './shared/vault-env.js';
import {
  getVaultConfig,
  getVaultRegistry,
  saveVaultConfig,
  selectVault,
  setVaultWritePermission,
} from '../src/obsidian/config.js';
import {
  createVaultNote,
  editVaultNote,
  inVault,
  readVaultNote,
  searchVault,
} from '../src/obsidian/vault.js';
import {
  requestVaultWrite,
  requestVaultDeletion,
  decideVaultDeletion,
} from '../src/obsidian/approvals.js';
import { callVaultTool } from '../src/obsidian/tools.js';
import router from '../src/routes/obsidian.js';
const ctx = useTempVault();
const proposal = (input, controller = new AbortController(), emit) => {
  let eventResolve;
  const event = new Promise((resolve) => {
    eventResolve = resolve;
  });
  const finished = requestVaultWrite(
    input,
    'synthetic-model',
    (value) => {
      eventResolve(value.approval);
      return emit?.(value);
    },
    controller.signal,
  );
  return { event, finished, controller };
};
const approve = (approval) =>
  decideVaultDeletion(approval.id, { token: approval.token, approve: true, acknowledged: true });

describe('Enhanced connected note scopes', () => {
  it('serializes policy writes in call order and resumes after a rejected update', async () => {
    for (let round = 0; round < 12; round++) {
      const choices = [true, false, true, false, true];
      await Promise.all(choices.map((allowWrites) => setVaultWritePermission(allowWrites)));
      assert.equal((await getVaultConfig()).allowWrites, true);
    }
    const failed = setVaultWritePermission(false, 'missing-vault');
    const next = setVaultWritePermission(false);
    await assert.rejects(failed, /Connect/);
    await next;
    assert.equal((await getVaultConfig()).allowWrites, false);
  });

  it('retains separate write policies and stable identities when switching folders', async () => {
    const first = (await getVaultRegistry()).vaults[0];
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    await saveVaultConfig({ vaultPath: other });
    const second = (await getVaultRegistry()).vaults.find((vault) => vault.id !== first.id);
    assert.equal(second.allowWrites, false);
    assert.equal((await getVaultConfig(first.id)).allowWrites, true);
    await selectVault(first.id);
    assert.equal((await getVaultConfig()).vaultPath, first.vaultPath);
    assert.equal((await getVaultRegistry()).vaults.length, 2);
  });
  it('keeps a folder selection ahead of its immediately following permission change', async () => {
    await setVaultWritePermission(false);
    const first = (await getVaultRegistry()).vaults[0];
    const other = join(ctx.temporary, 'queued-selection');
    await mkdir(other);
    await Promise.all([saveVaultConfig({ vaultPath: other }), setVaultWritePermission(true)]);
    assert.equal((await getVaultConfig()).vaultPath, other);
    assert.equal((await getVaultConfig()).allowWrites, true);
    assert.equal((await getVaultConfig(first.id)).allowWrites, false);
  });
  it('pins one connected root while another tab changes its active selection', async () => {
    const first = (await getVaultRegistry()).vaults[0];
    await createVaultNote('first.md', 'first');
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    await saveVaultConfig({ vaultPath: other });
    assert.equal(
      (await inVault(first.vaultPath, () => readVaultNote('first.md'))).content,
      'first',
    );
    await assert.rejects(readVaultNote('first.md'), /unavailable/);
    await setVaultWritePermission(false, first.id);
    await assert.rejects(
      inVault(first.vaultPath, () => createVaultNote('blocked.md', 'x')),
      /read-only/,
    );
    await selectVault(first.id);
    await saveVaultConfig({ vaultPath: '' });
    await assert.rejects(
      inVault(first.vaultPath, () => readVaultNote('first.md')),
      /disconnected/,
    );
  });
  it('keeps headings and line references in live search results', async () => {
    await createVaultNote('Projects/live.md', '# Main\ntext\n## Details\nneedle\n');
    const first = await searchVault('needle');
    assert.equal(first.hits[0].line, 4);
    assert.equal(first.hits[0].heading, 'Details');
    await writeFile(join(ctx.vault, 'Projects/live.md'), '# Main\nchanged');
    assert.equal((await searchVault('needle')).hits.length, 0);
    assert.equal((await searchVault('changed')).hits.length, 1);
  });
});
describe('Enhanced write safety and recovery', () => {
  it('retains the exact pre-edit text and metadata outside search', async () => {
    const original = await createVaultNote(
      'Projects/a.md',
      '\uFEFF---\nname: test\n---\n# Before\n',
    );
    await editVaultNote(original.path, '# After\n', original.revision);
    const folder = join(ctx.vault, '.threadshelf-history');
    const entries = await readdir(folder);
    assert.equal(entries.length, 1);
    const backup = JSON.parse(await readFile(join(folder, entries[0]), 'utf8'));
    assert.deepEqual(backup, {
      path: original.path,
      revision: original.revision,
      content: original.content,
    });
    assert.equal((await searchVault('Before')).hits.length, 0);
  });
  it('refuses invalid UTF-8 and NUL notes instead of rewriting lossy text', async () => {
    await writeFile(join(ctx.vault, 'invalid.md'), Buffer.from([0xff, 0xfe, 0x61]));
    await writeFile(join(ctx.vault, 'binary.md'), 'abc\0def');
    await assert.rejects(readVaultNote('invalid.md'), /UTF-8/);
    await assert.rejects(readVaultNote('binary.md'), /NUL/);
    assert.equal((await searchVault('abc')).skipped, 2);
  });
  it('does not edit when a history path is a symlink', async (t) => {
    const before = await createVaultNote('a.md', 'original');
    const outside = join(ctx.temporary, 'outside');
    await mkdir(outside);
    if (!(await trySymlink(outside, join(ctx.vault, '.threadshelf-history'), 'dir')))
      return t.skip('symlinks unavailable');
    await assert.rejects(editVaultNote('a.md', 'replacement', before.revision), /Unsafe/);
    assert.equal((await readVaultNote('a.md')).content, 'original');
    assert.deepEqual(await readdir(outside), []);
  });
});
describe('Human-reviewed vault writes', () => {
  it('emits exact content and requires a capability plus acknowledgement before creating', async () => {
    const pending = proposal({ operation: 'create', path: 'new.md', content: '# New' });
    const event = await pending.event;
    assert.equal(event.operation, 'create');
    assert.equal(event.before, '');
    assert.equal(event.after, '# New');
    await assert.rejects(readVaultNote('new.md'));
    await assert.rejects(
      decideVaultDeletion(event.id, { token: 'f'.repeat(64), approve: true, acknowledged: true }),
      /token/,
    );
    await assert.rejects(
      decideVaultDeletion(event.id, { token: event.token, approve: true }),
      /confirmation/,
    );
    await approve(event);
    const result = await pending.finished;
    assert.equal(result.created, true);
    assert.equal((await readVaultNote('new.md')).content, '# New');
    assert.equal('token' in result, false);
    await assert.rejects(approve(event), /expired/);
  });
  it('rejects stale edit revisions after the human preview', async () => {
    const note = await createVaultNote('a.md', 'before');
    const pending = proposal({
      operation: 'edit',
      path: 'a.md',
      content: 'proposed',
      revision: note.revision,
    });
    const event = await pending.event;
    assert.equal(event.before, 'before');
    await writeFile(join(ctx.vault, 'a.md'), 'external edit');
    await assert.rejects(approve(event), /changed/);
    assert.match((await pending.finished).error, /changed/);
    assert.equal((await readVaultNote('a.md')).content, 'external edit');
  });
  it('rechecks write permission and connected root at approval time', async () => {
    const pending = proposal({ operation: 'create', path: 'new.md', content: 'x' });
    const event = await pending.event;
    await setVaultWritePermission(false);
    await assert.rejects(approve(event), /read-only/);
    assert.match((await pending.finished).error, /read-only/);
    await assert.rejects(readVaultNote('new.md'));
  });
  it('cancels a pending approval on disconnect and rejects the old capability', async () => {
    const pending = proposal({ operation: 'create', path: 'new.md', content: 'x' });
    const event = await pending.event;
    pending.controller.abort();
    assert.equal((await pending.finished).cancelled, true);
    await assert.rejects(approve(event), /expired/);
    await assert.rejects(readVaultNote('new.md'));
  });
  it('cleans up a capability when its async channel fails', async () => {
    const pending = proposal(
      { operation: 'create', path: 'new.md', content: 'x' },
      undefined,
      async () => {
        throw new Error('channel closed');
      },
    );
    const event = await pending.event;
    await assert.rejects(pending.finished, /channel closed/);
    await assert.rejects(approve(event), /expired/);
  });
  it('chat cannot bypass preview by omitting its write callback, while MCP keeps explicit policy', async () => {
    await assert.rejects(
      callVaultTool(
        'obsidian_create',
        { path: 'x.md', content: 'x' },
        { signal: new AbortController().signal, requestDelete: async () => ({}) },
      ),
      /approval/,
    );
    assert.equal(
      (await callVaultTool('obsidian_create', { path: 'x.md', content: 'x' })).created,
      true,
    );
  });
  it('trash includes a mapping back to the exact original paths', async () => {
    await createVaultNote('Projects/same.md', 'one');
    await createVaultNote('same.md', 'two');
    let eventResolve;
    const event = new Promise((r) => {
      eventResolve = r;
    });
    const finished = requestVaultDeletion(
      ['Projects/same.md', 'same.md'],
      'synthetic-model',
      (value) => {
        eventResolve(value.approval);
      },
      new AbortController().signal,
    );
    await approve(await event);
    const result = await finished;
    const manifest = JSON.parse(
      await readFile(join(ctx.vault, result.trash, 'manifest.json'), 'utf8'),
    );
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ['Projects/same.md', 'same.md'],
    );
    for (const file of manifest.files)
      assert.ok(await readFile(join(ctx.vault, result.trash, file.storedAs), 'utf8'));
  });
});
describe('Live note HTTP routes', () => {
  it('pins a vault by id and preserves structured errors and revision checks', async () => {
    await createVaultNote('a.md', '# first');
    const first = (await getVaultRegistry()).vaults[0];
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    await saveVaultConfig({ vaultPath: other });
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/obsidian`;
      const note = await (await fetch(`${base}/note?path=a.md&vaultId=${first.id}`)).json();
      assert.equal(note.content, '# first');
      const edited = await fetch(`${base}/note?vaultId=${first.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.md', content: '# changed', revision: note.revision }),
      });
      assert.equal(edited.status, 200);
      const stale = await fetch(`${base}/note?vaultId=${first.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.md', content: 'old', revision: note.revision }),
      });
      assert.equal(stale.status, 409);
      assert.equal((await fetch(`${base}/note?path=a.md&vaultId=missing`)).status, 400);
      assert.equal(
        (await fetch(`${base}/note?path=a.md`, { headers: { 'x-forwarded-for': '203.0.113.1' } }))
          .status,
        403,
      );
    } finally {
      server.close();
      server.closeAllConnections();
      await once(server, 'close');
    }
  });
});
