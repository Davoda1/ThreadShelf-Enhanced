import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader, TextReader } from '@zip.js/zip.js';
import { parseEnhancedDocument, importEnhancedFile } from '../src/enhanced-import/index.js';
import { parseConversationGroups } from '../src/parser.js';

// All records in this file are synthetic. Files are temporary and never enter
// the user's uploads directory or database.
const temp = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'threadshelf-enhanced-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

const write = async (directory, name, value) => {
  const filename = join(directory, name);
  await writeFile(
    filename,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  );
  return filename;
};

const archive = async (entries, options = {}) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    ...options,
  });
  for (const [name, value] of entries) {
    const reader = Buffer.isBuffer(value)
      ? new Uint8ArrayReader(new Uint8Array(value))
      : new TextReader(typeof value === 'string' ? value : JSON.stringify(value));
    await writer.add(name, reader, { level: 0, ...options });
  }
  return Buffer.from(await writer.close());
};

const chat = (id = 'synthetic-chat') => ({
  id,
  title: 'Synthetic Unicode conversation 日本語 🐱',
  current_node: 'answer',
  mapping: {
    root: { id: 'root', parent: null, message: null },
    user: {
      id: 'user',
      parent: 'root',
      message: {
        id: 'user-message',
        author: { role: 'user' },
        create_time: 1780000000,
        content: { content_type: 'text', parts: ['  Exact prompt\n\n日本語 🐱  '] },
      },
    },
    empty: {
      id: 'empty',
      parent: 'user',
      message: { author: { role: 'assistant' }, content: { parts: [''] } },
    },
    thought: {
      id: 'thought',
      parent: 'empty',
      message: {
        id: 'thought-message',
        author: { role: 'assistant' },
        channel: 'analysis',
        content: { parts: ['Reasoning'] },
      },
    },
    tool: {
      id: 'tool',
      parent: 'thought',
      message: {
        id: 'tool-message',
        author: { role: 'tool', name: 'browser' },
        content: { parts: ['Tool result'] },
      },
    },
    answer: {
      id: 'answer',
      parent: 'tool',
      message: {
        id: 'answer-message',
        author: { role: 'assistant' },
        channel: 'final',
        content: { parts: ['Answer citeturn0search0\n```js\nconst x = 1;\n```\n'] },
        metadata: {
          model_slug: 'synthetic-model',
          content_references: [
            { type: 'webpage', url: 'https://example.com/source', title: 'Source' },
          ],
          future_field: { preserved: true },
        },
      },
    },
    alternate: {
      id: 'alternate',
      parent: 'user',
      message: { author: { role: 'assistant' }, content: { parts: ['Unselected alternative'] } },
    },
  },
});

// A synthetic one-pixel raster is sufficient to verify attachment integrity;
// there is no network-dependent fixture or real exported media in the suite.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const pngDataUrl = `data:image/png;base64,${png.toString('base64')}`;
const withImage = (source) => {
  const input = chat('image');
  input.mapping.answer.message.content = {
    content_type: 'multimodal_text',
    parts: [{ content_type: 'image_asset_pointer', asset_pointer: source }],
  };
  return input;
};

test('enhanced ChatGPT import preserves active branch, source slots, exact text and references', () => {
  const input = chat();
  const [conversation] = parseEnhancedDocument(input, 'conversations.json');
  assert.equal(conversation.key, 'openai:synthetic-chat');
  assert.equal(conversation.provider, 'openai');
  assert.deepEqual(conversation.raw, input);
  assert.deepEqual(
    conversation.turns.map((turn) => turn.turn_index),
    [1, 3, 4, 5],
  );
  assert.equal(conversation.turns[0].user, input.mapping.user.message.content.parts[0]);
  assert.equal(conversation.turns[0].createdAt, '2026-05-28T20:26:40.000Z');
  assert.equal(conversation.turns[1].thinking, 'Reasoning');
  assert.equal(conversation.turns[1].channel, 'analysis');
  assert.equal(conversation.turns[2].source_role, 'tool');
  const answer = conversation.turns[3];
  assert.equal(answer.ai, input.mapping.answer.message.content.parts[0]);
  assert.equal(answer.source_message_id, 'answer-message');
  assert.equal(answer.source_node_id, 'answer');
  assert.deepEqual(answer.metadata, input.mapping.answer.message.metadata);
  assert.deepEqual(answer.raw, input.mapping.answer.message);
  assert.ok(!conversation.turns.some((turn) => turn.ai === 'Unselected alternative'));
});

