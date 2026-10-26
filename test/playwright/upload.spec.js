import { test, expect } from './fixtures.js';
import { mkdtemp, copyFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures');

test.describe('Upload + ingest UI flow', () => {
  test('can cancel a pending job submission without claiming that an accepted job was cancelled', async ({
    appPage,
  }) => {
    let releaseResponse;
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve;
    });
    await appPage.route('**/api/import-jobs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await responseGate;
      await route
        .fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ job: { id: 'synthetic-pending-submission', state: 'queued' } }),
        })
        .catch(() => {});
    });

    await appPage.locator('#indexingNavBtn').click();
    await appPage.getByPlaceholder('/absolute/path/to/exports').fill('C:\\fixture\\exports');
    await appPage.locator('#ingestBtn').click();
    await expect(appPage.locator('#stopIngestBtn')).toBeVisible();
    await appPage.locator('#stopIngestBtn').click();
    await expect(appPage.locator('#ingestStatus')).toContainText('Transfer stopped');
    releaseResponse();
  });

  test('uploading a folder of exports adds a new collection', async ({ appPage }) => {
    // Disable the duplicate-confirm prompt (we don't expect any).
    await appPage.evaluate(() => {
      window.confirm = () => true;
    });

    // webkitdirectory inputs require a real directory path in Playwright.
    const root = await mkdtemp(join(tmpdir(), 'pw-upload-'));
    const subdir = join(root, 'upload_alpha');
    await mkdir(subdir, { recursive: true });
    await copyFile(join(fixturesDir, 'gemini-polish.json'), join(subdir, 'conversation.json'));

    try {
      await appPage.locator('#indexingNavBtn').click();
      await appPage.locator('#folderFileInput').setInputFiles(subdir);
      await expect(appPage.locator('#folderChosenLabel')).not.toBeEmpty({ timeout: 5000 });
      await appPage.locator('#ingestBtn').click();
      await expect(appPage.locator('#ingestStatus')).toBeVisible({ timeout: 90_000 });
      await expect(appPage.locator('#ingestStatus')).toContainText(/Indexed|done|complet/i, {
        timeout: 90_000,
      });

      await appPage.waitForFunction(
        async () => {
          const res = await fetch('/api/collections');
          const data = await res.json();
          return (data.collections || []).some((name) => name === 'upload_alpha');
        },
        undefined,
        { timeout: 30_000 },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
