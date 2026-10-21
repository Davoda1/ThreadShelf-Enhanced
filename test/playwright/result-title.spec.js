/**
 * Result-card title readability.
 *
 * Real exports carry long titles that contain unbreakable tokens (URLs,
 * snake_case identifiers). Those used to widen the card's grid track past the
 * card itself, so the title and the footer path drew outside the card border on
 * a phone. These tests pin the geometry down at phone width and check that the
 * full title stays reachable as a tooltip in every list that renders `.r-title`.
 */
import { test, expect } from './fixtures.js';

const LONG_TITLE =
  'Debugowanie problemu z parsowaniem eksportu — ' +
  'https://example.com/very/long/path/that_never_breaks_anywhere_at_all?query=abcdefghijklmnop';

/** Serve a synthetic browse list so the long-title case renders for real. */
async function stubLongTitledConversation(page) {
  await page.route('**/api/files?collection=pw_fixture', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: [
          {
            sourceFile: '/synthetic/a_very_long_unbroken_export_file_name_for_this_thread.json',
            collection: 'pw_fixture',
            conversationKey: 'synthetic:long',
            title: LONG_TITLE,
            turnCount: 3,
            provider: 'openai',
            lastTurnAt: '2026-02-13T17:27:00.000Z',
          },
        ],
      }),
    }),
  );
}

/** Serve a synthetic search hit so ResultCard renders the long title for real. */
async function stubLongTitledHit(page) {
  await page.route('**/api/search**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            document:
              'Snippet z bardzo długim tokenem: ' +
              'przyklad_bardzo_dlugiego_identyfikatora_ktory_sie_nie_lamie_nigdzie_wcale',
            distance: 0.21,
            metadata: {
              role: 'ai',
              provider: 'openai',
              sourceFile: '/synthetic/a_very_long_unbroken_export_file_name_for_this_thread.json',
              collection: 'pw_fixture',
              conversationKey: 'synthetic:long',
              title: LONG_TITLE,
              turnIndex: 2,
              model: 'gpt-5',
              createdAt: '2026-02-13T17:27:00.000Z',
            },
          },
        ],
      }),
    }),
  );
}

/** Navigate directly so collection-selection timing cannot affect geometry assertions. */
async function selectFixtureCollection(page) {
  const target = new URL('/search/pw_fixture', page.url()).toString();
  await page.goto(target);
  await expect(page).toHaveURL(/\/search\/pw_fixture(?:\?|$)/);
}

/** Let the browser run a full layout pass before measuring. */
function nextFrame(page) {
  return page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

/**
 * Nothing inside a result card may paint outside it: neither the card's own
 * scroll width nor any child's right edge may exceed the card box.
 */
async function cardOverflow(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.result')].map((card) => {
      const cardBox = card.getBoundingClientRect();
      const worstRight = [...card.querySelectorAll('.r-title, .r-snippet, .r-foot, .result-head')]
        .map((el) => el.getBoundingClientRect().right)
        .reduce((a, b) => Math.max(a, b), 0);
      return {
        overflowsSelf: card.scrollWidth > card.clientWidth + 1,
        childEscapes: worstRight > cardBox.right + 1,
      };
    }),
  );
}

