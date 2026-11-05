/* global localStorage, document, getComputedStyle */
import { test, expect } from '@playwright/test';
import { startApiServer } from '../e2e/helpers.js';

const defaults = {
  jsonVisibility: 'hide-empty',
  jsonAsCode: true,
  codeDownloads: true,
  codeWrap: false,
  codeLineNumbers: false,
};

const openServer = async (page, app) => {
  await page.goto(app.baseUrl + '/settings');
  await page.locator('#settings-tab-server').click();
};

const assertPreferences = async (page, expected) => {
  await expect(page.locator('#conversation-display-jsonVisibility')).toHaveValue(
    String(['show-all', 'hide-empty', 'hide-all'].indexOf(expected.jsonVisibility)),
  );
  for (const key of ['jsonAsCode', 'codeDownloads', 'codeWrap', 'codeLineNumbers'])
    await expect(page.locator(`#conversation-display-${key}`)).toHaveAttribute(
      'aria-checked',
      String(expected[key]),
    );
};

test('display preferences use the existing switches, support keyboard detents and survive reload', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'display-preferences-' });
  try {
    await openServer(page, app);
    const panel = page.locator('.conversation-display-settings');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('switch')).toHaveCount(4);
    await expect(panel.locator('input[type=checkbox]')).toHaveCount(0);
    await assertPreferences(page, defaults);
    const visibility = panel.getByRole('slider', { name: 'Response visibility' });
    await visibility.focus();
    await page.keyboard.press('Home');
    await expect(visibility).toHaveValue('0');
    await expect(visibility).toHaveAttribute('aria-valuetext', 'Show all');
    await page.keyboard.press('ArrowRight');
    await expect(visibility).toHaveValue('1');
    await expect(visibility).toHaveAttribute('aria-valuetext', 'Hide empty');
    await page.keyboard.press('End');
    await expect(visibility).toHaveValue('2');
    await expect(visibility).toHaveAttribute('aria-valuetext', 'Hide all');
    for (const key of ['jsonAsCode', 'codeDownloads', 'codeWrap', 'codeLineNumbers']) {
      const control = page.locator(`#conversation-display-${key}`);
      await control.focus();
      await page.keyboard.press('Space');
    }
    const changed = {
      jsonVisibility: 'hide-all',
      jsonAsCode: false,
      codeDownloads: false,
      codeWrap: true,
      codeLineNumbers: true,
    };
    await assertPreferences(page, changed);
    await expect
      .poll(() =>
        page.evaluate(
          () => JSON.parse(localStorage.getItem('threadshelf:ui')).state.conversationDisplay,
        ),
      )
      .toEqual(changed);
    await page.locator('#settings-tab-ai').click();
    await expect(panel).toBeHidden();
    await page.locator('#settings-tab-tts').click();
    await expect(panel).toBeHidden();
    await page.reload();
    await page.locator('#settings-tab-server').click();
    await assertPreferences(page, changed);
  } finally {
    await app.stop();
  }
});

test('malformed and old saved display preferences safely hydrate without coercing booleans', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'display-hydration-' });
  try {
    await openServer(page, app);
    for (const saved of [
      null,
      [],
      'old-version',
      {
        jsonVisibility: 'hide-everything',
        jsonAsCode: 'false',
        codeDownloads: 0,
        codeWrap: 'true',
        codeLineNumbers: null,
        extra: true,
      },
      {
        jsonVisibility: 'show-all',
        jsonAsCode: false,
        codeDownloads: false,
        codeWrap: true,
        codeLineNumbers: true,
        extra: true,
      },
    ]) {
      await page.evaluate((conversationDisplay) => {
        localStorage.setItem(
          'threadshelf:ui',
          JSON.stringify({ state: { conversationDisplay }, version: 0 }),
        );
      }, saved);
      await page.reload();
      await page.locator('#settings-tab-server').click();
      const expected =
        saved?.jsonVisibility === 'show-all'
          ? {
              jsonVisibility: 'show-all',
              jsonAsCode: false,
              codeDownloads: false,
              codeWrap: true,
              codeLineNumbers: true,
            }
          : defaults;
      await assertPreferences(page, expected);
      // A normal update writes back only the validated public preference keys.
      await page.locator('#conversation-display-jsonAsCode').click();
      await page.locator('#conversation-display-jsonAsCode').click();
      expect(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('threadshelf:ui')).state.conversationDisplay,
        ),
      ).toEqual(expected);
    }
  } finally {
    await app.stop();
  }
});

test('display controls remain translated, readable and within the panel in all six locales', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'display-locales-' });
  try {
    await openServer(page, app);
    const panel = page.locator('.conversation-display-settings');
    for (const locale of ['en', 'hu', 'de', 'ja', 'fr', 'ru']) {
      await page.locator('#interface-language').selectOption(locale);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      if (locale !== 'en') {
        await expect(panel.locator('h2')).not.toHaveText('Conversation display');
        await expect(panel.locator('.conversation-visibility-labels')).not.toContainText(
          'Hide empty',
        );
      }
      for (const width of [320, 680, 1440]) {
        await page.setViewportSize({ width, height: 850 });
        await page.keyboard.press('Escape');
        const dimensions = await panel.evaluate((element) => ({
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          pageWidth: document.documentElement.clientWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
          labels: [
            ...element.querySelectorAll(
              '.render-setting > span, .conversation-visibility-labels > span',
            ),
          ].map((label) => ({
            width: label.clientWidth,
            scrollWidth: label.scrollWidth,
            height: label.clientHeight,
            scrollHeight: label.scrollHeight,
            overflow: getComputedStyle(label).textOverflow,
          })),
        }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
        expect(dimensions.pageScrollWidth).toBeLessThanOrEqual(dimensions.pageWidth + 1);
        for (const label of dimensions.labels) {
          expect(label.scrollWidth).toBeLessThanOrEqual(label.width + 1);
          expect(label.scrollHeight).toBeLessThanOrEqual(label.height + 1);
          expect(label.overflow).not.toBe('ellipsis');
        }
      }
    }
  } finally {
    await app.stop();
  }
});
