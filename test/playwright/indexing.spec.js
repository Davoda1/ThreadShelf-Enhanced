import { test, expect } from './fixtures.js';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.describe('Indexing page extras', () => {
  test('export-guide panel shows LM Studio path and the OpenRouter script is served', async ({
    appPage,
  }) => {
    await appPage.locator('#indexingNavBtn').click();

    // The "Where to get your data" guide includes the LM Studio conversation path.
    await appPage.getByText('Where to get your data').click();
    await expect(appPage.getByText(/%USERPROFILE%.*lmstudio.*conversations/)).toBeVisible();

    // The copy buttons pull the real script from the server's /scripts route.
    const status = await appPage.evaluate(async () => {
      const res = await fetch('/scripts/openrouter-export-all.js');
      return { ok: res.ok, body: await res.text() };
    });
    expect(status.ok).toBe(true);
    expect(status.body).toContain("platform: 'openrouter'");
  });

  test('creating a collection from the indexing dropdown selects it as the target', async ({
    appPage,
  }) => {
    await appPage.locator('#indexingNavBtn').click();
    await appPage.locator('#newCollectionBtnIndexing').click();

    await appPage.getByPlaceholder('my-archive').fill('idx_made');
    await appPage.getByRole('button', { name: 'Create' }).click();

    await expect(appPage.locator('#targetCollectionSelect')).toHaveValue('idx_made', {
      timeout: 15_000,
    });
  });

  test('target collection stays a labelled native select with centered text and no arrow', async ({
    appPage,
  }) => {
    await appPage.locator('#indexingNavBtn').click();
    const target = appPage.getByRole('combobox', { name: 'Target collection' });
    const appearance = await target.evaluate((select) => {
      const wrapper = select.closest('.native-select');
      const style = getComputedStyle(wrapper);
      return {
        minWidth: parseFloat(style.minWidth),
        fontSize: parseFloat(style.fontSize),
        align: style.textAlign,
        arrow: getComputedStyle(wrapper, '::after').content,
      };
    });
    expect(appearance.minWidth).toBeGreaterThanOrEqual(appearance.fontSize * 8);
    expect(appearance.align).toBe('center');
    expect(appearance.arrow).toBe('none');
    await appPage.locator('label[for="targetCollectionSelect"]').click();
    await expect(target).toBeFocused();
    await target.selectOption('pw_fixture');
    await expect(appPage.locator('.target-collection-select .native-select-value')).toHaveText(
      'pw_fixture',
    );
    await expect(appPage.locator('#ingestBtn')).toHaveText('Start import');
  });

  test('path and target edits invalidate previews and late responses cannot overwrite newer choices', async ({
    appPage,
  }) => {
    const delayed = deferred();
    const lateFinished = deferred();
    const beforePick = deferred();
    const pickFinished = deferred();
    const requests = [];
    await appPage.route('**/api/ingest-preview?*', async (route) => {
      const url = new URL(route.request().url());
      const folder = url.searchParams.get('folderPath');
      requests.push({ folder, collection: url.searchParams.get('collection') });
      if (folder === '/demo/old') await delayed.promise;
      if (folder === '/demo/before-pick') await beforePick.promise;
      await route
        .fulfill({
          json: {
            collection: url.searchParams.get('collection'),
            files: [`${folder}/${folder.split('/').pop()}.json`],
            duplicates:
              folder === '/demo/initial' ? [{ sourceFile: `${folder}/initial.json` }] : [],
          },
        })
        .catch(() => {}); // An invalidated preview is intentionally aborted.
      if (folder === '/demo/old') lateFinished.resolve();
      if (folder === '/demo/before-pick') pickFinished.resolve();
    });
    await appPage.locator('#indexingNavBtn').click();
    const path = appPage.getByPlaceholder('/absolute/path/to/exports');
    const usePath = appPage.getByRole('button', { name: 'Use path', exact: true });
    try {
      await path.fill('/demo/initial');
      await usePath.click();
      await expect(appPage.locator('#folderChosenLabel')).toHaveText(
        '1 export files found; 1 will be re-indexed',
      );
      await expect(appPage.locator('.ingest-preview-note')).toHaveText('re-index');
      await appPage.locator('#targetCollectionSelect').selectOption('pw_fixture');
      await expect(appPage.locator('.ingest-preview-row')).toHaveCount(0);
      await expect(appPage.locator('#folderChosenLabel')).toHaveCount(0);

      await path.fill('/demo/old');
      await usePath.click();
      await expect
        .poll(() => requests.some((request) => request.folder === '/demo/old'))
        .toBe(true);
      await path.fill('/demo/new');
      await expect(appPage.locator('#folderChosenLabel')).toHaveCount(0);
      await usePath.click();
      await expect(appPage.locator('#folderChosenLabel')).toHaveText('1 export files found');
      await expect(appPage.locator('.ingest-preview-name')).toHaveText('new.json');
      expect(requests.at(-1)).toEqual({ folder: '/demo/new', collection: 'pw_fixture' });
      delayed.resolve();
      await lateFinished.promise;
      await expect(appPage.locator('#folderChosenLabel')).toHaveText('1 export files found');
      await expect(appPage.locator('.ingest-preview-name')).toHaveText('new.json');
      await expect(path).toHaveValue('/demo/new');

      await path.fill('/demo/before-pick');
      await usePath.click();
      await expect
        .poll(() => requests.some((request) => request.folder === '/demo/before-pick'))
        .toBe(true);
      await appPage.locator('#exportFileInput').setInputFiles({
        name: 'picked-export.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{}'),
      });
      beforePick.resolve();
      await pickFinished.promise;
      await expect(appPage.locator('.ingest-preview-name')).toHaveText('picked-export.json');
      await expect(appPage.locator('#folderChosenLabel')).toHaveText('1 export files selected');
    } finally {
      delayed.resolve();
      beforePick.resolve();
    }
  });

  test('deleting the selected destination reconciles both label and submitted collection without resetting clear first', async ({
    appPage,
    serverContext,
  }) => {
    const name = 'idx_deleted_target';
    expect(
      (
        await appPage.request.post(`${serverContext.baseUrl}/api/collections`, { data: { name } })
      ).ok(),
    ).toBe(true);
    await appPage.reload();
    await appPage.locator('#indexingNavBtn').click();
    const target = appPage.locator('#targetCollectionSelect');
    await target.selectOption(name);
    await appPage.getByLabel('Clear collection first').check();
    await appPage.getByPlaceholder('/absolute/path/to/exports').fill('/demo/deleted-target');
    await appPage.route('**/api/ingest-preview?*', (route) =>
      route.fulfill({
        json: { collection: name, files: ['/demo/deleted-target/old.json'], duplicates: [] },
      }),
    );
    await appPage.getByRole('button', { name: 'Use path', exact: true }).click();
    await expect(appPage.locator('.ingest-preview-row')).toHaveCount(1);

    expect(
      (await appPage.request.delete(`${serverContext.baseUrl}/api/collections/${name}`)).ok(),
    ).toBe(true);
    await appPage.keyboard.press('Control+K');
    await appPage.getByRole('button', { name: 'Refresh stats' }).click();
    await expect(target.locator(`option[value="${name}"]`)).toHaveCount(0);
    const fallback = await target.locator('option').first().getAttribute('value');
    await expect(target).toHaveValue(fallback);
    await expect(appPage.locator('.target-collection-select .native-select-value')).toHaveText(
      await target.locator('option').first().textContent(),
    );
    await expect(appPage.locator('.ingest-preview-row')).toHaveCount(0);
    await expect(appPage.getByLabel('Clear collection first')).toBeChecked();

    const accepted = deferred();
    let submitted;
    await appPage.route('**/api/import-jobs', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      submitted = route.request().postDataJSON();
      await accepted.promise;
      await route.fulfill({
        status: 202,
        json: { job: { id: 'test-folder-submission', state: 'queued' } },
      });
    });
    try {
      await appPage.locator('#ingestBtn').click();
      await expect(appPage.locator('#ingestBtn')).toHaveText('Submitting…');
      await expect.poll(() => submitted?.collection).toBe(fallback);
      expect(submitted).toMatchObject({ collection: fallback, clearFirst: true });
    } finally {
      accepted.resolve();
    }
    await expect(appPage.locator('#ingestBtn')).toHaveText('Start import');
  });

  test('Chunks still derives the upload folder name while an explicit destination is kept', async ({
    appPage,
    serverContext,
  }) => {
    const folder = join(serverContext.tempRoot, 'candidate_folder_name');
    await mkdir(folder, { recursive: true });
    await copyFile(
      fileURLToPath(new URL('../fixtures/gemini-polish.json', import.meta.url)),
      join(folder, 'conversation.json'),
    );
    const accepted = deferred();
    const bodies = [];
    await appPage.route('**/api/import-jobs/upload', async (route) => {
      bodies.push(route.request().postDataBuffer().toString('utf8'));
      await accepted.promise;
      await route.fulfill({
        status: 202,
        json: { job: { id: `test-upload-${bodies.length}`, state: 'queued' } },
      });
    });
    await appPage.locator('#indexingNavBtn').click();
    await appPage.locator('#targetCollectionSelect').selectOption('chunks');
    await appPage.locator('#folderFileInput').setInputFiles(folder);
    try {
      await appPage.locator('#ingestBtn').click();
      await expect(appPage.locator('#ingestBtn')).toHaveText('Uploading…');
      await expect.poll(() => bodies.length).toBe(1);
      expect(bodies[0]).toContain('name="collectionName"\r\n\r\ncandidate_folder_name');
    } finally {
      accepted.resolve();
    }
    await expect(appPage.locator('#ingestBtn')).toHaveText('Start import');
    await appPage.locator('#targetCollectionSelect').selectOption('pw_fixture');
    await appPage.locator('#ingestBtn').click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toContain('name="collectionName"\r\n\r\npw_fixture');
    await expect(appPage.locator('#ingestBtn')).toHaveText('Start import');
  });
});
