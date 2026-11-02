/* global window, AudioBufferSourceNode */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { startApiServer } from '../e2e/helpers.js';

function testWave() {
  const rate = 24000;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / rate) * 4000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

for (const remote of [false, true]) {
  test(`unsaved speech preview reaches the real HTTP provider with response metadata removed (${remote ? 'LAN' : 'localhost'})`, async ({
    page,
  }) => {
    const seen = [];
    const audio = testWave();
    const provider = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(audio);
    });
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const app = await startApiServer({
      env: { ALLOW_LAN_TTS: remote ? '1' : '0', ALLOW_LAN_AI: '0' },
    });
    try {
      if (remote) await page.context().setExtraHTTPHeaders({ 'X-Forwarded-For': '192.0.2.99' });
      await page.addInitScript(() => {
        window.__previewNonSilent = 0;
        window.__previewWire = undefined;
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          if (String(args[0]).endsWith('/api/tts/preview'))
            void response
              .clone()
              .text()
              .then((text) => {
                window.__previewWire = text;
              });
          return response;
        };
        const original = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          if (this.buffer?.getChannelData(0).some((sample) => Math.abs(sample) > 0.01))
            window.__previewNonSilent++;
          return original.apply(this, args);
        };
      });
      await page.goto(app.baseUrl + '/settings');
      await page.locator('#settings-tab-tts').click();
      await expect(page.locator('#tts-enabled')).not.toBeChecked();
      await page.locator('#ttsTab-providers').click();
      await page.locator('#tts-provider').selectOption('selfhosted');
      await page
        .locator('#tts-endpoint')
        .fill(`http://127.0.0.1:${provider.address().port}/v1/audio/speech`);
      await page.locator('#tts-model').fill('preview-fixture');
      await page.locator('#tts-voice').fill('synthetic-voice');
      for (const streaming of [true, false]) {
        await page.locator('#ttsTab-playback').click();
        await page.locator('#tts-streamingEnabled').setChecked(streaming);
        await page.locator('#ttsTab-test').click();
        const button = page.locator('[data-tts-action=test]');
        await expect(button).toBeEnabled();
        const responsePromise = page.waitForResponse((response) =>
          response.url().endsWith('/api/tts/preview'),
        );
        await page.evaluate(() => {
          window.__previewWire = undefined;
          window.__previewNonSilent = 0;
        });
        await button.click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        const sent = response.request().postDataJSON().settings;
        expect(sent.provider).toBe('selfhosted');
        expect(sent.streamingEnabled).toBe(streaming);
        for (const key of ['access', 'credentialStatus', 'warning'])
          expect(sent).not.toHaveProperty(key);
        await page.waitForFunction(() => window.__previewWire !== undefined);
        const frames = (await page.evaluate(() => window.__previewWire))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(frames.filter((frame) => frame.type === 'error')).toEqual([]);
        const result = frames.find((frame) => frame.type === 'result').result;
        expect(result.complete).toBe(true);
        expect(result.cached).toBe(false);
        expect(result.stored).toBe(false);
        expect(result.cacheKey).toBeNull();
        await expect.poll(() => page.evaluate(() => window.__previewNonSilent)).toBeGreaterThan(0);
      }
      expect(seen).toHaveLength(2);
      expect(
        seen.every((body) => body.model === 'preview-fixture' && body.voice === 'synthetic-voice'),
      ).toBe(true);
      const saved = await (await page.request.get(app.baseUrl + '/api/tts/settings')).json();
      expect(saved.enabled).toBe(false);
      expect(saved.provider).toBe('pocket');
      expect(saved.access.canManage).toBe(true);
      expect(saved.providerProfiles.selfhosted.model).not.toBe('preview-fixture');
      await expect(page.getByText('Unknown TTS setting: access', { exact: true })).toHaveCount(0);
    } finally {
      await app.stop();
      provider.closeAllConnections();
      await new Promise((resolve) => provider.close(resolve));
    }
  });
}
