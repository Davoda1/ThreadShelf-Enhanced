import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader, TextReader } from '@zip.js/zip.js';
import { startApiServer, ingestViaNdjson } from './helpers.js';
test(
  'ZIP and Processor HTML retain raw data, citations and images after source removal',
  { timeout: 180000 },
  async (t) => {
    const ctx = await startApiServer({ prefix: 'enhanced-import-api-' });
    t.after(() => ctx.stop());
    const folder = join(ctx.tempRoot, 'source');
    await mkdir(folder);
    const raw = (id) => ({
      id,
      title: 'Synthetic preserved archive',
      current_node: 'answer',
      mapping: {
        user: {
          id: 'user',
          parent: null,
          message: { author: { role: 'user' }, content: { parts: ['An archived prompt'] } },
        },
        answer: {
          id: 'answer',
          parent: 'user',
          message: {
            author: { role: 'assistant' },
            content: { parts: ['Answer with ![saved](pixel.png)'] },
            metadata: {
              content_references: [
                { type: 'webpage', url: 'https://example.com/source', title: 'Source' },
              ],
            },
          },
        },
      },
    });
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await writer.add('conversations.json', new TextReader(JSON.stringify([raw('zip-chat')])));
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    );
    await writer.add('pixel.png', new Uint8ArrayReader(png));
    const zip = join(folder, 'export.zip');
    await writeFile(zip, await writer.close());
    const html = join(folder, 'chat-index.html');
    await writeFile(
      html,
      `<script>const jsonData = ${JSON.stringify([raw('html-chat')])}; throw Error('must not execute');</script>`,
    );
    const result = await ingestViaNdjson(ctx.baseUrl, folder, 'enhanced');
    assert.deepEqual(result.errors, []);
    assert.equal(result.conversations, 2);
    await rm(folder, { recursive: true });
    for (const [sourceFile, conversationKey, id] of [
      [zip, 'conversations.json::openai:zip-chat', 'zip-chat'],
      [html, 'openai:html-chat', 'html-chat'],
    ]) {
      const response = await fetch(
        `${ctx.baseUrl}/api/thread?${new URLSearchParams({ collection: 'enhanced', sourceFile, conversationKey })}`,
      );
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.raw, raw(id));
      assert.equal(body.provider, 'openai');
      assert.equal(body.sourceIdentity.conversationKey, conversationKey);
      assert.deepEqual(body.turns[1].metadata, raw(id).mapping.answer.message.metadata);
      if (id === 'zip-chat') assert.match(body.turns[1].assets[0].url, /^data:image\/png;base64,/);
      // Normalized JSON is itself an Enhanced/Local Reader compatible document.
      const { parseEnhancedDocument } = await import('../../src/enhanced-import/index.js');
      const [roundTrip] = parseEnhancedDocument(body, 'reexport.json');
      assert.equal(roundTrip.key, conversationKey);
      assert.deepEqual(JSON.parse(JSON.stringify(roundTrip.turns)), body.turns);
    }
  },
);
