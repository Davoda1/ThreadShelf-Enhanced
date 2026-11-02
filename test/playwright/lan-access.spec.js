/* global document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { networkInterfaces } from 'node:os';
import { startApiServer } from '../e2e/helpers.js';

const lanAddress = (() => {
  try {
    return Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
  } catch {
    // Restricted containers may refuse even the interface-list system call.
    return undefined;
  }
})();

async function startLanServer(enabled, page, testInfo, env = {}) {
  const app = await startApiServer({
    prefix: 'lan-browser-',
    env: {
      HOST: '0.0.0.0',
      ALLOWED_HOSTS: lanAddress || '',
      ALLOW_LAN_AI: enabled ? '1' : '0',
      ALLOW_LAN_TTS: enabled ? '1' : '0',
      ...env,
    },
  });
  if (!lanAddress) {
    // Some CI runners expose no non-loopback interface. Forwarded addresses
    // still exercise the server's remote-access policy, but label the fallback.
    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': '192.0.2.99' });
    testInfo.annotations.push({ type: 'network', description: 'Forwarded LAN simulation' });
  } else {
    testInfo.annotations.push({ type: 'network', description: 'Non-loopback IPv4 connection' });
  }
  const url = new URL(app.baseUrl);
  if (lanAddress) url.hostname = lanAddress;
  return { ...app, lanUrl: url.origin };
}

async function expectSettingsFit(page) {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    content: [...document.querySelectorAll('.settings-page, .settings-stack')].map((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    })),
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  for (const element of dimensions.content)
    expect(element.scroll).toBeLessThanOrEqual(element.width + 1);
  const widths = await page
    .locator('.settings-tabs button')
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().width));
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  return widths;
}

test('headless LAN settings enable AI and speech independently of API keys without automatic downloads', async ({
  page,
}, testInfo) => {
  const app = await startLanServer(true, page, testInfo);
  try {
    let plans = 0;
    let installs = 0;
    await page.route('**/api/tts/assets/plan', async (route) => {
      plans += 1;
      const engines = route.request().postDataJSON().engines;
      await route.fulfill({
        json: {
          fingerprint: 'synthetic-lan-review',
          engines,
          requestedEngines: engines,
          platform: 'linux-x64',
          downloadBytes: 1024,
          requiredFreeBytes: 4096,
          files: [{ name: 'synthetic-voice-download', bytes: 1024, cached: false }],
          licenses: ['Synthetic browser review fixture'],
        },
      });
    });
    page.on('request', (request) => {
      if (request.url().endsWith('/api/tts/assets/install')) installs += 1;
    });
    await page.goto(app.lanUrl + '/settings');
    await expect(page.getByRole('heading', { name: 'Conversation generation' })).toBeVisible();
    const saveAi = page.getByRole('button', { name: 'Save generation settings', exact: true });
    await expect(saveAi).toBeEnabled();
    const savedAi = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/generation/config') && response.request().method() === 'PUT',
    );
    await saveAi.click();
    expect((await savedAi).status()).toBe(200);

    await page.locator('#settings-tab-tts').click();
    await expect(page.locator('#tts-enabled')).not.toBeChecked();
    await expect(page.locator('#tts-streamingEnabled')).toBeChecked();
    await expect(page.locator('.tts-network-panel')).toHaveCount(0);
    await page.locator('#tts-enabled').check();
    await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
    await expect(page.locator('.tts-assets')).toBeVisible();
    expect(plans).toBe(0);
    expect(installs).toBe(0);
    await page.locator('#tts-streamingEnabled').uncheck();
    await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
    await expect
      .poll(async () => {
        const result = await page.request.get(app.lanUrl + '/api/tts/settings');
        return (await result.json()).streamingEnabled;
      })
      .toBe(false);
    await page.reload();
    await page.locator('#settings-tab-tts').click();
    await expect(page.locator('#tts-enabled')).toBeChecked();
    await expect(page.locator('#tts-streamingEnabled')).not.toBeChecked();

    for (const width of [320, 680, 1440]) {
      await page.setViewportSize({ width, height: 850 });
      await page.keyboard.press('Escape');
      const before = await expectSettingsFit(page);
      await page.locator('#settings-tab-ai').click();
      expect(await expectSettingsFit(page)).toEqual(before);
      await page.locator('#settings-tab-server').click();
      expect(await expectSettingsFit(page)).toEqual(before);
      await page.locator('#settings-tab-tts').click();
      expect(await expectSettingsFit(page)).toEqual(before);
    }
    await page.getByRole('button', { name: 'Download / repair local voices', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review download' })).toBeVisible();
    expect(plans).toBe(1);
    expect(installs).toBe(0);
  } finally {
    await app.stop();
  }
});

test('LAN speech settings remain usable when AI management is disabled', async ({
  page,
}, testInfo) => {
  const app = await startLanServer(false, page, testInfo, { ALLOW_LAN_TTS: '1' });
  try {
    const rejectedAi = page.waitForResponse((response) =>
      response.url().endsWith('/api/generation/config'),
    );
    await page.goto(app.lanUrl + '/settings');
    expect((await rejectedAi).status()).toBe(403);
    await page.locator('#settings-tab-tts').click();
    await expect(page.locator('#tts-enabled')).not.toBeChecked();
    await expect(page.locator('.tts-network-panel')).toHaveCount(0);
    await page.locator('#tts-enabled').check();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/tts/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.locator('.tts-assets')).toBeVisible();
    await page.reload();
    await page.locator('#settings-tab-tts').click();
    await expect(page.locator('#tts-enabled')).toBeChecked();
  } finally {
    await app.stop();
  }
});

test('disabled LAN speech explains the env opt-in without clipped text in all six locales', async ({
  page,
}, testInfo) => {
  const app = await startLanServer(false, page, testInfo);
  try {
    await page.goto(app.lanUrl + '/settings');
    for (const locale of ['en', 'hu', 'de', 'fr', 'ru', 'ja']) {
      await page.locator('#settings-tab-server').click();
      await page.locator('#interface-language').selectOption(locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await page.locator('#settings-tab-tts').click();
      await expect(page.locator('.tts-network-panel')).toBeVisible();
      await expect(page.locator('.tts-network-panel .banner')).toContainText('ALLOW_LAN_TTS=1');
      await expect(page.locator('#tts-enabled')).toHaveCount(0);
      for (const width of [320, 680, 1440]) {
        await page.setViewportSize({ width, height: 850 });
        await page.keyboard.press('Escape');
        await expectSettingsFit(page);
        const blocks = await page
          .locator('.tts-network-panel .tts-help, .tts-network-panel .banner')
          .evaluateAll((elements) =>
            elements.map((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              const content = range.getBoundingClientRect();
              const box = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                width: element.clientWidth,
                scrollWidth: element.scrollWidth,
                height: element.clientHeight,
                scrollHeight: element.scrollHeight,
                textInside:
                  content.left >= box.left - 1 &&
                  content.right <= box.right + 1 &&
                  content.top >= box.top - 1 &&
                  content.bottom <= box.bottom + 1,
                overflowY: style.overflowY,
              };
            }),
          );
        for (const block of blocks) {
          expect(block.scrollWidth).toBeLessThanOrEqual(block.width + 1);
          expect(block.textInside).toBe(true);
          if (['hidden', 'clip'].includes(block.overflowY))
            expect(block.scrollHeight).toBeLessThanOrEqual(block.height + 1);
        }
      }
    }
  } finally {
    await app.stop();
  }
});