test.describe('Result card titles', () => {
  test('a long unbreakable title stays inside its card at phone width', async ({
    page,
    serverContext,
  }) => {
    await stubLongTitledConversation(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${serverContext.baseUrl}/`);
    // The closed mobile drawer is intentionally hidden; wait for data, then navigate.
    await expect(page.locator('#collection-pw_fixture')).toBeAttached({ timeout: 15_000 });
    await selectFixtureCollection(page);

    const title = page.locator('.result .r-title').first();
    await expect(title).toBeVisible({ timeout: 30_000 });

    // The title wraps in full rather than being clipped — no ellipsis, and the
    // rendered text still holds the whole string.
    expect((await title.innerText()).replace(/\s+/g, ' ').trim()).toBe(LONG_TITLE);
    await expect(title).toHaveAttribute('title', LONG_TITLE);

    const boxes = await cardOverflow(page);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box.overflowsSelf, 'card content wider than the card').toBe(false);
      expect(box.childEscapes, 'a row painted outside the card border').toBe(false);
    }
    // And the page itself never gains a horizontal scrollbar.
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  });

  // A search hit adds a snippet row to the card, so it sizes differently from a
  // browse row and is worth checking on its own. 390px is a common phone; 320px
  // is the narrowest still worth supporting and is where the card used to burst.
  for (const width of [390, 320]) {
    test(`a long search-hit title stays inside its card at ${width}px`, async ({
      page,
      serverContext,
    }) => {
      await stubLongTitledHit(page);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${serverContext.baseUrl}/`);
      // The closed mobile drawer is intentionally hidden; wait for data, then navigate.
      await expect(page.locator('#collection-pw_fixture')).toBeAttached({ timeout: 15_000 });
      await selectFixtureCollection(page);
      await page.locator('#searchInput').fill('contraseña');
      await page.locator('#searchInput').press('Enter');

      const card = page.locator('.result-list .result').first();
      await expect(card.locator('.r-title')).toHaveText(LONG_TITLE, { timeout: 30_000 });
      await expect(card.locator('.r-snippet')).toBeVisible();
      await nextFrame(page);

      const boxes = await cardOverflow(page);
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box.overflowsSelf, 'card content wider than the card').toBe(false);
        expect(box.childEscapes, 'a row painted outside the card border').toBe(false);
      }
    });
  }

  test('every list that renders a title exposes it as a tooltip', async ({ appPage }) => {
    /** Each `.r-title` must carry its own full text in a `title` attribute. */
    async function assertTooltips(scope, label) {
      const titles = appPage.locator(scope).locator('.r-title');
      const count = await titles.count();
      expect(count, `no titles found in ${label}`).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        const el = titles.nth(i);
        const attr = await el.getAttribute('title');
        expect(attr, `${label} title #${i} has no tooltip`).toBeTruthy();
        expect(attr.trim(), `${label} title #${i} tooltip differs from its text`).toBe(
          (await el.innerText()).replace(/\s+/g, ' ').trim(),
        );
      }
    }

    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result .r-title').first()).toBeVisible({ timeout: 30_000 });

    // The browse list, the pinned strip and search hits render `.r-title` from
    // three separate call sites, and the pinned strip and browse list only exist
    // while the query is empty — so each has to be checked in its own state.
    await assertTooltips('.result-list', 'browse list');

    // Pinning adds a second `.result-list` above the browse list, so this pass
    // covers the pinned strip's own call site as well.
    await appPage.locator('.result').first().locator('.pin-toggle').click();
    await expect(appPage.getByText('Pinned', { exact: false }).first()).toBeVisible();
    await expect(appPage.locator('.result-list')).toHaveCount(2);
    await assertTooltips('.result-list', 'pinned strip + browse list');

    await appPage.locator('#searchInput').fill('contraseña');
    await appPage.locator('#searchInput').press('Enter');
    await expect(appPage.locator('.result-list .result').first()).toBeVisible({ timeout: 30_000 });
    await assertTooltips('.result-list', 'search hits');
  });

  test('hovering a card gives its title link-like feedback', async ({ appPage }) => {
    await appPage.locator('#collection-pw_fixture').click();
    const card = appPage.locator('.result').first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    const decoration = () =>
      card.locator('.r-title').evaluate((el) => getComputedStyle(el).textDecorationLine);

    expect(await decoration()).toBe('none');
    await card.hover();
    await expect.poll(decoration).toBe('underline');
  });

  test('the conversation meta bar does not overlap itself at phone width', async ({
    page,
    serverContext,
  }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${serverContext.baseUrl}/`);
    // The closed mobile drawer is intentionally hidden; wait for data, then navigate.
    await expect(page.locator('#collection-pw_fixture')).toBeAttached({ timeout: 15_000 });
    await selectFixtureCollection(page);
    await expect(page.locator('.results-meta-bar')).toBeVisible({ timeout: 30_000 });

    const bar = await page.evaluate(() => {
      const root = document.querySelector('.results-meta-bar');
      const count = root.querySelector('.h');
      const sort = root.querySelector('.conv-sort');
      const filter = root.querySelector('.conv-filter');
      return {
        // The count is unbreakable uppercase mono. When it is squeezed onto a
        // shared line it overflows its own box and paints straight over the
        // "sort" label — an intersection test misses that, because the border
        // box stays put while only the ink escapes.
        countTextOverflows: count.scrollWidth > count.clientWidth + 1,
        countBottom: Math.round(count.getBoundingClientRect().bottom),
        sortTop: Math.round(sort.getBoundingClientRect().top),
        barRight: Math.round(root.getBoundingClientRect().right),
        filterRight: Math.round(filter.getBoundingClientRect().right),
      };
    });

    expect(bar.countTextOverflows, 'the conversation count overflows its box').toBe(false);
    // The count gets a row of its own, so the sort control starts below it.
    expect(bar.sortTop).toBeGreaterThanOrEqual(bar.countBottom);
    expect(bar.filterRight).toBeLessThanOrEqual(bar.barRight + 1);
  });
});
