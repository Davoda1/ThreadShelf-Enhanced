import { test, expect } from './fixtures.js';

test('language and independent rich-render switches persist without changing role visibility', async ({
  page,
  serverContext: { baseUrl },
}) => {
  await page.goto(`${baseUrl}/settings`);
  await expect(page.locator('#interface-language')).toHaveValue('en');
  await expect(page.locator('#rich-rendering-user')).toHaveAttribute('role', 'switch');
  await expect(page.locator('#rich-rendering-user')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#rich-rendering-thinking')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#rich-rendering-ai')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#rich-rendering-user').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#rich-rendering-user')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#rich-rendering-thinking').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#rich-rendering-thinking')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#rich-rendering-ai').click();
  await page.locator('#interface-language').selectOption('hu');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hu');
  await expect(page.locator('#appearance-heading')).toHaveText('Megjelenés és nyelv');
  await page.locator('#image-load-mode').selectOption('auto');
  await page.reload();
  await expect(page.locator('#interface-language')).toHaveValue('hu');
  await expect(page.locator('#rich-rendering-user')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#rich-rendering-thinking')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#rich-rendering-ai')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#image-load-mode')).toHaveValue('auto');
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('threadshelf:ui')).state);
  expect(state.roles).toEqual({ user: true, thinking: true, ai: true });
});

test('all six languages update settings and navigation with no horizontal overflow at narrow width', async ({
  page,
  serverContext: { baseUrl },
}) => {
  await page.setViewportSize({ width: 680, height: 700 });
  await page.goto(`${baseUrl}/settings`);
  const headings = {
    en: 'Appearance and language',
    hu: 'Megjelenés és nyelv',
    de: 'Darstellung und Sprache',
    ja: '表示と言語',
    fr: 'Apparence et langue',
    ru: 'Оформление и язык',
  };
  for (const [locale, heading] of Object.entries(headings)) {
    await page.locator('#interface-language').selectOption(locale);
    await expect(page.locator('#appearance-heading')).toHaveText(heading);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('#rich-rendering-user')).toHaveAttribute('aria-checked', 'false');
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  }
});

test('legacy saved preferences retain their data and receive safe new defaults', async ({
  page,
  serverContext: { baseUrl },
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('threadshelf:ui'))
      localStorage.setItem(
        'threadshelf:ui',
        JSON.stringify({
          state: {
            theme: 'light',
            activeColl: 'all',
            roles: { user: true, thinking: false, ai: true },
            savedSearches: [],
            pinnedConversations: [],
            favoriteGenerationModels: [],
          },
          version: 0,
        }),
      );
  });
  await page.goto(`${baseUrl}/settings`);
  await expect(page.locator('#interface-language')).toHaveValue('en');
  await expect(page.locator('#image-load-mode')).toHaveValue('click');
  await expect(page.locator('#rich-rendering-ai')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('image cache settings save limits and clear collection copies independently', async ({
  page,
  serverContext: { baseUrl },
}) => {
  const mib = 1024 * 1024;
  let cache = {
    enabled: false,
    maxBytes: 512 * mib,
    bytes: 3 * mib,
    count: 3,
    collections: [
      { collection: 'Cache A', bytes: mib, count: 1 },
      { collection: 'Cache B', bytes: 2 * mib, count: 2 },
    ],
  };
  const cleared = [];
  await page.route('**/api/image-cache**', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') cache = { ...cache, ...request.postDataJSON() };
    if (request.method() === 'DELETE') {
      const collection = new URL(request.url()).searchParams.get('collection');
      cleared.push(collection);
      cache.collections = collection
        ? cache.collections.filter((entry) => entry.collection !== collection)
        : [];
      cache.count = cache.collections.reduce((sum, entry) => sum + entry.count, 0);
      cache.bytes = cache.collections.reduce((sum, entry) => sum + entry.bytes, 0);
    }
    await route.fulfill({ json: cache });
  });
  await page.goto(`${baseUrl}/settings`);
  await page.locator('#image-cache-enabled').click();
  await expect(page.locator('#image-cache-enabled')).toBeChecked();
  await page.locator('#image-cache-limit').fill('256');
  await page.locator('.cache-limit').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => cache.maxBytes).toBe(256 * mib);
  await page.getByRole('button', { name: 'Clear image cache for Cache A', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toContainText(
    'Only cached image copies are removed.',
  );
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Clear cache', exact: true })
    .click();
  await expect.poll(() => cleared).toEqual(['Cache A']);
  await expect(
    page.getByRole('button', { name: 'Clear image cache for Cache A', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Clear image cache for Cache B', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear all cached images', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Clear cache', exact: true })
    .click();
  await expect.poll(() => cleared).toEqual(['Cache A', null]);
  await expect(
    page.getByRole('button', { name: 'Clear all cached images', exact: true }),
  ).toBeDisabled();
});
