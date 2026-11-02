import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
import { getAvailablePort } from '../shared/helpers.js';

const lanHeaders = { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.168.40.25' };
const jsonRequest = async (app, path, { method = 'GET', body, headers = lanHeaders } = {}) => {
  const response = await fetch(app.baseUrl + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};
const rawGet = (baseUrl, path, headers) =>
  new Promise((resolve, reject) => {
    const req = request(new URL(path, baseUrl), { headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });

const startSyntheticProvider = async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'lan-fixture', context_length: 8192 }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const content of ['LAN ', 'stream response'])
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'lan-fixture',
          choices: [{ message: { content: 'LAN buffered response' }, finish_reason: 'stop' }],
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
};

test('AI LAN access stays off by default and cannot be enabled by the speech flag', async (t) => {
  const app = await startApiServer({
    prefix: 'ai-lan-disabled-',
    env: { ALLOW_LAN_TTS: '1', ALLOWED_HOSTS: 'threadshelf.test' },
  });
  t.after(app.stop);
  for (const [method, path] of [
    ['GET', '/api/generation/config'],
    ['PUT', '/api/generation/config'],
    ['GET', '/api/generation/local-api'],
    ['GET', '/api/generation/directories'],
    ['GET', '/api/generation/models'],
    ['GET', '/api/generation/runtime/logs'],
    ['POST', '/api/generation/runtime/eject'],
    ['GET', '/api/generation/prompts'],
    ['GET', '/api/generation/threads'],
    ['POST', '/api/generation/chat'],
    ['POST', '/api/generation/chat/stream'],
    ['GET', '/api/generation/hardware'],
    ['GET', '/api/generation/catalog/search'],
    ['GET', '/api/generation/catalog/model'],
    ['POST', '/api/generation/catalog/download'],
    ['GET', '/api/generation/setup/plan'],
    ['POST', '/api/generation/setup/run'],
    ['GET', '/api/obsidian/config'],
    ['GET', '/api/obsidian/vaults'],
  ]) {
    const result = await jsonRequest(app, path, {
      method,
      ...(method === 'GET' ? {} : { body: {} }),
    });
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.match(result.body.error, /ALLOW_LAN_AI=1/);
  }
  const byHost = await rawGet(app.baseUrl, '/api/generation/config', { Host: 'threadshelf.test' });
  assert.equal(byHost.status, 403, 'an allowed LAN hostname is not a localhost request');
  assert.equal((await jsonRequest(app, '/api/generation/config', { headers: {} })).status, 200);
  const speech = await jsonRequest(app, '/api/tts/settings');
  assert.equal(speech.body.access.canManage, true, 'TTS remains independently enabled');
});

test('AI LAN opt-in supports headless setup, chat and notes without weakening API keys', async (t) => {
  const upstream = await startSyntheticProvider();
  t.after(upstream.stop);
  const app = await startApiServer({
    prefix: 'ai-lan-enabled-',
    env: {
      ALLOW_LAN_AI: '1',
      ALLOW_LAN_TTS: '0',
      ALLOWED_HOSTS: 'threadshelf.test',
      OPENAI_COMPATIBLE_BASE_URL: upstream.baseUrl,
      OPENAI_COMPATIBLE_API_KEY: '',
      STRATA_BASE_URL: 'http://127.0.0.1:1',
      THREADSHELF_API_KEY: 'synthetic-lan-api-key',
    },
  });
  t.after(app.stop);

  await t.test(
    'settings, directory browsing, model discovery and installation guards',
    async () => {
      const config = await jsonRequest(app, '/api/generation/config');
      assert.equal(config.status, 200);
      const folder = join(app.tempRoot, 'models');
      await mkdir(folder);
      const saved = await jsonRequest(app, '/api/generation/config', {
        method: 'PUT',
        body: { llamaCpp: { modelDirectories: [folder] } },
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.config.llamaCpp.modelDirectories, [folder]);
      const directories = await jsonRequest(
        app,
        `/api/generation/directories?path=${encodeURIComponent(app.tempRoot)}`,
      );
      assert.equal(directories.status, 200);
      assert.ok(directories.body.directories.some((entry) => entry.path === folder));
      const models = await jsonRequest(app, '/api/generation/models?provider=openai-compatible');
      assert.equal(models.status, 200);
      assert.equal(models.body.models[0].id, 'lan-fixture');
      assert.equal((await jsonRequest(app, '/api/generation/runtime/logs')).status, 200);
      assert.equal((await jsonRequest(app, '/api/generation/hardware')).status, 200);
      const setup = await jsonRequest(app, '/api/generation/setup/run', {
        method: 'POST',
        body: {},
      });
      assert.equal(setup.status, 400);
      assert.match(setup.body.error, /explicit confirmation/);
      const catalog = await jsonRequest(app, '/api/generation/catalog/model?id=../invalid');
      assert.equal(catalog.status, 400);
      const download = await jsonRequest(app, '/api/generation/catalog/download', {
        method: 'POST',
        body: { repoId: '../invalid' },
      });
      assert.equal(download.status, 400, 'authorization does not bypass download input validation');
    },
  );

  await t.test('master prompts and saved-chat management', async () => {
    const created = await jsonRequest(app, '/api/generation/prompts', {
      method: 'POST',
      body: { name: 'LAN test', text: 'Synthetic prompt.' },
    });
    assert.equal(created.status, 201);
    const id = created.body.activeId;
    assert.ok(id);
    const edited = await jsonRequest(app, `/api/generation/prompts/${id}`, {
      method: 'PATCH',
      body: { text: 'Edited synthetic prompt.' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.prompts[0].text, 'Edited synthetic prompt.');
    assert.equal(
      (
        await jsonRequest(app, '/api/generation/prompts/active', {
          method: 'PUT',
          body: { id: '' },
        })
      ).status,
      200,
    );
    assert.equal(
      (await jsonRequest(app, `/api/generation/prompts/${id}`, { method: 'DELETE' })).status,
      200,
    );
    const chat = await jsonRequest(app, '/api/generation/threads', {
      method: 'POST',
      body: { title: 'LAN draft' },
    });
    assert.equal(chat.status, 201);
    assert.equal(
      (
        await jsonRequest(app, `/api/generation/threads/${chat.body.id}`, {
          method: 'PATCH',
          body: { title: 'Renamed LAN draft' },
        })
      ).status,
      200,
    );
    const reread = await jsonRequest(app, `/api/generation/threads/${chat.body.id}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.body.title, 'Renamed LAN draft');
    assert.equal(
      (await jsonRequest(app, `/api/generation/threads/${chat.body.id}`, { method: 'DELETE' }))
        .status,
      200,
    );
    assert.deepEqual((await jsonRequest(app, '/api/generation/threads')).body.threads, []);
  });

  await t.test('buffered and streamed AI responses work over the LAN web transport', async () => {
    const body = {
      provider: 'openai-compatible',
      model: 'lan-fixture',
      prompt: 'Hello from LAN',
      ephemeral: true,
    };
    const buffered = await jsonRequest(app, '/api/generation/chat', { method: 'POST', body });
    assert.equal(buffered.status, 200);
    assert.equal(buffered.body.content, 'LAN buffered response');
    for (const streamOutput of [false, true]) {
      const response = await fetch(app.baseUrl + '/api/generation/chat/stream', {
        method: 'POST',
        headers: lanHeaders,
        body: JSON.stringify({ ...body, streamOutput }),
      });
      assert.equal(response.status, 200);
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).type, 'done', JSON.stringify(events));
      assert.equal(
        events.at(-1).response.content,
        streamOutput ? 'LAN stream response' : 'LAN buffered response',
      );
      assert.equal(
        events.some((event) => event.type === 'delta'),
        streamOutput,
      );
      assert.equal(upstream.requests.at(-1).stream, streamOutput);
    }
  });

  await t.test(
    'vault connection and explicit write permission remain usable and enforced',
    async () => {
      const vaultPath = join(app.tempRoot, 'notes');
      await mkdir(vaultPath);
      const connected = await jsonRequest(app, '/api/obsidian/config', {
        method: 'PUT',
        body: { vaultPath, allowWrites: false },
      });
      assert.equal(connected.status, 200);
      const registry = await jsonRequest(app, '/api/obsidian/vaults');
      assert.equal(registry.body.vaults.length, 1);
      const note = { path: 'headless.md', content: '# Headless setup\nSynthetic note.' };
      const denied = await jsonRequest(app, '/api/obsidian/note', { method: 'POST', body: note });
      assert.equal(denied.status, 400);
      assert.equal(
        (
          await jsonRequest(app, '/api/obsidian/config', {
            method: 'PATCH',
            body: { allowWrites: true },
          })
        ).status,
        200,
      );
      const created = await jsonRequest(app, '/api/obsidian/note', { method: 'POST', body: note });
      assert.equal(created.status, 201);
      assert.equal(await readFile(join(vaultPath, note.path), 'utf8'), note.content);
      const read = await jsonRequest(app, '/api/obsidian/note?path=headless.md');
      assert.equal(read.status, 200);
      assert.equal(read.body.content, note.content);
      const traversal = await jsonRequest(app, '/api/obsidian/note?path=../generation.json');
      assert.equal(traversal.status, 400, 'LAN opt-in does not weaken vault path confinement');
    },
  );

  await t.test(
    'host/origin protection, TTS separation and /v1 authentication are unchanged',
    async () => {
      const byHost = await rawGet(app.baseUrl, '/api/generation/config', {
        Host: 'threadshelf.test',
        Origin: 'http://threadshelf.test',
      });
      assert.equal(byHost.status, 200);
      const badHost = await rawGet(app.baseUrl, '/api/generation/config', {
        Host: 'attacker.example',
      });
      assert.equal(badHost.status, 403);
      assert.equal(badHost.body.error, 'Forbidden host');
      const badOrigin = await rawGet(app.baseUrl, '/api/generation/config', {
        Host: 'threadshelf.test',
        Origin: 'http://attacker.example',
      });
      assert.equal(badOrigin.status, 403);
      assert.equal(badOrigin.body.error, 'Forbidden origin');
      const speech = await jsonRequest(app, '/api/tts/settings');
      assert.equal(speech.body.access.canManage, false);
      assert.equal(
        (
          await jsonRequest(app, '/api/tts/settings', {
            method: 'PATCH',
            body: { settings: { enabled: true } },
          })
        ).status,
        403,
      );
      const apiKey = { Authorization: 'Bearer synthetic-lan-api-key' };
      assert.equal(
        (await jsonRequest(app, '/v1/models', { headers: { ...lanHeaders, ...apiKey } })).status,
        403,
      );
      assert.equal((await jsonRequest(app, '/v1/models', { headers: {} })).status, 401);
      assert.equal((await jsonRequest(app, '/v1/models', { headers: apiKey })).status, 200);
      const port = await getAvailablePort();
      const network = await jsonRequest(app, '/api/generation/config', {
        method: 'PUT',
        body: { localApi: { networkAccess: true, networkPort: port } },
      });
      assert.equal(network.status, 200);
      const networkApp = { baseUrl: `http://127.0.0.1:${port}` };
      assert.equal((await jsonRequest(networkApp, '/v1/models')).status, 401);
      assert.equal(
        (await jsonRequest(networkApp, '/v1/models', { headers: { ...lanHeaders, ...apiKey } }))
          .status,
        200,
      );
      assert.equal(
        (await jsonRequest(networkApp, '/api/generation/config', { headers: apiKey })).status,
        404,
      );
    },
  );
});

test('headless flags load from the real .env file on restart and explicit environment values win', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'lan-dotenv-'));
  const envFile = join(dataRoot, '.env');
  let app;
  t.after(async () => {
    await app?.stop();
    await rm(dataRoot, { recursive: true, force: true });
  });
  const start = (overrides = {}) =>
    startApiServer({
      prefix: 'lan-dotenv-server-',
      env: {
        THREADSHELF_DATA_DIR: dataRoot,
        // Undefined removes the fixture's explicit zero so Node can read .env.
        ALLOW_LAN_AI: undefined,
        ALLOW_LAN_TTS: undefined,
        ...overrides,
      },
    });
  const writeFlags = (ai, tts) =>
    writeFile(
      envFile,
      `# Synthetic headless configuration\nALLOW_LAN_AI=${ai}\nALLOW_LAN_TTS=${tts}\n`,
      { mode: 0o600 },
    );
  await writeFlags(1, 1);
  app = await start();
  assert.equal((await jsonRequest(app, '/api/generation/config')).status, 200);
  const speech = await jsonRequest(app, '/api/tts/settings');
  assert.equal(speech.body.access.canManage, true);
  assert.equal(
    speech.body.enabled,
    false,
    'LAN permissions do not enable speech or download models',
  );

  await writeFlags(0, 0);
  assert.equal(
    (await jsonRequest(app, '/api/generation/config')).status,
    200,
    'editing .env does not silently alter permissions in a running process',
  );
  assert.equal((await jsonRequest(app, '/api/tts/settings')).body.access.canManage, true);
  await app.stop();
  app = undefined;
  app = await start();
  assert.equal((await jsonRequest(app, '/api/generation/config')).status, 403);
  assert.equal((await jsonRequest(app, '/api/tts/settings')).body.access.canManage, false);
  assert.equal(
    (await jsonRequest(app, '/api/generation/config', { headers: {} })).status,
    200,
    'dotenv zero leaves localhost management available',
  );

  await app.stop();
  app = undefined;
  await writeFlags(1, 1);
  app = await start({ ALLOW_LAN_AI: '0' });
  assert.equal(
    (await jsonRequest(app, '/api/generation/config')).status,
    403,
    'an explicit process zero wins over an enabled .env value',
  );
  assert.equal(
    (await jsonRequest(app, '/api/tts/settings')).body.access.canManage,
    true,
    'the independent speech value still loads from .env',
  );
});
