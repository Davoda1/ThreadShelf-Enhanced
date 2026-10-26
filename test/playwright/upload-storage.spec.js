import { test, expect } from './fixtures.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const openManager = async (page) => {
  await page.locator('#indexingNavBtn').click();
  const button = page.getByRole('button', { name: 'Manage uploads', exact: true });
  await expect(page.getByRole('dialog', { name: 'Manage uploads' })).toHaveCount(0);
  await button.click();
  return page.getByRole('dialog', { name: 'Manage uploads', exact: true });
};

test('upload cleanup is a discreet dialog and deletes only confirmed originals, keeping archived conversations', async ({
  appPage,
  serverContext,
}) => {
  const root = join(serverContext.tempRoot, '.uploads', 'pw_fixture');
  await mkdir(join(root, 'exports'), { recursive: true });
  await writeFile(join(root, 'exports', 'remove.json'), '{"synthetic":true}');
  await writeFile(join(root, 'keep.png'), 'synthetic retained image bytes');
  const original = await (
    await appPage.request.get(`${serverContext.baseUrl}/api/files?collection=pw_fixture`)
  ).json();
  const modal = await openManager(appPage);
  await modal.getByLabel('Collection', { exact: true }).selectOption('pw_fixture');
  const row = modal
    .getByRole('list', { name: 'Uploaded files' })
    .locator('li')
    .filter({ hasText: 'exports/remove.json' });
  await row.getByRole('checkbox').check();
  await modal.getByRole('button', { name: 'Delete selected files', exact: true }).click();
  const confirmation = appPage.getByRole('alertdialog');
  await expect(confirmation).toContainText('Imported conversations and search indexes remain.');
  await appPage.keyboard.press('Escape');
  await expect(confirmation).toHaveCount(0);
  await expect(modal).toBeVisible();
  expect(await readFile(join(root, 'exports', 'remove.json'), 'utf8')).toContain('synthetic');
  await modal.getByRole('button', { name: 'Delete selected files', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Delete selected files', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(modal.getByRole('status')).toContainText('Deleted 1 uploaded files.');
  await expect(readFile(join(root, 'exports', 'remove.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(await readFile(join(root, 'keep.png'), 'utf8')).toBe('synthetic retained image bytes');
  expect(
    await (
      await appPage.request.get(`${serverContext.baseUrl}/api/files?collection=pw_fixture`)
    ).json(),
  ).toEqual(original);

  await modal.getByRole('button', { name: 'Delete all uploaded files', exact: true }).click();
  await confirmation
    .getByRole('button', { name: 'Delete all uploaded files', exact: true })
    .click();
  await expect(modal.getByText('No uploaded files.', { exact: true })).toBeVisible();
  expect(
    await (
      await appPage.request.get(`${serverContext.baseUrl}/api/files?collection=pw_fixture`)
    ).json(),
  ).toEqual(original);
  await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await appPage.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(appPage.getByRole('button', { name: 'Manage uploads', exact: true })).toBeFocused();
  await appPage.reload();
  await appPage.getByRole('button', { name: 'Manage uploads', exact: true }).click();
  await expect(
    appPage
      .getByRole('dialog', { name: 'Manage uploads' })
      .getByText('No uploaded files.', { exact: true }),
  ).toBeVisible();
});

test('upload dialog paginates, handles deletion errors and prevents actions on protected files', async ({
  appPage,
}) => {
  let openedRequests = 0;
  let locked = false;
  let deletions = 0;
  await appPage.route('**/api/uploads', async (route) => {
    openedRequests++;
    await route.fulfill({ json: { collections: [{ collection: 'synthetic' }] } });
  });
  await appPage.route('**/api/uploads/synthetic*', async (route) => {
    if (route.request().method() === 'DELETE') {
      deletions++;
      locked = true;
      await route.fulfill({ status: 409, json: { error: 'Synthetic import acquired the files.' } });
      return;
    }
    const second = new URL(route.request().url()).searchParams.has('cursor');
    await route.fulfill({
      json: {
        files: [{ path: second ? 'second.json' : 'first.json', bytes: 1024, modifiedAt: 0 }],
        nextCursor: second ? null : '100',
        locked,
      },
    });
  });
  await appPage.locator('#indexingNavBtn').click();
  expect(openedRequests).toBe(0);
  await appPage.getByRole('button', { name: 'Manage uploads', exact: true }).click();
  const modal = appPage.getByRole('dialog', { name: 'Manage uploads' });
  await expect(modal.getByText('first.json', { exact: true })).toBeVisible();
  await modal.getByRole('checkbox', { name: /first.json/ }).check();
  await modal.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(modal.getByText('second.json', { exact: true })).toBeVisible();
  await expect(
    modal.getByRole('button', { name: 'Delete selected files', exact: true }),
  ).toBeDisabled();
  await modal.getByRole('button', { name: 'Previous', exact: true }).click();
  await modal.getByRole('checkbox', { name: /first.json/ }).check();
  await modal.getByRole('button', { name: 'Delete selected files', exact: true }).click();
  await appPage
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete selected files', exact: true })
    .click();
  await expect(modal.getByRole('alert')).toHaveText('Synthetic import acquired the files.');
  await expect(
    modal.getByRole('button', { name: 'Delete selected files', exact: true }),
  ).toBeDisabled();
  await expect(
    modal.getByRole('button', { name: 'Delete all uploaded files', exact: true }),
  ).toBeDisabled();
  await expect(modal.getByRole('status')).toContainText('These uploads are in use.');
  expect(deletions).toBe(1);
});

test('upload dialog remains reachable on a narrow short screen and returns keyboard focus', async ({
  appPage,
}) => {
  await appPage.route('**/api/uploads', (route) =>
    route.fulfill({ json: { collections: [{ collection: 'synthetic' }] } }),
  );
  const name = `${'synthetic-long-name-'.repeat(18)}.json`;
  await appPage.route('**/api/uploads/synthetic*', (route) =>
    route.fulfill({
      json: {
        files: [{ path: name, bytes: 12345678, modifiedAt: 0 }],
        nextCursor: null,
        locked: false,
      },
    }),
  );
  await appPage.locator('#indexingNavBtn').click();
  await appPage.setViewportSize({ width: 320, height: 430 });
  await appPage.getByRole('button', { name: 'Manage uploads', exact: true }).click();
  const modal = appPage.getByRole('dialog', { name: 'Manage uploads', exact: true });
  await expect(modal.getByText(name, { exact: true })).toBeVisible();
  const bounds = await modal.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(430);
  expect(await modal.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await modal.screenshot({ path: test.info().outputPath('upload-manager-narrow.png') });
  await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await appPage.keyboard.press('Shift+Tab');
  await expect(
    modal.getByRole('button', { name: 'Delete all uploaded files', exact: true }),
  ).toBeFocused();
  await appPage.keyboard.press('Tab');
  await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await appPage.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(appPage.getByRole('button', { name: 'Manage uploads', exact: true })).toBeFocused();
});
