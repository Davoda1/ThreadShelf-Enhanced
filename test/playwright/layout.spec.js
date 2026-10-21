import { test as base, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// These tests exercise the built UI with synthetic API states. Keeping the
// layout fixture separate from ingestion makes viewport regressions reproducible
// without downloading an embedding model or touching a user's archive.
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const test = base.extend({
  uiUrl: [
    async ({}, use) => {
      const server = createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const filename = pathname.startsWith('/assets/') ? pathname.slice(1) : 'index.html';
        const target = resolve(publicDir, filename);
        if (!target.startsWith(resolve(publicDir) + sep)) {
          res.writeHead(403).end();
          return;
        }
        try {
          const body = await readFile(target);
          const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
          res.writeHead(200, {
            'content-type': mime[extname(target)] ?? 'application/octet-stream',
          });
          res.end(body);
        } catch {
          res.writeHead(404).end();
        }
      });
      await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
      try {
        await use(`http://127.0.0.1:${server.address().port}`);
      } finally {
        await new Promise((done) => server.close(done));
      }
    },
    { scope: 'worker' },
  ],
});

const collectionNames = Array.from(
  { length: 30 },
  (_, i) => `archive_${String(i).padStart(2, '0')}`,
);
const stats = collectionNames.map((collection) => ({
  collection,
  files: 24,
  conversations: 24,
  chunks: 72,
  roles: { user: 24, thinking: 24, ai: 24 },
  isEmpty: false,
}));
const files = Array.from(
  { length: 24 },
  (_, i) => `/synthetic/${'long_export_name_'.repeat(12)}${i}.json`,
);

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/ingest-progress' || pathname === '/api/ingest-upload-progress') {
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body:
          JSON.stringify({
            status: 'completed',
            result: { files, conversations: 24, ingested: 72, elapsedMs: 1000 },
          }) + '\n',
      });
      return;
    }
    const responses = {
      '/api/health': { ok: true },
      '/api/collections': { collections: collectionNames },
      '/api/collections/all/stats': { ...stats[0], collections: stats },
      '/api/files': { files: [] },
      '/api/ingest-preview': { collection: collectionNames[0], files, duplicates: [] },
      '/api/generation/threads': {
        threads: Array.from({ length: 24 }, (_, i) => ({
          id: `synthetic-chat-${i}`,
          title: `Synthetic saved conversation ${i}`,
          createdAt: '2025-01-01T12:00:00Z',
          updatedAt: '2025-01-01T12:00:00Z',
          turnCount: 8,
          createdInThreadShelf: true,
        })),
      },
      '/api/generation/runtime': { runtime: { state: 'stopped' } },
      '/api/generation/config': {
        config: {
          llamaCpp: {
            modelDirectories: [],
            defaultModelDirectories: [],
            contextSize: 8192,
            acceleration: 'auto',
            gpuLayers: 20,
            splitMode: 'layer',
            mainGpu: 0,
            threads: -1,
            flashAttention: 'auto',
          },
          openRouter: { enforceZdr: false, denyDataCollection: false, apiKeyConfigured: false },
          diagnostics: { persistErrorLogs: true },
        },
        providers: [{ id: 'llama-cpp', label: 'llama.cpp', available: true, local: true }],
      },
      '/api/generation/models': {
        provider: 'llama-cpp',
        models: Array.from({ length: 30 }, (_, i) => ({
          id: `synthetic-${i}.gguf`,
          name: `Synthetic model ${i}`,
          provider: 'llama-cpp',
        })),
        runtime: { state: 'stopped' },
      },
      '/api/generation/prompts': { prompts: [], activePromptId: null },
      '/api/thread': {
        sourceFile: '/synthetic/conversation.json',
        provider: 'openai',
        createdInThreadShelf: false,
        turns: Array.from({ length: 30 }, (_, i) => ({
          ai: `### Response ${i + 1}\n\n${'A readable conversation paragraph. '.repeat(24)}`,
        })),
      },
    };
    await route.fulfill({
      status: Object.hasOwn(responses, pathname) ? 200 : 503,
      json: responses[pathname] ?? { error: 'No model runtime in the layout fixture.' },
    });
  });
});

