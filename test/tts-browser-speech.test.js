import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractSpeech, fingerprint, sha256 } from '../client/src/tts/speech.ts';
import settingsCore from '../tts/settings.cjs';

test('browser speech SHA fallback agrees with Node for Unicode, long and boundary inputs', () => {
  for (const text of [
    '',
    'abc',
    'Árvíztűrő tükörfúrógép 🗣️',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'abc'.repeat(33000),
  ]) {
    assert.equal(
      sha256(new TextEncoder().encode(text)),
      createHash('sha256').update(text).digest('hex'),
    );
  }
});
test('speech fingerprints normalize newlines and Unicode but retain content omitted from speech', async () => {
  assert.deepEqual(await fingerprint('  e\u0301\r\ntext '), await fingerprint('é\ntext'));
  assert.notDeepEqual(
    await fingerprint('paragraph\n```js\nsecret=1\n```'),
    await fingerprint('paragraph\n```js\nsecret=2\n```'),
  );
});
test('full-source speech preserves tails beyond collapsed previews and respects code/citation switches', () => {
  const source =
    '# A heading\n\n' +
    'Long paragraph. '.repeat(300) +
    '\n\n```js\nconst answer = 42;\n```\n\nFinal tail. [source](https://example.invalid) citesecret-source';
  const filtered = extractSpeech(source, { readCode: false, readCitations: false });
  assert.ok(filtered.endsWith('Final tail. source'));
  assert.ok(filtered.length > 1800);
  assert.ok(!filtered.includes('const answer'));
  assert.ok(!filtered.includes('secret-source'));
  const complete = extractSpeech(source, { readCode: true, readCitations: true });
  assert.match(complete, /const answer = 42/);
  assert.match(complete, /secret-source/);
});
test('speech extraction keeps tables and image alt text, never executes embedded HTML', () => {
  const text = extractSpeech(
    '| Column | Value |\n|---|---|\n| item | 12 |\n\n![A cat](https://example.invalid/cat.png)\n\n<script>alert(1)</script>',
    { readCode: false, readCitations: false },
  );
  assert.match(text, /Column; Value/);
  assert.match(text, /item; 12/);
  assert.match(text, /A cat/);
  assert.doesNotMatch(text, /alert\(1\)/);
});

test('new speech IDs retain normalized indices when the chat omits orphan thinking turns', async () => {
  const { continuationSpeechIndex } = await import('../client/src/tts/identity.ts');
  const messages = [{ turnIndex: 1 }, { turnIndex: 2 }, {}, { reasoning: 'new thinking' }, {}];
  // The archive has leading orphan turn 0 and trailing orphan turn 3.
  assert.equal(continuationSpeechIndex(messages, 0, 0, 2, 4), 1);
  assert.equal(continuationSpeechIndex(messages, 2, 0, 2, 4), 4);
  assert.equal(continuationSpeechIndex(messages, 3, 0, 2, 4), 6);
  assert.equal(continuationSpeechIndex(messages, 4, 0, 2, 4), 7);
  assert.equal(continuationSpeechIndex([{}, { reasoning: 'reason' }], 1, 100, 0, 0), 102);
});
test('LAN settings refresh preserves the same tab choices used by synthesis', async () => {
  const bridge = await import('../client/src/tts/transport.ts');
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        provider: 'pocket',
        voice: 'alba',
        streamingEnabled: true,
        volume: 1,
        playbackRate: 1,
        enabled: true,
        access: { canManage: false },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  try {
    await bridge.invokeTts('tts.settings.get');
    bridge.setLocalSpeechChoice('kokoro', 'am_michael', false);
    await bridge.invokeTts('tts.settings.save', { settings: { volume: 0.3, playbackRate: 1.5 } });
    const refreshed = await bridge.invokeTts('tts.settings.get');
    assert.equal(refreshed.provider, 'kokoro');
    assert.equal(refreshed.voice, 'am_michael');
    assert.equal(refreshed.streamingEnabled, false);
    assert.equal(refreshed.volume, 0.3);
    assert.equal(refreshed.playbackRate, 1.5);
  } finally {
    globalThis.fetch = previous;
  }
});

