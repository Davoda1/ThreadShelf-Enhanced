import { test, expect } from './fixtures.js';

test.describe('Collection routing', () => {
  test('redirects the app root to /search/all', async ({ appPage }) => {
    await expect(appPage).toHaveURL(/\/search\/all$/);
  });

  test('selecting a collection puts it in the URL', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage).toHaveURL(/\/search\/pw_fixture(\?|$)/);
  });

  test('searching keeps the collection in the route (not lost in a bare /search)', async ({
    appPage,
  }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage).toHaveURL(/\/search\/pw_fixture(\?|$)/);

    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');

    // Collection stays in the path AND the query is in the search string.
    await expect(appPage).toHaveURL(/\/search\/pw_fixture\?.*q=contrase/);
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
  });

  test('an unknown URL lands on a navigable not-found page', async ({ page, serverContext }) => {
    await page.goto(`${serverContext.baseUrl}/does-not-exist`);

    const notFound = page.locator('#notFound');
    await expect(notFound).toBeVisible({ timeout: 15_000 });
    await expect(notFound).toContainText('That page does not exist.');
    // The shell stays usable rather than dropping to bare "Not Found" text.
    await expect(page.locator('.sb-name b')).toHaveText('ThreadShelf Enhanced');

    await page.getByRole('button', { name: 'Back to search' }).click();
    await expect(page).toHaveURL(/\/search\//);
    await expect(page.locator('#searchInput')).toBeVisible();
  });
});