test('enhanced imports keep the legacy v1.3 conversation keys for existing native fixtures', async () => {
  for (const name of [
    'openai-polish.json',
    'anthropic-polish.json',
    'anthropic-project-snapshot.json',
    'gemini-polish.json',
    'gemini-imagen.json',
    'openrouter-polish.json',
    'lmstudio-polish.json',
    'lmstudio-versions-snapshot.json',
    'grok-polish.json',
  ]) {
    const input = JSON.parse(
      await readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8'),
    );
    const legacy = parseConversationGroups(input);
    assert.equal(legacy.error, undefined, name);
    assert.deepEqual(
      parseEnhancedDocument(input, name).map((conversation) => conversation.key),
      legacy.conversations.map((conversation) => conversation.key),
      name,
    );
  }
});

test('normalized Local Reader threads keep exact identity, continuation metadata and combined source indexes', () => {
  const original = {
    provider: 'openai',
    conversationKey: 'custom-reader-key',
    title: 'Existing Local Reader thread',
    turns: [
      { user: 'Prompt', turn_index: 2, source_message_id: 'p', futureProperty: 'keep me' },
      { thinking: 'Thought', ai: 'Answer', turn_index: 9, metadata: { detail: 1 } },
      {
        ai: 'Local continuation',
        turn_index: 10,
        createdInThreadShelf: true,
        generationProvider: 'llama-cpp',
      },
    ],
  };
  const [conversation] = parseEnhancedDocument(original);
  assert.equal(conversation.key, original.conversationKey);
  assert.equal(conversation.turns[0].futureProperty, 'keep me');
  assert.deepEqual(
    conversation.turns.map((turn) => turn.turn_index),
    [2, 9, 9, 10],
  );
  assert.equal(conversation.turns[1].thinking, 'Thought');
  assert.equal(conversation.turns[2].ai, 'Answer');
  assert.deepEqual(conversation.turns[2].metadata, { detail: 1 });
  assert.equal(conversation.turns[3].createdInThreadShelf, true);
  assert.equal(conversation.turns[3].generationProvider, 'llama-cpp');
  assert.deepEqual(conversation.raw, original);
});

test('bare normalized CLI turns and system messages retain content without inventing a user role', () => {
  const [normalized] = parseEnhancedDocument([
    { user: 'Question' },
    { thinking: 'Thought', ai: 'Answer' },
  ]);
  assert.equal(normalized.provider, 'threadshelf');
  assert.equal(normalized.turns.length, 3);
  const input = chat('system');
  input.mapping.user.message.author.role = 'system';
  const [conversation] = parseEnhancedDocument(input);
  assert.equal(conversation.turns[0].source_role, 'system');
  assert.equal(conversation.turns[0].ai, input.mapping.user.message.content.parts[0]);
});

test('ChatGPT Export Processor HTML imports strict JSON without executing scripts or converting text again', async (t) => {
  const directory = await temp(t);
  const input = chat('processor');
  const text =
    '[Reference](https://example.com/)\n```mermaid\nflowchart TD; A-->B\n```\n<script>literal</script>';
  input.mapping.answer.message.content.parts = [text];
  const embedded = JSON.stringify([input]).replaceAll('<', '\\u003c');
  const filename = await write(
    directory,
    'chat-index.html',
    `<html><script>const jsonData = ${embedded}; globalThis.THREADSHELF_TEST_EXECUTED = true;</script></html>`,
  );
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].key, 'openai:processor');
  assert.equal(result.conversations[0].turns.at(-1).ai, text);
  assert.equal(globalThis.THREADSHELF_TEST_EXECUTED, undefined);
  assert.equal(
    await readFile(filename, 'utf8'),
    `<html><script>const jsonData = ${embedded}; globalThis.THREADSHELF_TEST_EXECUTED = true;</script></html>`,
  );
});

