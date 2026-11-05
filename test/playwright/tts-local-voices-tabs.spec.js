import { test, expect } from '@playwright/test';
import { startApiServer } from '../e2e/helpers.js';

test('local voice review, provider drafts and active installs survive subtab navigation', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'tts-local-tabs-' });
  let plans = 0,
    installs = 0,
    installed = false,
    finishInstall;
  const installPending = new Promise((resolve) => {
    finishInstall = resolve;
  });
  await page.route('**/api/tts/assets', (route) =>
    route.fulfill({
      json: {
        supported: true,
        platform: 'linux-x64',
        busy: false,
        engines: { pocket: { installed }, kokoro: { installed: false } },
      },
    }),
  );
  await page.route('**/api/tts/assets/plan', async (route) => {
    plans++;
    const engines = route.request().postDataJSON().engines;
    await route.fulfill({
      json: {
        fingerprint: 'synthetic-subtab-review',
        engines,
        requestedEngines: engines,
        platform: 'linux-x64',
        downloadBytes: 1024,
        requiredFreeBytes: 4096,
        files: [{ name: 'synthetic-voice', bytes: 1024, cached: false }],
        licenses: ['Synthetic browser fixture'],
      },
    });
  });
  await page.route('**/api/tts/assets/install', async (route) => {
    installs++;
    await installPending;
    installed = true;
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body: JSON.stringify({ type: 'result', result: { installed: ['pocket'] } }) + '\n',
    });
  });
  try {
    await page.request.patch(app.baseUrl + '/api/tts/settings', {
      data: { settings: { enabled: true, streamingEnabled: true } },
    });
    await page.goto(app.baseUrl + '/settings');
    await page.locator('#settings-tab-tts').click();
    const localVoices = page.locator('.tts-assets');
    await expect(localVoices).toHaveCount(1);
    await expect(localVoices).toBeHidden();
    await page.locator('#ttsTab-providers').click();
    await expect(localVoices).toBeVisible();
    await localVoices.evaluate((element) => {
      element.dataset.testMount = 'retained';
    });
    // Availability of local packs is independent of the chosen speech provider.
    await page.locator('#tts-provider').selectOption('selfhosted');
    await expect(localVoices).toBeVisible();
    const kokoro = localVoices.getByRole('checkbox', { name: /Kokoro/ });
    await kokoro.uncheck();
    await localVoices
      .getByRole('button', { name: 'Download / repair local voices', exact: true })
      .click();
    await expect(localVoices.getByRole('heading', { name: 'Review download' })).toBeVisible();
    expect(plans).toBe(1);
    expect(installs).toBe(0);
    for (const subtab of ['playback', 'test', 'cache']) {
      await page.locator(`#ttsTab-${subtab}`).click();
      await expect(localVoices).toBeHidden();
      await expect(localVoices).toHaveAttribute('data-test-mount', 'retained');
      await expect(localVoices.locator('.tts-install-review')).toHaveCount(1);
    }
    await page.locator('#ttsTab-providers').click();
    await expect(localVoices).toBeVisible();
    await expect(kokoro).not.toBeChecked();
    await expect(page.locator('#tts-provider')).toHaveValue('selfhosted');
    await expect(localVoices.getByRole('heading', { name: 'Review download' })).toBeVisible();
    await localVoices.getByRole('button', { name: 'Download and install', exact: true }).click();
    await expect.poll(() => installs).toBe(1);
    for (const subtab of ['test', 'cache', 'playback']) {
      await page.locator(`#ttsTab-${subtab}`).click();
      await expect(localVoices).toBeHidden();
    }
    await page.locator('#ttsTab-providers').click();
    await expect(
      localVoices.getByRole('button', { name: 'Cancel download', exact: true }),
    ).toBeVisible();
    await expect(localVoices).toHaveAttribute('data-test-mount', 'retained');
    finishInstall();
    await expect(localVoices.locator('.tts-install-progress')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect(
      localVoices
        .locator('.tts-engine-card')
        .filter({ hasText: 'Pocket TTS' })
        .getByText('Installed', { exact: true }),
    ).toBeVisible();
    expect(plans).toBe(1);
    expect(installs).toBe(1);
    await page.locator('#ttsTab-playback').click();
    await page.locator('#tts-enabled').uncheck();
    await page.getByRole('button', { name: 'Save speech settings', exact: true }).click();
    await expect(localVoices).toHaveCount(0);
  } finally {
    finishInstall();
    await app.stop();
  }
});
