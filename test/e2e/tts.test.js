import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApiServer } from './helpers.js';

test('TTS defaults, streaming toggle, local-only management and authenticated LAN boundary', async (t) => {
  const app = await startApiServer({
    prefix: 'tts-api-',
    env: { THREADSHELF_API_KEY: 'synthetic-tts-api-key' },
  });
  t.after(app.stop);
  const headers = { 'Content-Type': 'application/json' };
  const lan = { ...headers, 'X-Forwarded-For': '192.0.2.99' };
  const json = async (path, options = {}) => {
    const response = await fetch(app.baseUrl + path, options);
    return { status: response.status, body: await response.json() };
  };
  const original = await json('/api/tts/settings');
  assert.equal(original.status, 200);
  assert.equal(original.body.enabled, false);
  assert.equal(original.body.streamingEnabled, true);
  assert.equal(original.body.access.canManage, true);
  const assets = await json('/api/tts/assets');
  assert.equal(assets.body.engines.pocket.installed, false);
  assert.equal(assets.body.engines.kokoro.installed, false);
  const save = await json('/api/tts/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      settings: {
        enabled: true,
        streamingEnabled: false,
        allowNetworkPlayback: false,
        provider: 'selfhosted',
        endpoint: 'http://127.0.0.1:8999/v1/audio/speech',
        instructions: 'synthetic private voice guidance',
      },
    }),
  });
  assert.equal(save.body.streamingEnabled, false);
  assert.equal(save.body.access.canManage, true);
  const remote = await json('/api/tts/settings', { headers: lan });
  assert.equal(remote.body.access.canManage, false);
  assert.equal(remote.body.provider, 'pocket');
  assert.equal(remote.body.endpoint, '');
  assert.equal(remote.body.instructions, '');
  assert.equal(remote.body.providerProfiles.selfhosted.endpoint, '');
  assert.equal(remote.body.credentialStatus, undefined);
  const forbidden = await json('/api/tts/settings', {
    method: 'PATCH',
    headers: lan,
    body: JSON.stringify({ settings: { enabled: false } }),
  });
  assert.equal(forbidden.status, 403);
  const request = {
    ownerId: 'synthetic-tts-owner-123',
    requestId: 'lan1',
    sourceId: 'synthetic',
    messageId: 'message',
    text: 'Synthetic sample.',
  };
  const off = await json('/api/tts/synthesize', {
    method: 'POST',
    headers: lan,
    body: JSON.stringify(request),
  });
  assert.equal(off.status, 403);
  await json('/api/tts/settings', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ settings: { allowNetworkPlayback: true } }),
  });
  const missing = await json('/api/tts/synthesize', {
    method: 'POST',
    headers: lan,
    body: JSON.stringify(request),
  });
  assert.equal(missing.status, 401);
  const keyed = { ...lan, Authorization: 'Bearer synthetic-tts-api-key' };
  const discovery = await json('/api/tts/invoke', {
    method: 'POST',
    headers: keyed,
    body: JSON.stringify({
      ownerId: request.ownerId,
      action: 'tts.providers.discover',
      args: { provider: 'kokoro' },
    }),
  });
  assert.equal(discovery.status, 200);
  assert.ok(discovery.body.voices.some((v) => v.id === 'am_michael'));
  const remoteDenied = await json('/api/tts/invoke', {
    method: 'POST',
    headers: keyed,
    body: JSON.stringify({ ownerId: request.ownerId, action: 'tts.credentials.status', args: {} }),
  });
  assert.equal(remoteDenied.status, 403);
  const audio = await fetch(app.baseUrl + '/api/tts/synthesize', {
    method: 'POST',
    headers: keyed,
    body: JSON.stringify({ ...request, localProvider: 'pocket', localStreamingEnabled: false }),
  });
  assert.equal(audio.status, 200);
  const events = (await audio.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(events.some((e) => e.type === 'error' && /Download local voices/.test(e.error)));
  const installDenied = await json('/api/tts/assets/install', {
    method: 'POST',
    headers: keyed,
    body: JSON.stringify({ engines: ['pocket'], fingerprint: 'invalid' }),
  });
  assert.equal(installDenied.status, 403);
});
