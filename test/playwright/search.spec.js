import { test, expect } from './fixtures.js';
import { readFile } from 'node:fs/promises';

test.describe('Search workflow', () => {
  test('loads the UI shell with expected sections', async ({ appPage }) => {
    await expect(appPage.locator('.sb-name b')).toHaveText('ThreadShelf Enhanced');
    await expect(appPage.getByLabel('Filter by conversation origin')).toHaveValue('all');
    await expect(appPage.locator('#searchInput')).toBeVisible();
    await expect(appPage.getByText('Library')).toBeVisible();
    await expect(appPage.locator('#collection-pw_fixture')).toBeVisible();
  });

  test('search returns results for multilingual query', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await appPage.locator('#searchInput').fill('contraseña Unicode');
    await appPage.locator('#searchInput').press('Enter');

    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    const count = await appPage.locator('.result').count();
    expect(count).toBeGreaterThan(0);
  });

  test('a result card names the conversation it came from', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();

    // Browse list: every row leads with a readable title, not a clipped path.
    const browseTitle = appPage.locator('.result .r-title').first();
    await expect(browseTitle).toBeVisible({ timeout: 30_000 });
    expect((await browseTitle.innerText()).trim().length).toBeGreaterThan(0);

    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');

    const hit = appPage.locator('.result').first();
    await expect(hit).toBeVisible({ timeout: 30_000 });
    await expect(hit.locator('.r-title')).toBeVisible();
    // The full source path stays reachable as a tooltip on the footer chip.
    await expect(hit.locator('.r-source')).toHaveAttribute('title', /\.json$/);
  });

  test('the clear button empties the query and returns to the browse list', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });

    await appPage.locator('#clearSearch').click();
    await expect(appPage.locator('#searchInput')).toHaveValue('');
    await expect(appPage.locator('#clearSearch')).toHaveCount(0);
    await expect(appPage.getByText(/conversations/i).first()).toBeVisible();
  });

  test('opens thread reader when a result is clicked', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');

    await appPage.locator('.result').first().click({ timeout: 30_000 });
    await expect(appPage.locator('#threadOverlay')).toBeVisible();
    await expect(appPage.locator('#threadContent')).toContainText(/contraseña|Unicode|¿Qué tal\?/i);

    await appPage.locator('#threadClose').click();
    await expect(appPage.locator('#searchInput')).toBeVisible();
  });

  test('role filters hide / show categories of results', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await appPage.getByRole('button', { name: /User/i }).click();
    await appPage.getByRole('button', { name: /Response/i }).click();
    await appPage.locator('#searchInput').fill('test');
    await appPage.locator('#searchInput').press('Enter');

    await appPage.waitForTimeout(2000);
    const items = appPage.locator('.result');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).innerText();
      expect(text.toLowerCase()).toContain('reasoning');
    }
  });

  test('exact mode returns only substring matches', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await appPage.getByRole('button', { name: 'Exact' }).click();
    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');

    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    const items = appPage.locator('.result');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).innerText();
      expect(text.toLowerCase()).toContain('contraseña');
    }
  });

  test('conversation filter narrows the browse list', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    const before = await appPage.locator('.result').count();
    expect(before).toBeGreaterThan(0);

    await appPage.locator('.conv-filter').fill('zzz-no-conversation-has-this-zzz');
    await expect(appPage.getByText('No conversations match the filter.')).toBeVisible();

    await appPage.locator('.conv-filter').fill('');
    await expect(appPage.locator('.result').first()).toBeVisible();
  });

  test('conversation pagination shows 100 at a time and resets after sort/filter', async ({
    page,
    serverContext,
  }) => {
    const files = Array.from({ length: 105 }, (_, index) => ({
      sourceFile: `/synthetic/conversation-${String(index).padStart(3, '0')}.json`,
      collection: 'pw_fixture',
      conversationKey: `synthetic:${index}`,
      title: `Synthetic conversation ${String(index).padStart(3, '0')}`,
      turnCount: index + 1,
      provider: 'openai',
      lastTurnAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    await page.route('**/api/files?collection=pw_fixture', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files }),
      }),
    );

    await page.goto(`${serverContext.baseUrl}/`);
    await expect(page.locator('#collection-pw_fixture')).toBeVisible({ timeout: 15_000 });
    await page.locator('#collection-pw_fixture').click();
    await expect(page.locator('.result')).toHaveCount(100);
    await expect(page.getByRole('button', { name: 'Show more (5 left)' })).toBeVisible();

    await page.getByRole('button', { name: 'Show more (5 left)' }).click();
    await expect(page.locator('.result')).toHaveCount(105);

    await page.getByLabel('Sort conversations').selectOption('longest');
    await expect(page.locator('.result')).toHaveCount(100);
    await expect(page.getByRole('button', { name: 'Show more (5 left)' })).toBeVisible();

    await page.locator('.conv-filter').fill('conversation 104');
    await expect(page.locator('.result')).toHaveCount(1);
    await page.locator('.conv-filter').fill('');
    await expect(page.locator('.result')).toHaveCount(100);
  });

  test('saved searches, pins, and More like this survive their UI workflows', async ({
    appPage,
  }) => {
    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });

    await appPage.locator('.result').first().locator('.pin-toggle').click();
    await expect(appPage.getByText('Pinned', { exact: false }).first()).toBeVisible();
    await appPage.reload();
    await expect(appPage.getByText('Pinned', { exact: false }).first()).toBeVisible();

    await appPage.getByRole('button', { name: 'Exact' }).click();
    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');
    await expect(appPage.locator('.result-list .result').first()).toBeVisible({ timeout: 30_000 });
    await appPage.getByRole('button', { name: 'Save search' }).click();
    await expect(appPage.getByRole('button', { name: 'Saved' })).toBeVisible();

    await appPage.reload();
    await expect(appPage.getByRole('button', { name: 'Saved' })).toBeVisible();
    await appPage.locator('#searchInput').fill('');
    await appPage.locator('#searchInput').press('Enter');
    await expect(appPage.locator('.saved-searches')).toContainText('contraseña');
    await appPage.getByTitle('Run: contraseña').click();
    await expect(appPage.locator('.result-list .result').first()).toBeVisible({ timeout: 30_000 });
    await appPage.locator('.result-list .result').first().locator('.more-like-this').click();
    await expect(appPage.getByRole('button', { name: 'Semantic' })).toHaveAttribute(
      'data-on',
      'true',
    );
    await expect(appPage).not.toHaveURL(/mode=keyword/);
  });

  test('Insights opens a stored thread and exports valid JSON', async ({
    appPage,
    serverContext,
  }) => {
    await appPage.goto(`${serverContext.baseUrl}/insights`);
    await expect(appPage.getByRole('heading', { name: 'Archive insights' })).toBeVisible();
    await appPage.getByLabel('Insights scope').selectOption('pw_fixture');
    await expect(appPage.locator('.longest-row').first()).toBeVisible({ timeout: 30_000 });
    await appPage.locator('.longest-row').first().click();
    await expect(appPage.locator('#threadOverlay')).toBeVisible();
    await expect(appPage.locator('#threadContent')).toBeVisible();

    const downloadPromise = appPage.waitForEvent('download');
    await appPage.getByRole('button', { name: 'Export .json' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const payload = JSON.parse(await readFile(downloadPath, 'utf8'));
    expect(payload.title).toBeTruthy();
    expect(Array.isArray(payload.turns)).toBe(true);
    expect(payload.turns.length).toBeGreaterThan(0);
  });

  test('empty query does not trigger a request', async ({ appPage }) => {
    await appPage.locator('#searchInput').fill('   ');
    let triggered = false;
    appPage.on('request', (request) => {
      if (request.url().includes('/api/search')) triggered = true;
    });
    await appPage.locator('#searchInput').press('Enter');
    await appPage.waitForTimeout(1500);
    expect(triggered).toBe(false);
  });
});
