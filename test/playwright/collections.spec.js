import { test, expect } from './fixtures.js';

test.describe('Collection management', () => {
  test('lists the seeded collection in the sidebar', async ({ appPage }) => {
    await expect(appPage.locator('#collection-pw_fixture')).toBeVisible();
    await expect(appPage.locator('#collection-all')).toBeVisible();
  });

  test('the "All" pseudo-collection cannot be deleted', async ({ appPage }) => {
    await appPage.locator('#collection-all').click();
    await expect(appPage.locator('#delete-collection-all')).toHaveCount(0);
  });

  test('the protected default collection cannot be deleted', async ({ appPage }) => {
    // The internal `chunks` collection is empty, so it now sits behind the
    // Reveal the collapsed empty collection before asserting on it.
    await appPage.locator('#toggleEmptyCollections').click();
    await appPage.locator('#collection-chunks').click();
    await expect(appPage.locator('#delete-collection-chunks')).toHaveCount(0);
  });

  test('command palette refresh performs a real stats refetch', async ({ appPage }) => {
    await appPage.keyboard.press('Control+K');
    const statsResponse = appPage.waitForResponse(
      (response) => response.url().includes('/api/collections/all/stats') && response.ok(),
    );
    await appPage.getByRole('button', { name: 'Refresh stats' }).click();
    await statsResponse;
    await expect(appPage.getByText('Local index data refreshed.')).toBeVisible();
  });

  test('deleting the active collection from Settings returns to All collections', async ({
    appPage,
    serverContext,
  }) => {
    const name = `delete_me_${Date.now()}`;
    const created = await appPage.request.post(`${serverContext.baseUrl}/api/collections`, {
      data: { name },
    });
    expect(created.ok()).toBe(true);

    await appPage.reload();
    // A freshly created collection is empty, so it starts collapsed.
    await appPage.locator('#toggleEmptyCollections').click();
    await appPage.locator(`#collection-${name}`).click();
    await appPage.getByRole('button', { name: 'Settings' }).click();
    await appPage.locator('#settings-tab-server').click();
    await appPage.getByRole('button', { name: 'Delete', exact: true }).click();
    await appPage.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();

    await expect(appPage).toHaveURL(/\/search\/all$/);
    await expect(appPage.locator('#collection-all')).toHaveAttribute('data-active', 'true');
    await expect(appPage.locator(`#collection-${name}`)).toHaveCount(0);
  });
});
