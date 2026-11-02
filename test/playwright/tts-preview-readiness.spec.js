/* global document, window, Event, getComputedStyle */
import { test, expect } from '@playwright/test';
import { startApiServer } from '../e2e/helpers.js';

const assets = (pocket = false, kokoro = false) => ({
  supported: true,
  platform: 'linux-x64',
  busy: false,
  engines: { pocket: { installed: pocket }, kokoro: { installed: kokoro } },
});
const button = (page) => page.locator('[data-tts-action=test]');
const availability = (page) => page.locator('#ttsTestAvailability');
const openSpeech = async (page, app) => {
  await page.goto(app.baseUrl + '/settings');
  await page.locator('#settings-tab-tts').click();
  await page.locator('#ttsTab-providers').click();
};
const refresh = async (page) => {
  const response = page.waitForResponse((value) => value.url().endsWith('/api/tts/assets'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await response;
};

test('CPU audio tests wait for verified assets and a disabled-button bypass cannot start synthesis', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'tts-preview-missing-' });
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let previews = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/tts/preview')) previews++;
  });
  await page.route('**/api/tts/assets', async (route) => {
    await pending;
    await route.fulfill({ json: assets() });
  });
  try {
    await openSpeech(page, app);
    await expect(button(page)).toBeDisabled();
    await expect(availability(page)).toHaveText('Checking local voice installation…');
    await expect(page.locator('#ttsTestStatus')).toBeHidden();
    release();
    await expect(availability(page)).toContainText('Pocket TTS is not installed and verified.');
    await expect(button(page)).toBeDisabled();
    // This bypasses the HTML disabled state; startTest itself must still refuse.
    await button(page).evaluate((element) => {
      element.disabled = false;
      element.click();
    });
    await expect(page.locator('#ttsSettingsStatus')).toContainText(
      'Pocket TTS is not installed and verified.',
    );
    await expect(button(page)).toBeDisabled();
    expect(previews).toBe(0);
    await page.locator('#tts-provider').selectOption('kokoro');
    await expect(button(page)).toBeDisabled();
    await expect(availability(page)).toContainText('Kokoro is not installed and verified.');
  } finally {
    release();
    await app.stop();
  }
});

test('CPU readiness is engine-specific, refresh failures clear stale readiness and API tests remain available', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'tts-preview-engines-' });
  let status = assets(true, false),
    fail = false;
  await page.route('**/api/tts/assets', async (route) => {
    await route.fulfill(
      fail ? { status: 503, json: { error: 'Synthetic status unavailable' } } : { json: status },
    );
  });
  try {
    await openSpeech(page, app);
    await expect(button(page)).toBeEnabled();
    await expect(page.locator('#tts-enabled')).not.toBeChecked();
    const readyBox = await button(page).boundingBox();
    await page.locator('#tts-provider').selectOption('kokoro');
    await expect(button(page)).toBeDisabled();
    const missingBox = await button(page).boundingBox();
    expect(missingBox.width).toBe(readyBox.width);
    expect(missingBox.height).toBe(readyBox.height);
    await page.locator('#tts-provider').selectOption('selfhosted');
    await expect(button(page)).toBeEnabled();
    await expect(availability(page)).toBeHidden();
    await expect(page.locator('#ttsTestStatus')).toBeVisible();
    await page.locator('#tts-provider').selectOption('pocket');
    status = {
      ...assets(),
      engines: {
        pocket: { installed: false, error: 'Synthetic damaged asset' },
        kokoro: { installed: false },
      },
    };
    await refresh(page);
    await expect(button(page)).toBeDisabled();
    status = assets(true, false);
    await refresh(page);
    await expect(button(page)).toBeEnabled();
    fail = true;
    await refresh(page);
    await expect(button(page)).toBeDisabled();
    await expect(availability(page)).toContainText('Local voice status is unavailable.');
    await expect(page.getByRole('alert')).toContainText('Synthetic status unavailable');
    fail = false;
    await refresh(page);
    await expect(button(page)).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    fail = true;
    await refresh(page);
    await expect(button(page)).toBeDisabled();
    await page.locator('#tts-provider').selectOption('selfhosted');
    await expect(button(page)).toBeEnabled();
  } finally {
    await app.stop();
  }
});