test('HTML containing only executable code is diagnosed without evaluation', async (t) => {
  const directory = await temp(t);
  const filename = await write(
    directory,
    'bad.html',
    '<html><script>globalThis.THREADSHELF_TEST_EXECUTED=true; const jsonData = (() => [])();</script></html>',
  );
  const result = await importEnhancedFile(filename);
  assert.equal(result.conversations.length, 0);
  assert.match(result.diagnostics.join('\n'), /JSON|recognized|array/i);
  assert.equal(globalThis.THREADSHELF_TEST_EXECUTED, undefined);
});

test('streamed JSON preserves identities and raw data exactly as the small-file adapter', async (t) => {
  const directory = await temp(t);
  const input = [chat('stream-one'), chat('stream-two')];
  const filename = await write(directory, 'conversations-index.json', input);
  const streamed = await importEnhancedFile(filename, { limits: { streamingThreshold: 0 } });
  assert.deepEqual(streamed.diagnostics, []);
  assert.deepEqual(streamed.conversations, parseEnhancedDocument(input, filename));
});

test('empty conversation slots do not renumber legacy positional keys during streaming', async (t) => {
  const directory = await temp(t);
  const cases = [
    [
      { chat_messages: [] },
      { chat_messages: [{ sender: 'human', text: 'Anthropic positional prompt' }] },
    ],
    [
      { mapping: {} },
      {
        mapping: {
          u: {
            id: 'u',
            parent: null,
            message: { author: { role: 'user' }, content: { parts: ['OpenAI positional prompt'] } },
          },
        },
        current_node: 'u',
      },
    ],
    {
      conversations: [
        { conversation: {}, responses: [] },
        {
          conversation: {},
          responses: [{ response: { sender: 'human', message: 'Grok positional prompt' } }],
        },
      ],
    },
  ];
  for (const [index, input] of cases.entries()) {
    const expected = parseConversationGroups(input).conversations.map(
      (conversation) => conversation.key,
    );
    assert.equal(expected.length, 1);
    const filename = await write(directory, `empty-slots-${index}.json`, input);
    assert.deepEqual(
      parseEnhancedDocument(input, filename).map((conversation) => conversation.key),
      expected,
    );
    for (const streamingThreshold of [0, 1024 * 1024]) {
      const result = await importEnhancedFile(filename, { limits: { streamingThreshold } });
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(
        result.conversations.map((conversation) => conversation.key),
        expected,
      );
    }
  }
});

test('truncated and trailing JSON never returns a partially validated conversation', async (t) => {
  const directory = await temp(t);
  for (const [index, tail] of [',]', '] trailing', ',{"broken":}', ''].entries()) {
    const filename = await write(
      directory,
      `broken-${index}.json`,
      '[' + JSON.stringify(chat()) + tail,
    );
    const result = await importEnhancedFile(filename, { limits: { streamingThreshold: 0 } });
    assert.equal(result.conversations.length, 0, tail);
    assert.ok(result.diagnostics.length > 0, tail);
  }
});

test('UTF-16 BOM exports preserve multilingual content and original raw IDs', async (t) => {
  const directory = await temp(t);
  const input = [chat('utf16')];
  const filename = await write(
    directory,
    'utf16.json',
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(input), 'utf16le')]),
  );
  const result = await importEnhancedFile(filename, { limits: { streamingThreshold: 0 } });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.conversations, parseEnhancedDocument(input, filename));
});

test('ZIP64 imports validate CRC before returning any streamed conversations', async (t) => {
  const directory = await temp(t);
  const bytes = await archive([['conversations.json', [chat('zip-one'), chat('zip-two')]]], {
    zip64: true,
  });
  const filename = await write(directory, 'export.zip', bytes);
  const result = await importEnhancedFile(filename, { limits: { streamingThreshold: 0 } });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.key),
    ['conversations.json::openai:zip-one', 'conversations.json::openai:zip-two'],
  );
  const corrupt = Buffer.from(bytes);
  const textAt = corrupt.indexOf(Buffer.from('Tool result'));
  assert.ok(textAt > 0);
  corrupt[textAt] = 'X'.charCodeAt(0);
  const bad = await write(directory, 'corrupt.zip', corrupt);
  const failed = await importEnhancedFile(bad, { limits: { streamingThreshold: 0 } });
  assert.equal(failed.conversations.length, 0);
  assert.match(failed.diagnostics.join('\n'), /signature|crc/i);
  assert.deepEqual((await readdir(directory)).sort(), ['corrupt.zip', 'export.zip']);
});

