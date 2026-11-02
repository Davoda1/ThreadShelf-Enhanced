/* global Buffer, setTimeout, document, innerWidth, localStorage, sessionStorage, getComputedStyle */
import { test, expect } from './fixtures.js';

const wave = () => {
  const rate = 24000,
    pcm = Buffer.alloc(rate * 2 * 10),
    buffer = Buffer.alloc(44 + pcm.length);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcm.length, 40);
  pcm.copy(buffer, 44);
  return buffer.toString('base64');
};

test('speech is opt-in, retains streaming control, and downloading requires review', async ({
  page,
  serverContext,
}, testInfo) => {
  await page.request.patch(serverContext.baseUrl + '/api/tts/settings', {
    data: { settings: { enabled: false, streamingEnabled: true } },
  });
  let plans = 0,
    installs = 0;
  await page.route('**/api/tts/settings', async (route) => {
    if (route.request().method() === 'PATCH')
      await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.route('**/api/tts/assets/plan', async (route) => {
    plans++;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const engines = route.request().postDataJSON().engines;
    await route.fulfill({
      json: {
        fingerprint: 'reviewed',
        engines,
        requestedEngines: engines,
        platform: 'linux-x64',
        downloadBytes: 1024,
        requiredFreeBytes: 4096,
        files: [{ name: 'synthetic-test-voice', bytes: 1024, cached: false }],
        licenses: ['Synthetic test fixture'],
      },
    });
  });
  await page.route('**/api/tts/assets/install', async (route) => {
    installs++;
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'error', error: 'Synthetic verification failure' }) + '\n',
    });
  });
  await page.goto(serverContext.baseUrl + '/settings');
  await page.locator('#settings-tab-tts').click();
  await expect(page.locator('#tts-enabled')).not.toBeChecked();
  await expect(page.locator('#tts-streamingEnabled')).toBeChecked();
  await expect(page.locator('.tts-assets')).toHaveCount(0);
  await page.locator('#tts-enabled').check();
  const saveBefore = await page
    .getByRole('button', { name: 'Save speech settings', exact: true })
    .boundingBox();
  await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
  const saveDuring = await page.getByRole('button', { name: 'Saving…', exact: true }).boundingBox();
  expect(saveDuring.width).toBe(saveBefore.width);
  expect(saveDuring.height).toBe(saveBefore.height);
  await expect(page.locator('.tts-assets')).toBeVisible();
  expect(plans).toBe(0);
  expect(installs).toBe(0);
  const downloadBefore = await page
    .getByRole('button', { name: 'Download / repair local voices', exact: true })
    .boundingBox();
  await page.getByRole('button', { name: 'Download / repair local voices', exact: true }).click();
  const downloadDuring = await page
    .getByRole('button', { name: 'Checking…', exact: true })
    .boundingBox();
  expect(downloadDuring.width).toBe(downloadBefore.width);
  expect(downloadDuring.height).toBe(downloadBefore.height);
  await expect(page.getByRole('heading', { name: 'Review download' })).toBeVisible();
  expect(plans).toBe(1);
  expect(installs).toBe(0);
  await page.getByRole('button', { name: 'Download and install', exact: true }).click();
  await expect(page.getByText('Synthetic verification failure', { exact: true })).toBeVisible();
  await expect(page.locator('.tts-install-progress')).toHaveAttribute('data-state', 'failed');
  await page.locator('#tts-streamingEnabled').uncheck();
  await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(serverContext.baseUrl + '/api/tts/settings')).json())
          .streamingEnabled,
    )
    .toBe(false);
  await page.locator('#settings-tab-server').click();
  await page.locator('#settings-tab-tts').click();
  await expect(page.locator('#tts-streamingEnabled')).not.toBeChecked();
  await expect(page.locator('.toast')).toHaveCount(0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`tts-settings-${theme}-1440.png`),
    });
    await page.setViewportSize({ width: 680, height: 650 });
    if ((await page.locator('.app').getAttribute('data-sidebar-open')) === 'true')
      await page.keyboard.press('Escape');
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath(`tts-settings-${theme}-680.png`),
    });
  }
  await page.locator('#settings-tab-server').click();
  await page.locator('#interface-language').selectOption('hu');
  await page.locator('#settings-tab-tts').click();
  await expect(page.locator('#tts-enabled-label')).toHaveText('Szövegfelolvasás engedélyezése');
  await page.locator('#settings-tab-server').click();
  await page.locator('#interface-language').selectOption('de');
  await page.locator('#settings-tab-tts').click();
  await expect(page.locator('#tts-enabled-label')).toHaveText('Sprachausgabe aktivieren');
  await page.locator('#settings-tab-server').click();
  await page.locator('#interface-language').selectOption('en');
  await page.request.patch(serverContext.baseUrl + '/api/tts/settings', {
    data: { settings: { enabled: false, streamingEnabled: true } },
  });
});