test('reviewed install and removal refresh CPU test availability, including a failed installation', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'tts-preview-install-' });
  let status = assets(),
    failedInstall = true;
  await page.route('**/api/tts/assets', (route) => route.fulfill({ json: status }));
  await page.route('**/api/tts/assets/plan', (route) =>
    route.fulfill({
      json: {
        fingerprint: 'synthetic-preview-readiness',
        engines: ['pocket'],
        requestedEngines: ['pocket'],
        platform: 'linux-x64',
        downloadBytes: 1024,
        requiredFreeBytes: 4096,
        files: [{ name: 'synthetic-voice', bytes: 1024, cached: false }],
        licenses: ['Synthetic test fixture'],
      },
    }),
  );
  await page.route('**/api/tts/assets/install', (route) => {
    if (!failedInstall) status = assets(true, false);
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body:
        JSON.stringify(
          failedInstall
            ? { type: 'error', error: 'Synthetic install verification failure' }
            : { type: 'result', result: status },
        ) + '\n',
    });
  });
  await page.route('**/api/tts/assets/uninstall', (route) => {
    status = assets();
    return route.fulfill({ json: status });
  });
  try {
    await openSpeech(page, app);
    await expect(button(page)).toBeDisabled();
    await page.locator('#ttsTab-playback').click();
    await page.locator('#tts-enabled').check();
    await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
    await page.locator('#ttsTab-providers').click();
    await expect(button(page)).toBeDisabled();
    await page.getByRole('button', { name: 'Download / repair local voices', exact: true }).click();
    await page.getByRole('button', { name: 'Download and install', exact: true }).click();
    await expect(
      page.getByText('Synthetic install verification failure', { exact: true }),
    ).toBeVisible();
    await expect(button(page)).toBeDisabled();
    failedInstall = false;
    await page.getByRole('button', { name: 'Download and install', exact: true }).click();
    await expect(button(page)).toBeEnabled();
    const readyBox = await button(page).boundingBox();
    await page
      .locator('.tts-engine-card')
      .filter({ hasText: 'Pocket TTS' })
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(button(page)).toBeDisabled();
    await expect(availability(page)).toContainText('Pocket TTS is not installed and verified.');
    const removedBox = await button(page).boundingBox();
    expect(removedBox.width).toBe(readyBox.width);
    expect(removedBox.height).toBe(readyBox.height);
  } finally {
    await app.stop();
  }
});

test('CPU test guidance is localized and fits narrow screens without clipping', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'tts-preview-locales-' });
  try {
    await page.goto(app.baseUrl + '/settings');
    for (const locale of ['en', 'hu', 'de', 'fr', 'ru', 'ja']) {
      await page.locator('#settings-tab-server').click();
      await page.locator('#interface-language').selectOption(locale);
      await page.locator('#settings-tab-tts').click();
      await page.locator('#ttsTab-providers').click();
      await expect(button(page)).toBeDisabled();
      await expect(availability(page)).toContainText('Pocket TTS');
      if (locale !== 'en')
        await expect(availability(page)).not.toContainText('is not installed and verified');
      for (const width of [320, 680, 1440]) {
        await page.setViewportSize({ width, height: 650 });
        await page.keyboard.press('Escape');
        const layout = await availability(page).evaluate((element) => {
          const bounds = element.getBoundingClientRect(),
            style = getComputedStyle(element);
          const range = document.createRange();
          range.selectNodeContents(element);
          const text = range.getBoundingClientRect();
          return {
            width: element.clientWidth,
            scroll: element.scrollWidth,
            height: element.clientHeight,
            scrollHeight: element.scrollHeight,
            overflowY: style.overflowY,
            contained:
              text.left >= bounds.left - 1 &&
              text.right <= bounds.right + 1 &&
              text.top >= bounds.top - 1 &&
              text.bottom <= bounds.bottom + 1,
            pageWidth: document.documentElement.clientWidth,
            pageScroll: document.documentElement.scrollWidth,
          };
        });
        expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
        expect(layout.contained).toBe(true);
        expect(layout.pageScroll).toBeLessThanOrEqual(layout.pageWidth + 1);
        if (['hidden', 'clip'].includes(layout.overflowY))
          expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
      }
    }
  } finally {
    await app.stop();
  }
});
