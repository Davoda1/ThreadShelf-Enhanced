import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { startApiServer } from './helpers.js';

const require = createRequire(import.meta.url);
const { wav } = require('../../tts/providers.cjs');
const ownerId = 'trusted-lan-test-owner-123';
const key = 'synthetic-headless-api-key';
const lan = { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.99' };
const request = (id) => ({
  ownerId,
  requestId: id,
  sourceId: 'synthetic-lan-thread',
  messageId: id,
  text: 'Synthetic LAN speech.',
});
const jsonRequest = async (app, path, method = 'GET', body, headers = lan) => {
  const response = await fetch(app.baseUrl + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
};
const audioRequest = async (app, operation, id, headers = lan) => {
  const response = await fetch(app.baseUrl + '/api/tts/' + operation, {
    method: 'POST',
    headers,
    body: JSON.stringify(request(id)),
  });
  return {
    status: response.status,
    events: (await response.text()).trim().split('\n').map(JSON.parse),
  };
};

test('headless TTS opt-in grants complete speech setup and playback without enabling AI or bypassing API keys', async (t) => {
  const pcm = Buffer.alloc(480, 5);
  const audio = wav(pcm);
  const upstreamRequests = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      upstreamRequests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(audio);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const endpoint = `http://127.0.0.1:${upstream.address().port}/v1/audio/speech`;
  const app = await startApiServer({
    prefix: 'tts-trusted-lan-',
    env: { ALLOW_LAN_TTS: '1', ALLOW_LAN_AI: '0', THREADSHELF_API_KEY: key },
  });
  t.after(app.stop);
  const original = await jsonRequest(app, '/api/tts/settings');
  assert.equal(original.status, 200);
  assert.equal(original.body.enabled, false, 'the access switch does not enable speech');
  assert.equal(original.body.access.canManage, true);
  assert.equal(original.body.access.requiresApiKey, false);
  const assets = await jsonRequest(app, '/api/tts/assets');
  assert.equal(assets.body.engines.pocket.installed, false);
  assert.equal(assets.body.engines.kokoro.installed, false);
  assert.equal((await jsonRequest(app, '/api/generation/config')).status, 403);
  assert.equal(
    (await jsonRequest(app, '/v1/models')).status,
    403,
    'API network access remains disabled',
  );
  assert.equal((await jsonRequest(app, '/v1/models', 'GET', undefined, {})).status, 401);
  assert.equal(
    (
      await jsonRequest(app, '/v1/models', 'GET', undefined, {
        Authorization: `Bearer ${key}`,
      })
    ).status,
    200,
  );
  const disabledInstall = await jsonRequest(app, '/api/tts/assets/install', 'POST', {
    engines: ['pocket'],
    fingerprint: 'not-approved',
  });
  assert.equal(disabledInstall.status, 409);
  const disabled = await audioRequest(app, 'synthesize', 'disabled');
  assert.ok(
    disabled.events.some((event) => event.type === 'error' && /disabled/.test(event.error)),
  );

  const saved = await jsonRequest(
    app,
    '/api/tts/settings',
    'PATCH',
    {
      settings: {
        enabled: true,
        allowNetworkPlayback: false,
        provider: 'selfhosted',
        endpoint,
        model: 'synthetic-voice-model',
        voice: 'synthetic-voice',
        responseFormat: 'wav',
        streamingEnabled: false,
        cacheEnabled: true,
      },
    },
    { ...lan, Origin: app.baseUrl },
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.streamingEnabled, false);
  assert.equal(saved.body.access.canManage, true);
  assert.equal(
    saved.body.access.networkPlaybackEnabled,
    false,
    'keyed restricted mode remains independent',
  );
  const current = await jsonRequest(app, '/api/tts/settings');
  assert.equal(
    current.body.provider,
    'selfhosted',
    'trusted access is not forced into CPU-only mode',
  );
  assert.equal(current.body.endpoint, endpoint);
  assert.equal(
    (
      await jsonRequest(app, '/api/tts/invoke', 'POST', {
        ownerId,
        action: 'tts.credentials.status',
        args: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await jsonRequest(app, '/api/tts/invoke', 'POST', {
        ownerId,
        action: 'tts.cache.list',
        args: {},
      })
    ).status,
    200,
  );

  const plan = await jsonRequest(app, '/api/tts/assets/plan', 'POST', { engines: ['pocket'] });
  assert.equal(plan.status, 200);
  assert.match(plan.body.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(plan.body.files.length > 0);
  const unreviewed = await fetch(app.baseUrl + '/api/tts/assets/install', {
    method: 'POST',
    headers: lan,
    body: JSON.stringify({ engines: ['pocket'], fingerprint: 'not-approved' }),
  });
  assert.equal(unreviewed.status, 200);
  const installEvents = (await unreviewed.text()).trim().split('\n').map(JSON.parse);
  assert.ok(
    installEvents.some((event) => event.type === 'error' && /plan changed/.test(event.error)),
  );
  const unchanged = await jsonRequest(app, '/api/tts/assets');
  assert.equal(
    unchanged.body.engines.pocket.installed,
    false,
    'unreviewed install cannot download/publish voices',
  );
  assert.equal(
    (await jsonRequest(app, '/api/tts/assets/uninstall', 'POST', { engines: ['pocket'] })).status,
    200,
  );

  for (const operation of ['preview', 'synthesize']) {
    const output = await audioRequest(app, operation, operation);
    assert.equal(output.status, 200);
    assert.equal(
      output.events.some((event) => event.type === 'error'),
      false,
    );
    const result = output.events.find((event) => event.type === 'result').result;
    assert.deepEqual(Buffer.from(result.audioBase64, 'base64'), audio);
    assert.equal(result.recording.provider, 'selfhosted');
    assert.equal(
      result.stored,
      operation === 'synthesize',
      'trusted LAN preserves configured caching',
    );
  }
  assert.equal(upstreamRequests.length, 2);
  assert.ok(upstreamRequests.every((body) => body.model === 'synthetic-voice-model'));

  for (const headers of [
    { ...lan, Origin: 'http://untrusted.invalid' },
    { ...lan, Origin: 'http://127.0.0.1:1' },
  ]) {
    const forbidden = await jsonRequest(
      app,
      '/api/tts/settings',
      'PATCH',
      {
        settings: { enabled: false },
      },
      headers,
    );
    assert.equal(
      forbidden.status,
      403,
      `trusted-LAN opt-in must retain origin/host checks: ${JSON.stringify(headers)}`,
    );
  }
  // Fetch normalizes Host; send an actual mismatched Host with native HTTP.
  const badHostStatus = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      app.baseUrl + '/api/tts/settings',
      {
        headers: { ...lan, Host: 'untrusted.invalid' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await jsonRequest(app, '/api/tts/settings')).body.enabled, true);
});

test('explicit TTS off retains key-only CPU playback and management denial even when AI is enabled', async (t) => {
  const app = await startApiServer({
    prefix: 'tts-keyed-lan-',
    env: { ALLOW_LAN_TTS: '0', ALLOW_LAN_AI: '1', THREADSHELF_API_KEY: key },
  });
  t.after(app.stop);
  const localHeaders = { 'Content-Type': 'application/json' };
  const saved = await jsonRequest(
    app,
    '/api/tts/settings',
    'PATCH',
    {
      settings: { enabled: true, allowNetworkPlayback: true },
    },
    localHeaders,
  );
  assert.equal(saved.status, 200, 'localhost is still permitted');
  const remote = await jsonRequest(app, '/api/tts/settings');
  assert.equal(remote.body.access.canManage, false);
  assert.equal(remote.body.access.requiresApiKey, true);
  const keyed = { ...lan, Authorization: `Bearer ${key}` };
  for (const [path, method, body] of [
    ['/api/tts/settings', 'PATCH', { settings: { enabled: false } }],
    ['/api/tts/assets/plan', 'POST', { engines: ['pocket'] }],
    ['/api/tts/assets/install', 'POST', { engines: ['pocket'], fingerprint: 'not-approved' }],
    ['/api/tts/assets/uninstall', 'POST', { engines: ['pocket'] }],
    ['/api/tts/invoke', 'POST', { ownerId, action: 'tts.credentials.status', args: {} }],
  ]) {
    assert.equal((await jsonRequest(app, path, method, body, keyed)).status, 403, path);
  }
  assert.equal(
    (await jsonRequest(app, '/api/tts/synthesize', 'POST', request('no-key'))).status,
    401,
  );
  const discovery = await jsonRequest(
    app,
    '/api/tts/invoke',
    'POST',
    {
      ownerId,
      action: 'tts.providers.discover',
      args: { provider: 'kokoro' },
    },
    keyed,
  );
  assert.equal(discovery.status, 200);
  assert.ok(discovery.body.voices.some((voice) => voice.id === 'am_michael'));
  const cpu = await audioRequest(app, 'synthesize', 'cpu-keyed', keyed);
  assert.equal(cpu.status, 200);
  assert.ok(
    cpu.events.some((event) => event.type === 'error' && /Download local voices/.test(event.error)),
  );
});