test('speech reads full collapsed source and transport controls keep their width at both viewport sizes', async ({
  page,
  serverContext,
}, testInfo) => {
  await page.request.patch(serverContext.baseUrl + '/api/tts/settings', {
    data: {
      settings: {
        enabled: true,
        streamingEnabled: true,
        cacheEnabled: false,
        showPillSettings: true,
        showPillSpeed: true,
        showPillVolume: true,
      },
    },
  });
  const text = 'This is a synthetic long paragraph. '.repeat(90) + 'Full tail marker.';
  await page.route('**/api/thread?**', (route) =>
    route.fulfill({
      json: {
        turns: [{ ai: text }],
        collection: 'synthetic',
        sourceFile: 'test.json',
        conversationKey: 'key',
        createdInThreadShelf: false,
      },
    }),
  );
  let payload;
  await page.route('**/api/tts/synthesize', async (route) => {
    payload = route.request().postDataJSON();
    const audioBase64 = wave();
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body:
        [
          {
            type: 'event',
            event: { state: 'started', requestId: payload.requestId, purpose: 'conversation' },
          },
          {
            type: 'event',
            event: {
              state: 'audio',
              requestId: payload.requestId,
              purpose: 'conversation',
              clipIndex: 0,
              mime: 'audio/wav',
              audioBase64,
            },
          },
          {
            type: 'result',
            result: {
              requestId: payload.requestId,
              complete: true,
              streamed: true,
              mime: 'audio/wav',
              audioBase64,
              cacheKey: null,
              stored: false,
              recording: { provider: 'pocket', voice: 'alba' },
            },
          },
        ]
          .map((row) => JSON.stringify(row))
          .join('\n') + '\n',
    });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    serverContext.baseUrl + '/thread?collection=synthetic&sourceFile=test.json&conversationKey=key',
  );
  await expect(page.locator('.tts-read-button')).toHaveCount(1);
  await page.locator('.tts-read-button').click();
  await expect(page.locator('.tts-pill')).toBeVisible();
  await expect(page.locator('.tts-pill-label')).toContainText('pocket');
  expect(
    (await page.locator('.tts-pill .sr-only').first().boundingBox()).width,
  ).toBeLessThanOrEqual(1);
  expect(payload.text).toContain('Full tail marker.');
  expect(payload.messageId).toBe('0:ai');
  expect(payload.messageFingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 680, height: 540 },
  ]) {
    await page.setViewportSize(viewport);
    const play = page.locator('[data-tts-control=play]');
    const before = await play.boundingBox();
    await play.click();
    const after = await play.boundingBox();
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .locator('.tts-pill')
        .evaluate(
          (element) =>
            element.getBoundingClientRect().right <= innerWidth &&
            element.getBoundingClientRect().left >= 0,
        ),
    ).toBe(true);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      await page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath(`tts-player-${theme}-${viewport.width}.png`),
      });
    }
  }
  await page.locator('[data-tts-control=settings]').click();
  await expect(page.locator('#settings-tab-tts')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tts-pill')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.request.patch(serverContext.baseUrl + '/api/tts/settings', {
    data: { settings: { enabled: false } },
  });
});

