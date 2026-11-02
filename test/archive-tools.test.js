import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'archive-tool-test-'));
process.env.LANCEDB_PATH = join(root, 'db');
process.env.COLLECTIONS_PATH = join(root, 'collections.json');
const { replaceThreadsForFile } = await import('../src/store.js');
const { closeStoragePublication } = await import('../src/storage-publication.js');
const { addManualCollection } = await import('../src/services/collections.js');
const { callArchiveTool, archiveSourceHref } = await import('../src/generation/archive-tools.js');
const { generateKnowledgeChat } = await import('../src/generation/obsidian-agent.js');
const { setGenerationProviderForTests } = await import('../src/generation/registry.js');
after(async () => {
  closeStoragePublication();
  await rm(root, { recursive: true, force: true });
});
it('reads only exact stored references, excludes reasoning and pages a long turn without losing its tail', async () => {
  await addManualCollection('fixture');
  await replaceThreadsForFile('fixture', '/synthetic/export.json', 'openai', [
    {
      key: 'thread',
      title: 'Test',
      turns: [
        { user: 'hello' },
        { thinking: 'NEVER_SEND_REASONING' },
        { ai: 'x'.repeat(100_000) + 'the tail' },
      ],
    },
  ]);
  const args = {
    collection: 'fixture',
    sourceFile: '/synthetic/export.json',
    conversationKey: 'thread',
  };
  const first = await callArchiveTool('archive_read', args);
  assert.equal(first.turns.length, 2);
  assert.equal(first.nextTurn, 2);
  assert.equal(first.nextTextOffset, 99995);
  assert.equal(JSON.stringify(first).includes('NEVER_SEND_REASONING'), false);
  const next = await callArchiveTool('archive_read', {
    ...args,
    startTurn: first.nextTurn,
    textOffset: first.nextTextOffset,
  });
  assert.equal(next.turns[0].text, 'xxxxxthe tail');
  assert.equal(next.nextTurn, null);
  await assert.rejects(
    callArchiveTool('archive_read', { ...args, sourceFile: '/etc/passwd' }),
    /not found/,
  );
  await assert.rejects(callArchiveTool('archive_read', { ...args, collection: 'all' }), /exact/);
});
it('buffered knowledge workflow retains tool state only between rounds, and does not emit token deltas', async () => {
  const requests = [];
  let deltas = 0;
  const restore = setGenerationProviderForTests('llama-cpp', {
    chat: async (request) => {
      requests.push(structuredClone(request));
      return requests.length === 1
        ? {
            provider: 'llama-cpp',
            model: 'fixture',
            content: '',
            toolCalls: [
              {
                id: 'a',
                type: 'function',
                function: {
                  name: 'archive_read',
                  arguments: JSON.stringify({
                    collection: 'fixture',
                    sourceFile: '/synthetic/export.json',
                    conversationKey: 'thread',
                  }),
                },
              },
            ],
            reasoningDetails: [{ type: 'opaque', data: 'TRANSIENT' }],
          }
        : { provider: 'llama-cpp', model: 'fixture', content: 'Source-based response' };
    },
  });
  try {
    const result = await generateKnowledgeChat(
      {
        provider: 'llama-cpp',
        model: 'fixture',
        messages: [
          { role: 'system', content: 'Master' },
          { role: 'user', content: 'Read my source' },
        ],
      },
      () => {
        deltas++;
      },
      () => {},
      new AbortController().signal,
      { useArchive: true, streamOutput: false },
    );
    assert.equal(result.content, 'Source-based response');
    assert.equal(deltas, 0);
    assert.equal(result.reasoningDetails, undefined);
    assert.equal(requests[1].messages.filter((x) => x.role === 'system').length, 1);
    assert.ok(requests[1].messages.find((x) => x.reasoning_details));
    assert.equal(JSON.stringify(requests[1]).includes('NEVER_SEND_REASONING'), false);
    assert.equal(
      JSON.parse(requests[1].messages.find((x) => x.role === 'tool').content).error,
      undefined,
    );
    assert.equal(
      requests[0].tools.some((x) => x.function.name.startsWith('obsidian_')),
      false,
    );
  } finally {
    restore();
  }
});

it('preserves empty legacy conversation keys and whitespace in exact archive identity', async () => {
  await addManualCollection('identity');
  await replaceThreadsForFile('identity', ' /synthetic/spaced.json ', 'openai', [
    { key: '', title: 'Legacy', turns: [{ ai: 'Legacy content' }] },
    { key: ' key ', title: 'Spaced', turns: [{ ai: 'Spaced key content' }] },
  ]);
  const first = await callArchiveTool('archive_read', {
    collection: 'identity',
    sourceFile: ' /synthetic/spaced.json ',
    conversationKey: '',
  });
  assert.equal(first.turns[0].text, 'Legacy content');
  assert.equal(first.reference.conversationKey, '');
  const second = await callArchiveTool('archive_read', {
    collection: 'identity',
    sourceFile: ' /synthetic/spaced.json ',
    conversationKey: ' key ',
  });
  assert.equal(second.turns[0].text, 'Spaced key content');
  const controller = new AbortController();
  controller.abort(new Error('cancelled search'));
  await assert.rejects(
    callArchiveTool('archive_search', { query: 'x', mode: 'keyword' }, controller.signal),
    /cancelled search/,
  );
});

it('constructs same-origin source links that preserve dangerous and JSON-looking opaque identities', () => {
  for (const reference of [
    {
      collection: 'fixture',
      sourceFile: 'javascript:alert(1)&next=https://example.test/#x',
      conversationKey: '"</a><script>evil</script>"',
      turnIndex: 7,
    },
    { collection: '123', sourceFile: 'true', conversationKey: '0', turnIndex: '2' },
    { collection: 'fixture', sourceFile: ' /synthetic/with space.json ', conversationKey: '' },
  ]) {
    const href = archiveSourceHref(reference),
      url = new URL(href, 'http://127.0.0.1:3000');
    assert.equal(url.origin, 'http://127.0.0.1:3000');
    assert.equal(url.pathname, '/thread');
    assert.equal(url.hash, '');
    assert.equal(JSON.parse(url.searchParams.get('collection')), reference.collection);
    assert.equal(JSON.parse(url.searchParams.get('sourceFile')), reference.sourceFile);
    assert.equal(JSON.parse(url.searchParams.get('conversationKey')), reference.conversationKey);
    if (reference.turnIndex !== undefined)
      assert.equal(JSON.parse(url.searchParams.get('matchIdx')), Number(reference.turnIndex));
  }
});
