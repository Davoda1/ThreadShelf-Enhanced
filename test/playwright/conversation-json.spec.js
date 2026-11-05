/* global localStorage, navigator, window */
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startApiServer } from '../e2e/helpers.js';

const empty = '{"content_type":"thoughts","source_analysis_msg_id":"synthetic","thoughts":[]}';
const useful = '{"total":0,"found":false,"items":[],"id":9007199254740993123456789}';
const turns = [
  { user: '{"prompt":"This user JSON always stays visible"}' },
  { ai: empty },
  { ai: useful },
  { ai: 'The useful explanation after the JSON responses.' },
];
const threadPath =
  '/thread?sourceFile=%2Fsynthetic%2Fjson.json&collection=demo&title=JSON%20display%20regression';

async function prepare(page, visibility = 'hide-empty', extra = {}) {
  await page.addInitScript(
    ({ visibility, extra }) => {
      if (!localStorage.getItem('threadshelf:ui'))
        localStorage.setItem(
          'threadshelf:ui',
          JSON.stringify({
            state: {
              locale: 'en',
              theme: 'dark',
              conversationDisplay: {
                jsonVisibility: visibility,
                jsonAsCode: true,
                codeDownloads: true,
                codeWrap: false,
                codeLineNumbers: true,
                ...extra,
              },
            },
            version: 0,
          }),
        );
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.__jsonCopied = value;
          },
        },
      });
    },
    { visibility, extra },
  );
  await page.route('**/api/thread?**', (route) =>
    route.fulfill({
      json: {
        sourceFile: '/synthetic/json.json',
        collection: 'demo',
        createdInThreadShelf: false,
        turns,
        raw: { synthetic: true, turns },
      },
    }),
  );
}

test('JSON display hides whole empty rows but preserves source indexes, copy and both conversation exports', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'json-display-' });
  try {
    await prepare(page);
    await page.goto(app.baseUrl + threadPath);
    await expect(page.locator('.thread-body > .turn')).toHaveCount(3);
    await expect(page.locator('.thread-body > .turn .turn-idx')).toHaveText(['#0', '#2', '#3']);
    await expect(page.locator('.thread-body > .turn[data-role=user]')).toContainText(
      'This user JSON always stays visible',
    );
    const code = page.locator('pre.language-json');
    await expect(code).toBeVisible();
    await expect(code.locator('.code-line-number')).not.toHaveCount(0);
    await code.locator('.code-copy-button').click();
    const copied = await page.evaluate(() => window.__jsonCopied);
    expect(copied).toContain('9007199254740993123456789');
    expect(copied).toContain('"found": false');
    expect(copied).not.toContain('```');
    const codeDownload = page.waitForEvent('download');
    await code.locator('.code-download-button').click();
    const savedCode = await codeDownload;
    expect(savedCode.suggestedFilename()).toBe('code-block-1.json');
    expect(await readFile(await savedCode.path(), 'utf8')).toBe(copied);
    await page.getByRole('button', { name: 'Copy conversation', exact: true }).click();
    const whole = await page.evaluate(() => window.__jsonCopied);
    expect(whole).toContain(empty);
    expect(whole).toContain(useful);
    expect(whole).not.toContain('Show code line numbers');
    for (const type of ['md', 'json']) {
      const waiting = page.waitForEvent('download');
      await page.getByRole('button', { name: `Export .${type}`, exact: true }).click();
      const downloaded = await waiting;
      const exported = await readFile(await downloaded.path(), 'utf8');
      if (type === 'md') {
        expect(exported).toContain(empty);
        expect(exported).toContain(useful);
      } else {
        expect(exported).toContain('9007199254740993123456789');
        expect(exported).toContain('source_analysis_msg_id');
      }
      expect(exported).not.toContain('code-line-number');
    }
  } finally {
    await app.stop();
  }
});

test('Hide all and Show all apply independently of code formatting and never hide the user prompt', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'json-policies-' });
  try {
    await prepare(page, 'hide-all', { jsonAsCode: false });
    await page.goto(app.baseUrl + threadPath);
    await expect(page.locator('.thread-body > .turn')).toHaveCount(2);
    await expect(page.locator('.thread-body > .turn .turn-idx')).toHaveText(['#0', '#3']);
    await page.goto(app.baseUrl + '/settings');
    await page.locator('#settings-tab-server').click();
    const visibility = page.locator('#conversation-display-jsonVisibility');
    await visibility.focus();
    await page.keyboard.press('Home');
    await page.goto(app.baseUrl + threadPath);
    await expect(page.locator('.thread-body > .turn')).toHaveCount(4);
    await expect(page.locator('.thread-body pre.language-json')).toHaveCount(0);
    await page.goto(app.baseUrl + '/settings');
    await page.locator('#settings-tab-server').click();
    await page.locator('#conversation-display-jsonAsCode').click();
    await page.goto(app.baseUrl + threadPath);
    await expect(page.locator('.thread-body > .turn')).toHaveCount(4);
    await expect(page.locator('.thread-body pre.language-json')).toHaveCount(2);
  } finally {
    await app.stop();
  }
});

test('a hidden search match keeps its original copy target and gives a visible jump explanation', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'json-match-' });
  try {
    await prepare(page);
    await page.goto(app.baseUrl + threadPath + '&matchIdx=1&q=thoughts');
    await expect(page.locator('.thread-body > .turn')).toHaveCount(3);
    await page.getByRole('button', { name: 'Jump to match', exact: true }).click();
    await expect(
      page.getByText('The matched response is hidden by your conversation display settings.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Copy matched turn', exact: true }).click();
    expect(await page.evaluate(() => window.__jsonCopied)).toBe(empty);
  } finally {
    await app.stop();
  }
});

test('a visible JSON search match retains both code presentation and search highlighting', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'json-visible-match-' });
  try {
    await prepare(page);
    await page.goto(app.baseUrl + threadPath + '&matchIdx=2&q=found');
    const match = page.locator('.turn[data-matched=true]');
    await expect(match.locator('pre.language-json code mark')).toHaveText('found');
    await match.locator('.code-copy-button').click();
    const copied = await page.evaluate(() => window.__jsonCopied);
    expect(copied).toContain('"found": false');
    expect(copied).not.toContain('<mark>');
    await page.getByRole('button', { name: 'Copy matched turn', exact: true }).click();
    expect(await page.evaluate(() => window.__jsonCopied)).toBe(useful);
  } finally {
    await app.stop();
  }
});

test('JSON visibility never discards a response carrying a useful image attachment', async ({
  page,
}) => {
  const app = await startApiServer({ prefix: 'json-attachment-' });
  try {
    await prepare(page, 'hide-all');
    await page.route('**/api/thread?**', (route) =>
      route.fulfill({
        json: {
          sourceFile: '/synthetic/json.json',
          collection: 'demo',
          createdInThreadShelf: false,
          turns: [
            {
              ai: empty,
              assets: [
                {
                  source: 'sandbox:/synthetic/diagram.png',
                  label: 'Synthetic useful diagram',
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LxkAAAAASUVORK5CYII=',
                },
              ],
            },
          ],
        },
      }),
    );
    await page.goto(app.baseUrl + threadPath);
    await expect(page.locator('.thread-body > .turn')).toHaveCount(1);
    await expect(page.locator('.archived-image-attachments .archived-image')).toHaveCount(1);
    await expect(page.locator('pre.language-json')).toBeVisible();
  } finally {
    await app.stop();
  }
});