async function expectWithinViewport(locator) {
  await expect(locator).toBeVisible();
  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height + 1);
}

async function expectReachable(locator) {
  await locator.scrollIntoViewIfNeeded();
  await expectWithinViewport(locator);
  expect(
    await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!hit && (element.contains(hit) || hit.contains(element));
    }),
  ).toBe(true);
}

// Smaller CSS viewports also reproduce the space available at desktop browser
// zoom; these are geometry checks, not a claim to automate Chrome's zoom menu.
for (const viewport of [
  { width: 1920, height: 872 },
  { width: 1280, height: 540 },
  { width: 800, height: 360 },
  { width: 360, height: 640 },
]) {
  test(`indexing completion and populated navigation remain reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
    uiUrl,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${uiUrl}/indexing`);
    await expect(page.locator('#targetCollectionSelect option')).toHaveCount(30);
    await page.getByPlaceholder('/absolute/path/to/exports').fill('/synthetic/exports');
    await page.getByRole('button', { name: 'Use path' }).click();
    await expect(page.locator('.ingest-preview-row')).toHaveCount(24);
    await page.locator('#ingestBtn').click();
    await expect(page.locator('#ingestStatus')).toContainText('Indexed 24 conversations');
    await page.locator('.export-guides summary').click();

    await expectWithinViewport(page.locator('.main'));
    await expectWithinViewport(page.locator('.main-scroll'));
    await expectReachable(page.locator('#ingestStatus'));
    await page.screenshot({ path: test.info().outputPath('indexing-complete.png') });
    expect(
      await page.locator('.main-scroll').evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);

    if (viewport.width <= 1180) await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.locator('#sidebarChatHistoryToggle').click();
    await expect(page.locator('.sb-chat-item')).toHaveCount(24);
    await expectWithinViewport(page.locator('.sidebar'));
    await expectReachable(page.locator('.sb-chat-item').last());
    await expectReachable(page.locator('.sb-coll-row').last());
    await expectReachable(page.locator('#indexingNavBtn'));
    await expectReachable(page.locator('.sb-footer-row .theme-toggle'));
    expect(await page.locator('.sidebar').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(
      true,
    );

    if (viewport.width <= 1180) {
      await page
        .getByRole('button', { name: 'Close sidebar' })
        .click({ position: { x: viewport.width - 8, y: 8 } });
      await expect(page.locator('.sidebar')).toBeHidden();
      await expectReachable(page.locator('#ingestStatus'));
    }
  });
}

