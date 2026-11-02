import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCompatibleBaseUrl,
  isLoopbackProviderUrl,
  getCompatibleApiKey,
  updateGenerationConfig,
  clearSessionOpenRouterApiKeyForTests,
} from '../src/generation/config.js';
import { createCompatibleProvider } from '../src/generation/providers/compatible.js';
import {
  openAiCompatibleChat,
  openAiCompatibleChatStream,
} from '../src/generation/openai-compatible.js';
import {
  readProviderText,
  readProviderChunk,
  redactProviderError,
} from '../src/generation/transport.js';
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
  clearSessionOpenRouterApiKeyForTests();
});
const request = {
  provider: 'llama-cpp',
  model: 'fixture',
  messages: [{ role: 'user', content: 'private prompt must not be echoed' }],
};

it('never follows provider redirects in buffered or streamed inference', async () => {
  for (const stream of [false, true]) {
    const fetchImpl = async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return stream
        ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ message: { content: 'ok' } }] });
    };
    const opts = { provider: 'llama-cpp', baseUrl: 'http://127.0.0.1/v1', request, fetchImpl };
    assert.equal(
      (await (stream ? openAiCompatibleChatStream(opts, () => {}) : openAiCompatibleChat(opts)))
        .content,
      'ok',
    );
  }
});
it('enforces declared and streamed response budgets and cancels the source', async () => {
  await assert.rejects(
    readProviderText(new Response('x', { headers: { 'content-length': '999' } }), 10),
    /size limit/,
  );
  let cancelled = false;
  await assert.rejects(
    readProviderText(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(11));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
      10,
    ),
    /size limit/,
  );
  assert.equal(cancelled, true);
});
it('bounds an idle body and honours abort while waiting for a token', async () => {
  const reader = new ReadableStream({}).getReader();
  await assert.rejects(readProviderChunk(reader, undefined, 10), /idle timeout/);
  await reader.cancel();
  const second = new ReadableStream({}).getReader();
  const control = new AbortController();
  const pending = readProviderChunk(second, control.signal);
  control.abort(new Error('user cancelled'));
  await assert.rejects(pending, /user cancelled/);
  await second.cancel();
});
it('redacts provider credentials and full echoed input before returning an error', async () => {
  await assert.rejects(
    openAiCompatibleChat({
      provider: 'llama-cpp',
      baseUrl: 'http://127.0.0.1/v1',
      apiKey: 'secret-api',
      request,
      fetchImpl: async () =>
        Response.json(
          { error: { message: 'secret-api private prompt must not be echoed Bearer abc12345' } },
          { status: 500 },
        ),
    }),
    (e) =>
      !e.message.includes('secret-api') &&
      !e.message.includes('private prompt') &&
      !e.message.includes('abc12345'),
  );
  assert.equal(
    redactProviderError('https://user:password@example.com?token=private'),
    'https://[redacted]@example.com?token=[redacted]',
  );
});
it('rejects truncated buffered tool replies before a tool can execute', async () => {
  await assert.rejects(
    openAiCompatibleChat({
      provider: 'llama-cpp',
      baseUrl: 'http://127.0.0.1/v1',
      request: { ...request, tools: [{}] },
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              finish_reason: 'length',
              message: {
                content: '',
                tool_calls: [
                  {
                    id: '1',
                    type: 'function',
                    function: { name: 'obsidian_create', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
    }),
    /cut off/,
  );
});
it('requires explicit compatible endpoints, labels LAN off-device and binds session keys to endpoints', async () => {
  assert.equal(parseCompatibleBaseUrl('http://192.168.1.2:1234/v1/'), 'http://192.168.1.2:1234/v1');
  for (const url of [
    'file:///tmp/a',
    'http://user:pass@localhost/v1',
    'http://localhost/v1?key=x',
    'http://localhost/v1#fragment',
  ])
    assert.throws(() => parseCompatibleBaseUrl(url));
  assert.equal(isLoopbackProviderUrl('http://192.168.1.2/v1'), false);
  assert.equal(isLoopbackProviderUrl('http://[::1]/v1'), true);
  const root = await mkdtemp(join(tmpdir(), 'compatible-config-'));
  process.env.GENERATION_CONFIG_PATH = join(root, 'config.json');
  process.env.OPENAI_COMPATIBLE_API_KEY = '';
  process.env.OPENAI_COMPATIBLE_BASE_URL = '';
  try {
    await updateGenerationConfig({
      openAiCompatible: {
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'private-key',
        label: 'My local model',
      },
    });
    assert.equal(await getCompatibleApiKey(), 'private-key');
    assert.equal(
      (await readFile(process.env.GENERATION_CONFIG_PATH, 'utf8')).includes('private-key'),
      false,
    );
    await updateGenerationConfig({ openAiCompatible: { baseUrl: 'http://192.168.1.2:1234/v1' } });
    assert.equal(await getCompatibleApiKey(), '');
    const provider = createCompatibleProvider(async (_url, init) => {
      assert.equal(init.redirect, 'error');
      assert.equal(new Headers(init.headers).has('authorization'), false);
      return Response.json({ data: [{ id: 'm1' }, { id: 'm1' }, { id: 123 }] });
    });
    assert.equal((await provider.status()).local, false);
    assert.equal((await provider.listModels()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('serializes simultaneous independent settings updates without losing either', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compatible-config-race-'));
  process.env.GENERATION_CONFIG_PATH = join(root, 'config.json');
  try {
    await Promise.all([
      updateGenerationConfig({ llamaCpp: { contextSize: 16384 } }),
      updateGenerationConfig({
        openAiCompatible: { label: 'LAN', baseUrl: 'http://192.168.1.2/v1' },
      }),
    ]);
    const stored = JSON.parse(await readFile(process.env.GENERATION_CONFIG_PATH, 'utf8'));
    assert.equal(stored.llamaCpp.contextSize, 16384);
    assert.equal(stored.openAiCompatible.label, 'LAN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('accepts a final cumulative arguments object without executing truncated or filtered calls', async () => {
  const tool = {
    type: 'function',
    function: {
      name: 'archive_read',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  };
  const messages = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'a', function: { name: 'archive_read', arguments: '{"path":' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"note.md"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ];
  const response = await openAiCompatibleChatStream(
    {
      provider: 'llama-cpp',
      baseUrl: 'http://localhost/v1',
      request: { ...request, tools: [tool] },
      fetchImpl: async () =>
        new Response(
          messages.map((x) => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n',
        ),
    },
    () => {},
  );
  assert.equal(response.toolCalls[0].function.arguments, '{"path":"note.md"}');
  messages[1].choices[0].finish_reason = 'content_filter';
  await assert.rejects(
    openAiCompatibleChatStream(
      {
        provider: 'llama-cpp',
        baseUrl: 'http://localhost/v1',
        request: { ...request, tools: [tool] },
        fetchImpl: async () =>
          new Response(
            messages.map((x) => 'data: ' + JSON.stringify(x) + '\n\n').join('') +
              'data: [DONE]\n\n',
          ),
      },
      () => {},
    ),
    /tool calls were not run/,
  );
});