test('ZIP members with the same legacy key remain separate and retain their portable source identity', async (t) => {
  const directory = await temp(t);
  const first = { chunkedPrompt: { chunks: [{ role: 'user', text: 'First prompt' }] } };
  const second = { chunkedPrompt: { chunks: [{ role: 'user', text: 'Second prompt' }] } };
  const filename = await write(
    directory,
    'many.zip',
    await archive([
      ['first/ai-studio.json', first],
      ['second/ai-studio.json', second],
    ]),
  );
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.key),
    ['first%2Fai-studio.json::google:0', 'second%2Fai-studio.json::google:0'],
  );
  assert.deepEqual(
    result.conversations.map((conversation) => conversation.sourceIdentity.originalConversationKey),
    ['google:0', 'google:0'],
  );
  assert.equal(result.conversations[0].turns[0].user, 'First prompt');
  assert.equal(result.conversations[1].turns[0].user, 'Second prompt');
  const again = await importEnhancedFile(filename, { limits: { streamingThreshold: 0 } });
  assert.deepEqual(
    again.conversations.map((conversation) => conversation.key),
    result.conversations.map((conversation) => conversation.key),
  );
});

test('ZIP rejects unsafe and duplicate normalized paths without extracting files', async (t) => {
  const directory = await temp(t);
  const cases = [
    [['../outside.json', chat()]],
    [
      ['folder/conversations.json', chat()],
      ['folder\\conversations.json', chat()],
    ],
  ];
  for (const [index, entries] of cases.entries()) {
    const filename = await write(directory, `unsafe-${index}.zip`, await archive(entries));
    const result = await importEnhancedFile(filename);
    assert.equal(result.conversations.length, 0);
    assert.match(result.diagnostics.join('\n'), /unsafe (?:path|filename)|duplicate entry/i);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['unsafe-0.zip', 'unsafe-1.zip']);
});

test('streaming limits reject excessive record size, record count and expanded ZIP bytes', async (t) => {
  const directory = await temp(t);
  const filename = await write(directory, 'limits.json', [chat('one'), chat('two')]);
  for (const limits of [
    { streamingThreshold: 0, recordBytes: 100 },
    { streamingThreshold: 0, records: 1 },
  ]) {
    const result = await importEnhancedFile(filename, { limits });
    assert.equal(result.conversations.length, 0);
    assert.match(result.diagnostics.join('\n'), /limit|too many/i);
  }
  const zip = await write(
    directory,
    'limits.zip',
    await archive([['conversations.json', [chat()]]]),
  );
  const result = await importEnhancedFile(zip, { limits: { expandedBytes: 10 } });
  assert.equal(result.conversations.length, 0);
  assert.match(result.diagnostics.join('\n'), /expanded-data|limit/i);
});