for (const viewport of [
  { width: 640, height: 260 },
  { width: 360, height: 360 },
  { width: 320, height: 200 },
]) {
  test(`collection dialog and command palette fit a short ${viewport.width}x${viewport.height} window`, async ({
    page,
    uiUrl,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${uiUrl}/indexing`);
    await page.locator('#newCollectionBtnIndexing').click();
    await expectWithinViewport(page.locator('.modal-card'));
    await expectReachable(page.getByPlaceholder('my-archive'));
    await page.getByPlaceholder('my-archive').fill('test_archive');
    await expectReachable(page.locator('.modal-foot .primary'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.keyboard.press('Control+k');
    await expectWithinViewport(page.locator('.cmdk'));
    await expectReachable(page.locator('.cmdk-item').last());
    await page.keyboard.press('Escape');
    await expect(page.locator('.cmdk')).toHaveCount(0);
  });
}

test('individual export files can be selected without a directory picker', async ({
  page,
  uiUrl,
}) => {
  await page.route('**/api/collections', (route) =>
    route.fulfill({ json: { collections: ['chunks'] } }),
  );
  await page.goto(`${uiUrl}/indexing`);
  await expect(page.locator('#targetCollectionSelect')).toHaveValue('chunks');
  await page.locator('#exportFileInput').setInputFiles([
    { name: 'conversation.json', mimeType: 'application/json', buffer: Buffer.from('{}') },
    { name: 'conversation.html', mimeType: 'text/html', buffer: Buffer.from('<html></html>') },
    { name: 'archive.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic') },
  ]);
  await expect(page.locator('#folderChosenLabel')).toHaveText('3 export files selected');
  await expect(page.locator('.ingest-preview-row')).toHaveCount(3);
  const upload = page.waitForRequest('**/api/ingest-upload-progress');
  await page.locator('#ingestBtn').click();
  expect((await upload).postData()).toContain('name="collectionName"\r\n\r\nchunks');
  await expect(page.locator('#ingestStatus')).toContainText('Indexed 24 conversations');

  await page.getByPlaceholder('/absolute/path/to/exports').fill('/synthetic/second-folder');
  await page.getByRole('button', { name: 'Use path' }).click();
  await expect(page.locator('.ingest-preview-row')).toHaveCount(24);
  const pathIngest = page.waitForRequest('**/api/ingest-progress');
  await page.locator('#ingestBtn').click();
  expect((await pathIngest).postDataJSON().folderPath).toBe('/synthetic/second-folder');
});

test('long conversations scroll to their final message and back without moving the reader toolbar', async ({
  page,
  uiUrl,
}) => {
  await page.setViewportSize({ width: 360, height: 540 });
  const params = new URLSearchParams({
    sourceFile: '/synthetic/conversation.json',
    collection: collectionNames[0],
    title: 'LongConversationTitle'.repeat(16),
  });
  await page.goto(`${uiUrl}/thread?${params}`);
  await expect(page.locator('.turn')).toHaveCount(30);
  await expectWithinViewport(page.locator('#threadContent'));
  await expectWithinViewport(page.locator('.thread-bar'));
  await expectReachable(page.locator('.thread-end'));
  await expectReachable(
    page.locator('.turn').last().getByRole('heading', { name: 'Response 30', exact: true }),
  );
  await expectWithinViewport(page.locator('.thread-bar'));
  expect(
    await page.locator('#threadContent').evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
  ).toBe(true);
  await page.locator('#threadContent').evaluate((e) => {
    e.scrollTop = 0;
  });
  const title = await page.locator('.thread-hero h1').boundingBox();
  const toolbar = await page.locator('.thread-bar').boundingBox();
  expect(title.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  expect(title.x + title.width).toBeLessThanOrEqual(360);
});

test('token presets fit above a low input and remain selectable after resizing', async ({
  page,
  uiUrl,
}) => {
  await page.setViewportSize({ width: 800, height: 360 });
  await page.goto(`${uiUrl}/settings`);
  const input = page.locator('#llamaContextSize');
  await input.scrollIntoViewIfNeeded();
  await input.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await input.click();
  await expectWithinViewport(page.locator('.number-combobox-popover'));
  await page.setViewportSize({ width: 480, height: 280 });
  await input.scrollIntoViewIfNeeded();
  await expectWithinViewport(page.locator('.number-combobox-popover'));
  const last = page.locator('.number-combobox-popover [role="option"]').last();
  await expectReachable(last);
  await last.click();
  await expect(page.locator('.number-combobox-popover')).toHaveCount(0);
  await expect(input).toHaveValue('262144');
});

test('nested model and token lists escape the composer clipping area and preserve selection', async ({
  page,
  uiUrl,
}) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto(`${uiUrl}/chat?private=layout-test`);
  await page.locator('#modelMenuButton').click();
  await page.getByRole('combobox', { name: 'Generation model', exact: true }).click();
  await page.getByLabel('Generation model').press('ArrowDown');
  await expectWithinViewport(page.locator('.model-combobox-popover'));
  const lastModel = page.locator('.model-option').last();
  await expectReachable(lastModel);
  await lastModel.click();
  await expect(page.locator('.model-popover')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Generation model', exact: true })).toHaveValue(
    'Synthetic model 29',
  );
  await page.locator('#chatContextSize').click();
  await page.getByLabel('Context window in tokens').press('ArrowDown');
  await expectWithinViewport(page.locator('.number-combobox-popover'));
  const lastPreset = page.locator('.number-combobox-popover [role="option"]').last();
  await expectReachable(lastPreset);
  await lastPreset.click();
  await expect(page.locator('.model-popover')).toBeVisible();
  await expect(page.locator('#chatContextSize')).toHaveValue('131072');
});