test('LAN speech uses a tab-only bearer key and never exposes management controls', async ({
  page,
  serverContext,
}) => {
  const defaults = await (
    await page.request.get(serverContext.baseUrl + '/api/tts/settings')
  ).json();
  const key = 'synthetic-tab-only-access-key';
  let seenAuthorization = '';
  await page.route('**/api/tts/settings', (route) =>
    route.fulfill({
      json: {
        ...defaults,
        enabled: true,
        provider: 'pocket',
        voice: 'alba',
        access: { canManage: false, networkPlaybackEnabled: true, requiresApiKey: true },
      },
    }),
  );
  await page.route('**/api/tts/assets', (route) =>
    route.fulfill({
      json: {
        supported: true,
        platform: 'linux-x64',
        engines: { pocket: { installed: true }, kokoro: { installed: true } },
        busy: false,
      },
    }),
  );
  await page.route('**/api/tts/invoke', async (route) => {
    seenAuthorization = route.request().headers().authorization ?? '';
    const body = route.request().postDataJSON();
    expect(body.action).toBe('tts.availability');
    expect(body.args.private).toBe(true);
    await route.fulfill({ json: { revision: 0, items: [] } });
  });
  await page.goto(serverContext.baseUrl + '/settings');
  await page.locator('#settings-tab-tts').click();
  await expect(page.getByRole('heading', { name: 'Speech from this server' })).toBeVisible();
  await expect(page.locator('#tts-enabled')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save speech settings', exact: true })).toHaveCount(
    0,
  );
  await page.locator('#tts-network-key').fill(key);
  await page.getByRole('button', { name: 'Connect speech', exact: true }).click();
  await expect(page.locator('#tts-network-key')).toHaveValue('');
  expect(seenAuthorization).toBe('Bearer ' + key);
  expect(
    await page.evaluate(() =>
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
    ),
  ).not.toContain(key);
  await page.getByRole('button', { name: 'Forget key', exact: true }).click();
  await expect(page.getByText('Access key forgotten for this tab.', { exact: true })).toBeVisible();
});

test('speech test controls and level meter stay inside a 320px viewport in English and Hungarian', async ({
  page,
  serverContext: { baseUrl },
}) => {
  await page.setViewportSize({ width: 320, height: 650 });
  await page.goto(`${baseUrl}/settings`);
  for (const locale of ['en', 'hu']) {
    await page.locator('#settings-tab-server').click();
    await page.locator('#interface-language').selectOption(locale);
    await page.locator('#settings-tab-tts').click();
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
      for (const subtab of ['providers', 'test']) {
        await page.locator(`#ttsTab-${subtab}`).click();
        await expect(page.locator('#ttsTestMeter')).toBeVisible();
        const geometry = await page.locator('.main-scroll').evaluate((main) => ({
          width: main.clientWidth,
          scroll: main.scrollWidth,
          controls: [...main.querySelectorAll('.tts-test-controls button, #ttsTestLevel')].map(
            (element) => {
              const box = element.getBoundingClientRect();
              return {
                left: box.left,
                right: box.right,
                client: element.clientWidth,
                scroll: element.scrollWidth,
              };
            },
          ),
        }));
        expect(geometry.scroll, `${locale}/${theme}/${subtab}`).toBeLessThanOrEqual(
          geometry.width + 1,
        );
        for (const control of geometry.controls) {
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeLessThanOrEqual(320);
          expect(control.scroll).toBeLessThanOrEqual(control.client + 1);
        }
      }
    }
  }
});