test('cancellation rejects promptly before reading source data', async (t) => {
  const directory = await temp(t);
  const filename = await write(directory, 'cancel.json', [chat()]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(importEnhancedFile(filename, { signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('cancellation during ZIP validation closes the input without returning partial results', async (t) => {
  const directory = await temp(t);
  const filename = await write(
    directory,
    'cancel-stream.zip',
    await archive([
      ['conversations.json', Array.from({ length: 120 }, (_, index) => chat(`cancel-${index}`))],
    ]),
  );
  const controller = new AbortController();
  let cancelledDuringValidation = false;
  await assert.rejects(
    importEnhancedFile(filename, {
      signal: controller.signal,
      limits: { streamingThreshold: 0 },
      onProgress(event) {
        if (event.phase === 'validating' && event.current === 100) {
          cancelledDuringValidation = true;
          controller.abort();
        }
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(cancelledDuringValidation, true);
  // A new read also exercises ZIP cleanup after cancellation, including Windows
  // where an incorrectly retained file handle prevents removal of the source.
  const recovered = await importEnhancedFile(filename, { limits: { streamingThreshold: 0 } });
  assert.equal(recovered.conversations.length, 120);
  assert.deepEqual(recovered.diagnostics, []);
  await rm(filename);
});

test('native Meta transcripts retain fenced speaker labels and exact unsafe integer IDs', async (t) => {
  const directory = await temp(t);
  const raw =
    '{"fbid":12345678901234567890123,"label_values":[{"label":"Conversation_09-17-2026.txt","value":"You: ```text\\nMeta AI: code, not speaker\\n```\\nMeta AI: Final answer\\n"}]}';
  const filename = await write(directory, 'meta.json', raw);
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations.length, 1);
  const conversation = result.conversations[0];
  assert.equal(conversation.provider, 'meta');
  assert.equal(conversation.turns.length, 2);
  assert.match(conversation.turns[0].user, /Meta AI: code, not speaker/);
  assert.equal(conversation.raw.source_account_id, '12345678901234567890123');
});

test('native Venice exports retain owner identity, tool relationships and separate reasoning', () => {
  const input = {
    format: 'venice-chat-history',
    formatVersion: 1,
    owners: [
      {
        ownerId: 'synthetic-owner',
        conversations: [
          {
            id: 'c',
            title: 'Venice',
            messages: [
              { id: 'u', role: 'user', content: 'Prompt' },
              { id: 'a', role: 'assistant', content: 'Answer', reasoningContent: 'Thought' },
              { id: 't', role: 'tool', parentMessageId: 'a', content: { result: 'Tool result' } },
            ],
          },
        ],
      },
    ],
  };
  const [conversation] = parseEnhancedDocument(input);
  assert.equal(conversation.provider, 'venice');
  assert.equal(conversation.key, 'venice:synthetic-owner:c');
  assert.equal(conversation.turns[1].thinking, 'Thought');
  assert.equal(conversation.turns[2].ai, 'Answer');
  assert.equal(conversation.turns[3].source_role, 'tool');
  assert.equal(conversation.turns[3].parent_message_id, 'a');
  assert.match(conversation.turns[3].ai, /Tool result/);
});

test('native Gemini JSON groups the same conversation and retains source card order', () => {
  const input = [
    {
      header: 'Gemini',
      title: 'Prompted First',
      titleUrl: 'https://gemini.google.com/app/synthetic',
      time: '2026-01-01T01:00:00Z',
      response: 'First answer',
    },
    {
      header: 'Gemini',
      title: 'Prompted Second',
      titleUrl: 'https://gemini.google.com/app/synthetic',
      time: '2026-01-01T02:00:00Z',
      response: 'Second answer',
    },
  ];
  const [conversation] = parseEnhancedDocument(input);
  assert.equal(conversation.provider, 'gemini');
  assert.equal(conversation.key, 'gemini:synthetic');
  assert.deepEqual(
    conversation.turns.map((turn) => turn.turn_index),
    [0, 0, 1, 1],
  );
  assert.equal(conversation.turns[0].user, 'First');
  assert.equal(conversation.turns[3].ai, 'Second answer');
  assert.deepEqual(conversation.raw.activities, input);
});

test('Gemini Takeout HTML remains inert and retains title, timestamp and source cards', async (t) => {
  const directory = await temp(t);
  const filename = await write(
    directory,
    'My Activity.html',
    '<html><body><div class="outer-cell" data-conversation-title="Exact title"><div class="header-cell">Gemini</div><div class="content-cell">Submitted prompt:&nbsp;Explain &lt;script&gt; text<br>Sep 17, 2026, 8:28:16 PM CEST<br><p>Answer <strong>bold</strong></p><pre>const value = 1;</pre><script>globalThis.THREADSHELF_TEST_EXECUTED=true</script></div><div class="content-cell mdl-typography--caption"><a href="https://gemini.google.com/app/synthetic123">Source</a></div></div></body></html>',
  );
  const result = await importEnhancedFile(filename);
  assert.equal(result.conversations.length, 1, JSON.stringify(result.diagnostics));
  const conversation = result.conversations[0];
  assert.equal(conversation.provider, 'gemini');
  assert.equal(conversation.title, 'Exact title');
  assert.equal(conversation.turns[0].createdAt, '2026-09-17T18:28:16.000Z');
  assert.match(conversation.turns[1].ai, /\*\*bold\*\*/);
  assert.match(conversation.turns[1].ai, /```/);
  assert.doesNotMatch(conversation.turns[1].ai, /THREADSHELF_TEST_EXECUTED/);
  assert.ok(conversation.raw.sourceCards.length);
  assert.equal(globalThis.THREADSHELF_TEST_EXECUTED, undefined);
});

test('unencrypted native Venice ZIP64 backup reconstructs conversation and message IDs locally', async (t) => {
  const directory = await temp(t);
  const zip = await archive(
    [
      [
        'manifest.json',
        {
          backupVersion: 4,
          encrypted: false,
          chunkCount: 1,
          databaseVersion: 4,
          ownerId: 'synthetic',
        },
      ],
      [
        'db/chunk-0.json',
        {
          formatName: 'dexie',
          formatVersion: 1,
          data: {
            databaseVersion: 4,
            data: [
              {
                tableName: 'conversations',
                inbound: true,
                rows: [{ id: 'c', ownerId: 'synthetic', title: 'Backup' }],
              },
              {
                tableName: 'messages',
                inbound: true,
                rows: [
                  {
                    id: 'u',
                    conversationId: 'c',
                    role: 'user',
                    content: 'Archive question 日本語',
                  },
                  { id: 'a', conversationId: 'c', role: 'assistant', content: 'Archive answer' },
                ],
              },
            ],
          },
        },
      ],
    ],
    { zip64: true },
  );
  const filename = await write(directory, 'venice.zip', zip);
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].key, 'venice:synthetic:c');
  assert.deepEqual(
    result.conversations[0].turns.map((turn) => turn.source_message_id),
    ['u', 'a'],
  );
  assert.equal(result.conversations[0].turns[1].ai, 'Archive answer');
});

test('relative Markdown raster images resolve locally while source text and raw records remain unchanged', async (t) => {
  const directory = await temp(t);
  const input = chat('local-image');
  const originalText = 'Before\n![Synthetic image](image.png)\nAfter';
  input.mapping.answer.message.content.parts = [originalText];
  await write(directory, 'image.png', png);
  const filename = await write(directory, 'conversations.json', [input]);
  const originalFile = await readFile(filename);
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  const conversation = result.conversations[0];
  const turn = conversation.turns.at(-1);
  assert.equal(turn.ai, originalText);
  assert.deepEqual(conversation.raw, input);
  assert.deepEqual(turn.raw, input.mapping.answer.message);
  assert.equal(turn.assets.length, 1);
  assert.equal(turn.assets[0].source, 'image.png');
  assert.equal(turn.assets[0].url, pngDataUrl);
  assert.deepEqual(await readFile(filename), originalFile);
});

test('unique ChatGPT file-service pointers resolve to bounded raster ZIP members', async (t) => {
  const directory = await temp(t);
  const source = 'file-service://file-image';
  const input = withImage(source);
  const filename = await write(
    directory,
    'media.zip',
    await archive([
      ['conversations.json', [input]],
      ['user-files/file-image.png', png],
    ]),
  );
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  const conversation = result.conversations[0];
  const turn = conversation.turns.at(-1);
  assert.match(turn.ai, /Image attachment/);
  assert.equal(turn.assets.length, 1);
  assert.equal(turn.assets[0].source, source);
  assert.equal(turn.assets[0].url, pngDataUrl);
  assert.deepEqual(conversation.raw, input);
  assert.deepEqual(turn.raw, input.mapping.answer.message);
  assert.deepEqual(await readdir(directory), ['media.zip']);
});

test('ambiguous ZIP attachment names stay unresolved instead of selecting the wrong image', async (t) => {
  const directory = await temp(t);
  const filename = await write(
    directory,
    'ambiguous.zip',
    await archive([
      ['conversations.json', [withImage('file-service://file-image')]],
      ['first/file-image.png', png],
      ['second/file-image.png', png],
    ]),
  );
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  const turn = result.conversations[0].turns.at(-1);
  assert.match(turn.ai, /Image attachment/);
  assert.equal(turn.assets?.length ?? 0, 0);
});

test('remote media references never trigger an import-time network request', async (t) => {
  const directory = await temp(t);
  let requested = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requested++;
    throw new Error('Network access is forbidden in this regression test');
  });
  const input = chat('remote-image');
  const text = '![Remote](https://example.com/image.png)';
  input.mapping.answer.message.content.parts = [
    text,
    { content_type: 'image_asset_pointer', asset_pointer: 'https://example.com/asset.png' },
  ];
  const filename = await write(directory, 'remote.json', input);
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(requested, 0);
  assert.match(result.conversations[0].turns.at(-1).ai, /https:\/\/example\.com\/image\.png/);
  assert.equal(result.conversations[0].turns.at(-1).assets?.length ?? 0, 0);
  assert.deepEqual(result.conversations[0].raw, input);
});

test('relative and encoded parent-directory attachment escapes stay unresolved', async (t) => {
  const directory = await temp(t);
  const selected = join(directory, 'selected');
  await mkdir(selected);
  await write(directory, 'outside.png', png);
  for (const [index, source] of [
    '../outside.png',
    '%2e%2e/outside.png',
    '..\\outside.png',
  ].entries()) {
    const input = withImage(source);
    const filename = await write(selected, `escape-${index}.json`, input);
    const result = await importEnhancedFile(filename);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.conversations[0].turns.at(-1).assets?.length ?? 0, 0, source);
    assert.deepEqual(result.conversations[0].raw, input);
  }
});

test('attachment symlinks outside the selected directory stay unresolved', async (t) => {
  const directory = await temp(t);
  const selected = join(directory, 'selected');
  await mkdir(selected);
  const outside = await write(directory, 'outside.png', png);
  try {
    await symlink(outside, join(selected, 'linked.png'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('Creating symlinks requires Windows developer mode or an elevated test process.');
      return;
    }
    throw error;
  }
  const filename = await write(selected, 'symlink.json', withImage('linked.png'));
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations[0].turns.at(-1).assets?.length ?? 0, 0);
});

test('SVG, HTML and raster filenames with non-raster bytes remain attachment placeholders', async (t) => {
  const directory = await temp(t);
  const candidates = [
    ['active.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>'],
    ['active.html', '<html><script>throw 1</script></html>'],
    ['pretend.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>'],
  ];
  for (const [index, [name, bytes]] of candidates.entries()) {
    await write(directory, name, bytes);
    const filename = await write(directory, `active-${index}.json`, withImage(name));
    const result = await importEnhancedFile(filename);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.conversations[0].turns.at(-1).assets?.length ?? 0, 0, name);
    assert.match(result.conversations[0].turns.at(-1).ai, /Image attachment/);
  }
});

test('oversized local and archived images remain unresolved without discarding their conversation', async (t) => {
  const directory = await temp(t);
  const large = Buffer.alloc(5 * 1024 ** 2 + 1);
  png.copy(large);
  await write(directory, 'oversized.png', large);
  const input = withImage('oversized.png');
  const local = await write(directory, 'large-image.json', input);
  const zipped = await write(
    directory,
    'large-image.zip',
    await archive([
      ['conversations.json', input],
      ['oversized.png', large],
    ]),
  );
  for (const filename of [local, zipped]) {
    const result = await importEnhancedFile(filename);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].turns.at(-1).assets?.length ?? 0, 0);
    assert.deepEqual(result.conversations[0].raw, input);
  }
});

test('corrupt optional ZIP images remain placeholders while valid conversation JSON still imports', async (t) => {
  const directory = await temp(t);
  const bytes = await archive([
    ['conversations.json', withImage('file-service://file-image')],
    ['file-image.png', png],
  ]);
  const imageOffset = bytes.indexOf(png);
  assert.ok(imageOffset > 0);
  bytes[imageOffset + 16] ^= 1;
  const filename = await write(directory, 'corrupt-image.zip', bytes);
  const result = await importEnhancedFile(filename);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].turns.at(-1).assets?.length ?? 0, 0);
  assert.match(result.conversations[0].turns.at(-1).ai, /Image attachment/);
});
