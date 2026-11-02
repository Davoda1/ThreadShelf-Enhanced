import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApiServer } from './helpers.js';
let ctx, server, endpoint;
const requests = [];
before(async () => {
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fixture', context_length: 8192 }] }));
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      const input = JSON.parse(text);
      requests.push(input);
      res.setHeader('content-type', 'application/json');
      const message =
        input.tools?.length && !input.messages.some((m) => m.role === 'tool')
          ? {
              content: '',
              tool_calls: [
                {
                  id: 'read-1',
                  type: 'function',
                  function: {
                    name: 'archive_read',
                    arguments: JSON.stringify({
                      collection: 'missing',
                      sourceFile: '/etc/passwd',
                      conversationKey: 'missing',
                    }),
                  },
                },
              ],
            }
          : { content: 'Buffered final response' };
      res.end(
        JSON.stringify({
          model: 'fixture',
          choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  ctx = await startApiServer({
    prefix: 'enhanced-generation-',
    env: {
      OPENAI_COMPATIBLE_BASE_URL: endpoint,
      OPENAI_COMPATIBLE_API_KEY: '',
      STRATA_BASE_URL: 'http://127.0.0.1:1',
    },
  });
});
after(async () => {
  await ctx?.stop();
  await new Promise((resolve) => server.close(resolve));
});
const chat = async (extra) => {
  const response = await fetch(`${ctx.baseUrl}/api/generation/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'openai-compatible',
      model: 'fixture',
      prompt: 'Read only safe references',
      ephemeral: true,
      streamOutput: false,
      ...extra,
    }),
  });
  return (await response.text()).trim().split('\n').map(JSON.parse);
};
it('discovers a configured compatible server and buffers generation when streaming is off', async () => {
  const models = await fetch(
    `${ctx.baseUrl}/api/generation/models?provider=openai-compatible`,
  ).then((r) => r.json());
  assert.equal(models.models[0].id, 'fixture');
  assert.equal(models.runtime.state, 'external');
  const events = await chat({});
  assert.equal(
    events.some((e) => e.type === 'delta'),
    false,
  );
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).response.content, 'Buffered final response');
  assert.equal(requests.at(-1).stream, false);
  const chats = await fetch(`${ctx.baseUrl}/api/generation/threads`).then((r) => r.json());
  assert.deepEqual(chats.threads, []);
});
it('keeps interactive tool events working with token streaming off, and cannot read an arbitrary disk file', async () => {
  const start = requests.length;
  const events = await chat({ useArchive: true });
  assert.equal(
    events.some((e) => e.type === 'delta'),
    false,
  );
  assert.equal(
    events.some((e) => e.type === 'vault-tool' && e.state === 'error'),
    true,
  );
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).response.content, 'Buffered final response');
  assert.equal(requests.length, start + 2);
  const tool = requests.at(-1).messages.find((m) => m.role === 'tool');
  assert.match(JSON.parse(tool.content).error, /existing collection/);
  assert.equal(tool.content.includes('root:'), false);
});
it('rejects malformed tool options before contacting the provider', async () => {
  const count = requests.length;
  const events = await chat({ useArchive: 'yes' });
  assert.equal(events.at(-1).type, 'error');
  assert.equal(requests.length, count);
});