test('all speech locales retain complete labels and stable playback controls at narrow widths', async ({
  page,
  serverContext: { baseUrl },
}) => {
  await page.request.patch(`${baseUrl}/api/tts/settings`, {
    data: { settings: { enabled: true, streamingEnabled: true, cacheEnabled: false } },
  });
  await page.route('**/api/tts/invoke', async (route) => {
    if (route.request().postDataJSON().action !== 'tts.cache.list') return route.continue();
    await route.fulfill({
      json: {
        entries: [],
        totalBytes: 0,
        session: { count: 1, totalBytes: 1024, maxEntries: 3, maxBytes: 67108864 },
      },
    });
  });
  await page.route('**/api/thread?**', (route) =>
    route.fulfill({
      json: {
        turns: Array.from({ length: 12 }, (_, index) => ({
          ai: `Synthetic message ${index + 1}. `.repeat(12),
        })),
        collection: 'synthetic',
        sourceFile: 'layout.json',
        conversationKey: 'key',
        createdInThreadShelf: false,
      },
    }),
  );
  await page.route('**/api/tts/synthesize', async (route) => {
    const { requestId } = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify({
          type: 'result',
          result: {
            requestId,
            complete: true,
            streamed: false,
            mime: 'audio/wav',
            audioBase64: wave(),
            cacheKey: null,
            stored: false,
            recording: { provider: 'pocket', voice: 'alba' },
          },
        }) + '\n',
    });
  });
  const assertComplete = async (selector) => {
    const clipped = await page.locator(selector).evaluateAll((elements) =>
      elements
        .filter((element) => {
          const style = getComputedStyle(element),
            box = element.getBoundingClientRect();
          return (
            box.width > 1 &&
            style.visibility !== 'hidden' &&
            !element.closest('[hidden]') &&
            (element.scrollWidth > element.clientWidth + 1 ||
              element.scrollHeight > element.clientHeight + 1 ||
              box.left < 0 ||
              box.right > innerWidth + 1)
          );
        })
        .map((element) => element.textContent.trim()),
    );
    expect(clipped).toEqual([]);
  };
  for (const locale of ['en', 'hu', 'de', 'fr', 'ru', 'ja']) {
    await page.setViewportSize({ width: 320, height: 650 });
    await page.goto(`${baseUrl}/settings`);
    await page.locator('#settings-tab-server').click();
    await page.locator('#interface-language').selectOption(locale);
    await page.locator('#settings-tab-tts').click();
    await page.locator('#ttsTab-providers').click();
    await page.locator('#tts-provider').selectOption('selfhosted');
    const selected = page.locator('#tts-provider + .native-select-value');
    await expect(selected).toHaveText(
      await page.locator('#tts-provider').evaluate((select) => select.selectedOptions[0].label),
    );
    await assertComplete('.tts-settings .native-select-value, .tts-subtabs button');
    await page.locator('#ttsTab-cache').click();
    await expect(page.locator('#tts-cacheScope')).toHaveValue('all');
    await expect(page.locator('#tts-cacheScope + .native-select-value')).toHaveText(
      await page.locator('#tts-cacheScope').evaluate((select) => select.selectedOptions[0].label),
    );
    await page.goto(
      `${baseUrl}/thread?collection=synthetic&sourceFile=layout.json&conversationKey=key`,
    );
    const read = page.locator('.tts-read-button').first();
    await read.waitFor();
    const idle = await read.boundingBox();
    await read.click();
    await expect(read).toBeDisabled();
    const preparing = await read.boundingBox();
    expect(preparing.width).toBe(idle.width);
    expect(preparing.height).toBe(idle.height);
    await expect(read.locator('svg')).toHaveAttribute('viewBox', '0 0 75 75');
    await expect(read).toHaveText('');
    await expect(read).toHaveAttribute('aria-busy', 'true');
    await expect(read).toHaveAttribute('aria-label', /.+/);
    await expect(read).toBeEnabled();
    await page.locator('.tts-pill').waitFor();
    for (const width of [320, 680, 1440]) {
      await page.setViewportSize({ width, height: 650 });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await assertComplete('.tts-pill-label, .tts-pill-status');
        const play = page.locator('[data-tts-control=play]');
        const before = await play.boundingBox();
        await play.click();
        const after = await play.boundingBox();
        expect(after.width).toBe(before.width);
        expect(after.height).toBe(before.height);
        await page.locator('.thread-inner').evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect
          .poll(async () =>
            page.evaluate(() => {
              const scroller = document.querySelector('.thread-inner');
              scroller.scrollTop = scroller.scrollHeight;
              const last = document.querySelector('.thread-end').getBoundingClientRect(),
                player = document.querySelector('.tts-pill').getBoundingClientRect();
              return last.bottom <= player.top && last.bottom > 0;
            }),
          )
          .toBe(true);
        await expect
          .poll(async () =>
            page.evaluate(() => {
              const turns = document.querySelectorAll('.turn'),
                last = turns[turns.length - 1];
              last.scrollIntoView({ block: 'end' });
              const bounds = last.getBoundingClientRect(),
                player = document.querySelector('.tts-pill').getBoundingClientRect();
              return bounds.bottom <= player.top && bounds.bottom > 0;
            }),
          )
          .toBe(true);
      }
    }
    await page.locator('[data-tts-control=close]').click();
    await expect(page.locator('.main')).not.toHaveClass(/tts-player-visible/);
    expect(
      await page
        .locator('.main')
        .evaluate((element) => element.style.getPropertyValue('--tts-player-space')),
    ).toBe('');
  }
});