test('speech previews and synthesis keep response capabilities out of editable settings', async () => {
  const bridge = await import('../client/src/tts/transport.ts');
  const previous = globalThis.fetch;
  const responseSettings = {
    ...structuredClone(settingsCore.DEFAULTS),
    enabled: true,
    access: { canManage: true, networkPlaybackEnabled: false, requiresApiKey: false },
    credentialStatus: { selfhosted: true },
    warning: 'Synthetic settings diagnostic',
  };
  // This is the exact former failure: a settings response was reused as a
  // preview override, although "access" is not a writable speech preference.
  assert.throws(() => settingsCore.normalize(responseSettings), /Unknown TTS setting: access/);
  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/tts/settings') return Response.json(responseSettings);
    const body = JSON.parse(options.body);
    sent.push({ url, body });
    try {
      const settings = settingsCore.normalize(body.settings);
      return new Response(
        JSON.stringify({
          type: 'result',
          result: { complete: true, provider: settings.provider },
        }) + '\n',
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      );
    } catch (error) {
      return new Response(JSON.stringify({ type: 'error', error: error.message }) + '\n');
    }
  };
  try {
    const loaded = await bridge.invokeTts('tts.settings.get');
    const before = structuredClone(loaded);
    for (const action of ['tts.preview', 'tts.synthesize']) {
      const result = await bridge.invokeTts(action, {
        requestId: action,
        text: 'Synthetic preview passage.',
        settings: loaded,
      });
      assert.equal(result.complete, true);
      assert.equal(result.provider, 'pocket');
    }
    assert.deepEqual(
      sent.map((request) => request.url),
      ['/api/tts/preview', '/api/tts/synthesize'],
    );
    for (const { body } of sent) {
      assert.equal(body.settings.access, undefined);
      assert.equal(body.settings.credentialStatus, undefined);
      assert.equal(body.settings.warning, undefined);
      assert.equal(body.settings.enabled, true);
      assert.equal(body.settings.voice, 'alba');
      assert.deepEqual(body.settings.providerProfiles, responseSettings.providerProfiles);
    }
    assert.deepEqual(loaded, before, 'request filtering must not mutate cached capabilities');
    assert.equal(loaded.access.canManage, true);
  } finally {
    globalThis.fetch = previous;
  }
});

test('full settings saves and rollback payloads exclude response metadata without dropping unknown preferences', async () => {
  const bridge = await import('../client/src/tts/transport.ts');
  const previous = globalThis.fetch;
  const responseSettings = {
    ...structuredClone(settingsCore.DEFAULTS),
    access: { canManage: true, networkPlaybackEnabled: false, requiresApiKey: false },
    credentialStatus: { selfhosted: false },
    warning: 'Synthetic warning',
  };
  const sent = [];
  globalThis.fetch = async (_url, options = {}) => {
    if (!options.body) return Response.json(responseSettings);
    const body = JSON.parse(options.body);
    sent.push(body.settings);
    try {
      return Response.json({
        ...settingsCore.normalize(body.settings),
        access: responseSettings.access,
      });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  };
  try {
    const previousSettings = await bridge.invokeTts('tts.settings.get');
    const saved = await bridge.invokeTts('tts.settings.save', {
      settings: { ...previousSettings, volume: 0.3 },
    });
    assert.equal(saved.volume, 0.3);
    assert.equal(saved.access.canManage, true);
    const restored = await bridge.invokeTts('tts.settings.save', { settings: previousSettings });
    assert.equal(restored.volume, 1);
    for (const settings of sent) {
      assert.equal(settings.access, undefined);
      assert.equal(settings.credentialStatus, undefined);
      assert.equal(settings.warning, undefined);
    }
    await assert.rejects(
      bridge.invokeTts('tts.settings.save', {
        settings: { ...previousSettings, unrecognizedPreference: true },
      }),
      /Unknown TTS setting: unrecognizedPreference/,
    );
    assert.equal(previousSettings.access.canManage, true);
    assert.equal(previousSettings.warning, 'Synthetic warning');
  } finally {
    globalThis.fetch = previous;
  }
});
