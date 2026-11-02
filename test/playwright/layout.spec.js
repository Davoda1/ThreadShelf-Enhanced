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
  let completedJob;
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/import-jobs' || pathname === '/api/import-jobs/upload') {
      if (route.request().method() === 'POST') {
        const isUpload = pathname.endsWith('/upload');
        const input = isUpload
          ? {
              collection: route
                .request()
                .postData()
                .match(/name="collectionName"\r\n\r\n([^\r\n]*)/)?.[1],
              clearFirst: false,
            }
          : route.request().postDataJSON();
        completedJob = {
          id: 'synthetic-layout-job',
          collection: input.collection,
          kind: isUpload ? 'upload' : 'folder',
          state: 'completed',
          clearFirst: input.clearFirst,
          createdAt: Date.now() - 1000,
          updatedAt: Date.now(),
          cancelRequested: false,
          attempts: 1,
          safeToClose: true,
          collectionLocked: false,
          result: { files, conversations: 24, ingested: 72, elapsedMs: 1000 },
        };
        // Submission only acknowledges receipt. The subsequent jobs refresh
        // delivers the persisted completion, as the real background API does.
        await route.fulfill({
          status: 202,
          json: { job: { ...completedJob, state: 'queued', result: undefined } },
        });
      } else {
        await route.fulfill({ json: { jobs: completedJob ? [completedJob] : [] } });
      }
      return;
    }
    const responses = {
      '/api/health': { ok: true },
      '/api/memory': {
        totalBytes: 16 * 1024 ** 3,
        availableBytes: 12 * 1024 ** 3,
        reserveBytes: 1024 ** 3,
        rssBytes: 512 * 1024 ** 2,
        heapUsedBytes: 128 * 1024 ** 2,
        heapLimitBytes: 4 * 1024 ** 3,
        externalBytes: 128 * 1024 ** 2,
        processBudgetBytes: 8 * 1024 ** 3,
        pressure: 'normal',
        reason: null,
      },
      '/api/collections': { collections: collectionNames },
      '/api/collections/all/stats': { ...stats[0], collections: stats },
      '/api/files': { files: [] },
      '/api/image-cache': {
        enabled: false,
        maxBytes: 512 * 1024 ** 2,
        bytes: 0,
        count: 0,
        collections: [],
      },
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
      '/api/generation/runtime': { runtime: { state: 'stopped', detail: 'No model loaded.' } },
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
        runtime: { state: 'stopped', detail: 'No model loaded.' },
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
    await expect(page.locator('.import-job[data-job-id="synthetic-layout-job"]')).toHaveAttribute(
      'data-state',
      'completed',
    );
    await expect(page.locator('.import-job')).toContainText('24 conversations; 72 indexed chunks.');
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
  const upload = page.waitForRequest('**/api/import-jobs/upload');
  await page.locator('#ingestBtn').click();
  expect((await upload).postData()).toContain('name="collectionName"\r\n\r\nchunks');
  await expect(page.locator('#ingestStatus')).toContainText('Indexed 24 conversations');

  await page.getByPlaceholder('/absolute/path/to/exports').fill('/synthetic/second-folder');
  await page.getByRole('button', { name: 'Use path' }).click();
  await expect(page.locator('.ingest-preview-row')).toHaveCount(24);
  const pathIngest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/import-jobs' && request.method() === 'POST',
  );
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
  // A wrapped toolbar can leave the last message just above the footer's
  // viewport. Bring that deferred Markdown block into view before its heading.
  await page.locator('.turn').last().scrollIntoViewIfNeeded();
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

for (const theme of ['dark', 'light']) {
  test(`settings tabs preserve drafts and fixed widths without overflow (${theme})`, async ({
    page,
    uiUrl,
  }) => {
    await page.addInitScript(
      (theme) =>
        localStorage.setItem('threadshelf:ui', JSON.stringify({ state: { theme }, version: 0 })),
      theme,
    );
    await page.setViewportSize({ width: 680, height: 540 });
    await page.goto(`${uiUrl}/settings`);
    const tabs = page.locator('.settings-tabs [role="tab"]');
    await expect(tabs).toHaveCount(3);
    await expect(page.locator('.settings-save')).toBeEnabled();
    await page.getByLabel('API base URL', { exact: true }).fill('http://192.168.1.5:1234/v1');
    const widths = [];
    for (const tab of ['ai', 'server', 'tts', 'ai']) {
      await page.locator(`#settings-tab-${tab}`).click();
      await expect(page.locator(`#settings-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
      const boxes = await tabs.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().width),
      );
      expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(1);
      widths.push(boxes);
      const overflow = await page
        .locator('.main-scroll')
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    expect(
      widths.every((values) => values.every((value, i) => Math.abs(value - widths[0][i]) < 1)),
    ).toBe(true);
    await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(
      'http://192.168.1.5:1234/v1',
    );
    await page.locator('#settings-tab-ai').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#settings-tab-server')).toBeFocused();
    await expect(page.locator('#appearance-heading')).toBeVisible();
    await expect(page.getByLabel(/Save generation errors/)).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`settings-server-${theme}.png`) });
  });
}

test('settings cannot overwrite server values before hydration', async ({ page, uiUrl }) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let saves = 0;
  await page.route('**/api/generation/config', async (route) => {
    if (route.request().method() === 'PUT') saves += 1;
    await gate;
    await route.fallback();
  });
  await page.goto(`${uiUrl}/settings`);
  await expect(page.locator('.settings-save')).toBeDisabled();
  await expect(page.locator('#llamaContextSize')).toBeDisabled();
  await page.locator('#settings-tab-server').click();
  await expect(page.locator('.settings-save')).toBeDisabled();
  expect(saves).toBe(0);
  release();
  await expect(page.locator('.settings-save')).toBeEnabled();
});

test('private messages, drafts and interrupted output stay in memory and reset on reload', async ({
  page,
  uiUrl,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('privacy-seeded')) {
      sessionStorage.setItem('privacy-seeded', '1');
      sessionStorage.setItem(
        'threadshelf:private-chat',
        JSON.stringify({
          createdAt: '2025-10-01T00:00:00Z',
          messages: [{ role: 'user', content: 'legacy private content' }],
        }),
      );
      sessionStorage.setItem(
        'threadshelf:interrupted-generations:2025-10-01T00:00:00Z',
        '[{"prompt":"legacy content"}]',
      );
    }
  });
  await page.route('**/api/generation/chat/stream', (route) =>
    route.fulfill({
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify({ type: 'delta', content: 'private partial secret' })}\n${JSON.stringify({ type: 'error', error: 'Synthetic interruption' })}\n`,
    }),
  );
  await page.goto(`${uiUrl}/chat?private=privacy-check`);
  await expect(page.locator('#continueSend')).toBeDisabled();
  await page.locator('#continuePrompt').fill('Private test prompt');
  await expect(page.locator('#continueSend')).toBeEnabled();
  await page.locator('#continueSend').click();
  await expect(page.locator('.interrupted-generation')).toContainText('private partial secret');
  await page.locator('#continuePrompt').fill('Unsent private draft');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#sidebarPrivateChatButton').click();
  await expect(page.locator('#continuePrompt')).toHaveValue('Unsent private draft');
  await expect(page.locator('.interrupted-generation')).toContainText('private partial secret');
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  for (const text of [
    'Private test prompt',
    'private partial secret',
    'Unsent private draft',
    'legacy private content',
  ]) {
    expect(stored.local).not.toContain(text);
    expect(stored.session).not.toContain(text);
  }
  await page.reload();
  await expect(page.locator('#continuePrompt')).toHaveValue('');
  await expect(page.locator('.interrupted-generation')).toHaveCount(0);
});

test('hybrid search sends its additive mode and preserves it in the URL', async ({
  page,
  uiUrl,
}) => {
  const requests = [];
  await page.route('**/api/search?*', (route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { results: [] } });
  });
  await page.goto(`${uiUrl}/search/all`);
  await page.getByRole('button', { name: 'Hybrid', exact: true }).click();
  await page.locator('#searchInput').fill('árvíztűrő API-123');
  await page.locator('#searchInput').press('Enter');
  await expect.poll(() => requests.at(-1)?.searchParams.get('mode')).toBe('hybrid');
  await expect(page).toHaveURL(/mode=hybrid/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Hybrid', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('streaming preference survives provider changes and send/stop controls keep their width', async ({
  page,
  uiUrl,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let request;
  await page.route('**/api/generation/chat/stream', async (route) => {
    request = route.request().postDataJSON();
    await gate;
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify({ type: 'done', response: { provider: 'strata', model: 'synthetic-0.gguf', content: 'Complete synthetic reply.' } })}\n`,
    });
  });
  await page.goto(`${uiUrl}/chat?private=stream-check`);
  await page.getByLabel('Stream response', { exact: true }).uncheck();
  await page.locator('#modelMenuButton').click();
  await page.getByRole('tab', { name: 'Strata · local' }).click();
  await expect(page.getByRole('tab', { name: 'Strata · local' })).toBeEnabled();
  await page.locator('#modelMenuButton').click();
  await page.locator('#continuePrompt').fill('A synthetic prompt.');
  const before = await page.locator('#continueSend').boundingBox();
  await page.locator('#continueSend').click();
  const stop = page.locator('.composer-send').filter({ hasText: 'Stop' });
  await expect(stop).toBeVisible();
  const during = await stop.boundingBox();
  expect(during.width).toBe(before.width);
  expect(during.x).toBe(before.x);
  await expect.poll(() => request?.streamOutput).toBe(false);
  expect(request.provider).toBe('strata');
  release();
  await expect(page.locator('.generated-turn[data-role="ai"]')).toContainText(
    'Complete synthetic reply.',
  );
  await page.reload();
  await expect(page.getByLabel('Stream response', { exact: true })).not.toBeChecked();
  await page.locator('#modelMenuButton').click();
  await expect(page.getByRole('tab', { name: 'Strata · local' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('remembered provider, paid model and catalog filters survive reload together', async ({
  page,
  uiUrl,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('threadshelf:ui'))
      localStorage.setItem(
        'threadshelf:ui',
        JSON.stringify({
          state: {
            generationProvider: 'openrouter',
            generationModels: { openrouter: 'synthetic/paid' },
            generationFreeOnly: false,
            generationCatalogSort: 'newest',
          },
          version: 0,
        }),
      );
  });
  const requests = [];
  await page.route('**/api/generation/models?provider=openrouter*', (route) => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        provider: 'openrouter',
        models: [
          { id: 'synthetic/free', name: 'Free alternative', provider: 'openrouter' },
          { id: 'synthetic/paid', name: 'Remembered paid model', provider: 'openrouter' },
        ],
        runtime: { state: 'remote', detail: 'Synthetic remote catalog' },
      },
    });
  });
  await page.goto(`${uiUrl}/chat?private=model-memory-check`);
  await expect(page.locator('#modelMenuButton')).toContainText('Remembered paid model');
  expect(requests.at(-1).searchParams.get('free')).toBeNull();
  expect(requests.at(-1).searchParams.get('sort')).toBe('newest');
  await page.locator('#modelMenuButton').click();
  await expect(page.getByLabel('Free only')).not.toBeChecked();
  await expect(page.getByLabel('Sort OpenRouter models')).toHaveValue('newest');
  await page.reload();
  await expect(page.locator('#modelMenuButton')).toContainText('Remembered paid model');
});

test('blocked browser storage keeps settings and private chat usable in memory', async ({
  page,
  uiUrl,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException('Storage blocked by browser policy', 'SecurityError');
        },
      });
  });
  await page.goto(`${uiUrl}/settings`);
  await page.locator('#settings-tab-server').click();
  await page.locator('#interface-language').selectOption('hu');
  await expect(page.locator('#appearance-heading')).toHaveText('Megjelenés és nyelv');
  await page.locator('#sidebarPrivateChatButton').click();
  await page.locator('#continuePrompt').fill('Memory-only input');
  await expect(page.locator('#continuePrompt')).toHaveValue('Memory-only input');
  expect(errors).toEqual([]);
});

// Labels, provenance and navigation are complete text, rather than hover-only
// ellipses. These fixtures deliberately combine long identifiers with the
// translations whose controls need the most room.
for (const locale of ['en', 'hu', 'de', 'fr', 'ru', 'ja']) {
  test(`main pages and model menus keep full localized labels (${locale})`, async ({
    page,
    uiUrl,
  }) => {
    const title = 'Detailed synthesis of archive search, server configuration and model workflows';
    const sourceFile = `/synthetic/${'LongExportFilename_'.repeat(6)}2026-11-02.json`;
    const model = 'SyntheticOrganisation/LongModelName_With_Quantization_Q4_K_M';
    const modelPath = `/synthetic/models/${model}/model.Q4_K_M.gguf`;
    await page.addInitScript((locale) => {
      localStorage.setItem('threadshelf:ui', JSON.stringify({ state: { locale }, version: 0 }));
    }, locale);
    await page.route('**/api/files*', (route) =>
      route.fulfill({
        json: {
          files: [
            {
              sourceFile,
              collection: collectionNames[0],
              title,
              turnCount: 1234,
              provider: 'openai',
              lastTurnAt: '2026-10-20T12:35:41Z',
            },
          ],
        },
      }),
    );
    await page.route('**/api/search*', (route) =>
      route.fulfill({
        json: {
          results: [
            {
              document: 'A synthetic search result with complete model provenance.',
              distance: 0.15,
              metadata: {
                role: 'ai',
                provider: 'openai',
                sourceFile,
                collection: collectionNames[0],
                title,
                turnIndex: 3,
                model,
                createdAt: '2026-10-20T12:35:41Z',
              },
            },
          ],
        },
      }),
    );
    await page.route('**/api/insights*', (route) =>
      route.fulfill({
        json: {
          collection: 'all',
          totals: { collections: 30, files: 24, chunks: 5402, conversations: 245, turns: 13892 },
          roles: { user: 20, thinking: 12, ai: 26 },
          activity: [
            { month: '2026-01', count: 240 },
            { month: '2026-02', count: 560 },
          ],
          topModels: [{ model, count: 2578 }],
          providers: [{ provider: 'openai', conversations: 1234, turns: 5678 }],
          longestThreads: [
            {
              collection: collectionNames[0],
              sourceFile,
              conversationKey: 'synthetic',
              title,
              provider: 'openai',
              turnCount: 1234,
              lastTurnAt: '2026-10-20T12:35:41Z',
            },
          ],
          firstActivity: '2026-01-01T00:00:00Z',
          lastActivity: '2026-10-20T12:35:41Z',
        },
      }),
    );
    await page.route('**/api/generation/models*', (route) =>
      route.fulfill({
        json: {
          provider: 'llama-cpp',
          models: [
            {
              id: 'synthetic-long-model.gguf',
              name: model,
              path: modelPath,
              provider: 'llama-cpp',
              sizeBytes: 4 * 1024 ** 3,
              contextLength: 131072,
            },
          ],
          runtime: { state: 'stopped', detail: 'No model loaded.' },
        },
      }),
    );
    const labelsFit = async (selector) => {
      const clipped = await page.locator(selector).evaluateAll((elements) =>
        elements.flatMap((e) => {
          const rect = e.getBoundingClientRect();
          if (!rect.width || !rect.height || !e.clientWidth) return [];
          return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1
            ? [
                {
                  text: e.textContent,
                  className: e.className,
                  width: e.clientWidth,
                  scrollWidth: e.scrollWidth,
                  height: e.clientHeight,
                  scrollHeight: e.scrollHeight,
                },
              ]
            : [];
        }),
      );
      expect(clipped).toEqual([]);
    };
    const enlargedLabelsFit = async (selector) => {
      // Read all original sizes before changing any ancestor, so inherited
      // fonts are doubled once rather than compounding to four/eight times.
      await page.evaluate(() => {
        const fonts = [...document.querySelectorAll('body *')]
          .filter((e) => !e.closest('svg'))
          .map((e) => [e, getComputedStyle(e).fontSize]);
        for (const [e, size] of fonts) {
          e.dataset.layoutOriginalFont = e.style.fontSize;
          e.style.fontSize = `${parseFloat(size) * 2}px`;
        }
      });
      try {
        if (await page.locator('.model-combobox input').count())
          await page.locator('.model-combobox input').first().scrollIntoViewIfNeeded();
        else if (await page.locator('#continuePrompt').count())
          await page.locator('#continuePrompt').scrollIntoViewIfNeeded();
        const clippedPlaceholders = await page
          .locator('#searchInput, .model-combobox input, .cmdk-input input, #continuePrompt')
          .evaluateAll((elements) =>
            elements.flatMap((e) => {
              const rect = e.getBoundingClientRect();
              const style = getComputedStyle(e);
              if (
                !rect.width ||
                !rect.height ||
                rect.bottom <= 0 ||
                rect.top >= innerHeight ||
                style.visibility === 'hidden' ||
                style.opacity === '0' ||
                e.value ||
                !e.placeholder
              )
                return [];
              const context = document.createElement('canvas').getContext('2d');
              context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              const needed =
                context.measureText(e.placeholder).width +
                (parseFloat(style.letterSpacing) || 0) * Math.max(0, e.placeholder.length - 1);
              const available =
                e.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
              return needed > available + 1
                ? [{ placeholder: e.placeholder, needed, available }]
                : [];
            }),
          );
        expect(clippedPlaceholders).toEqual([]);
        if (await page.locator('#continuePrompt').count()) {
          await labelsFit('.composer-keyboard-help');
          const accessibleHint = await page.locator('#continuePrompt').evaluate((e) => {
            const hint = document.getElementById('composer-keyboard-help');
            const describedBy = (e.getAttribute('aria-describedby') || '').split(/\s+/);
            if (!hint || !describedBy.includes(hint.id) || !hint.textContent.trim()) return false;
            const bounds = hint.parentElement.getBoundingClientRect();
            const rect = hint.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.left >= bounds.left &&
              rect.right <= bounds.right &&
              rect.bottom <= bounds.bottom
            );
          });
          expect(accessibleHint).toBe(true);
        }
        await labelsFit(selector);
        if (await page.locator('.model-combobox-popover').count()) {
          const overflow = await page.locator('.model-combobox-popover').evaluate((e) => {
            const bounds = e.getBoundingClientRect();
            const summary = e.querySelector('.model-combobox-summary');
            return [...summary.querySelectorAll('span')].some((label) => {
              const rect = label.getBoundingClientRect();
              return (
                rect.left < bounds.left ||
                rect.right > bounds.right ||
                label.scrollWidth > label.clientWidth + 1
              );
            });
          });
          expect(overflow).toBe(false);
        }
        if (await page.locator('.model-status-name').count()) {
          const lineSpacing = await page
            .locator('.model-status-name')
            .first()
            .evaluate((e) => {
              const style = getComputedStyle(e);
              return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
            });
          expect(lineSpacing).toBeGreaterThanOrEqual(1.2);
        }
        const outside = await page.locator(selector).evaluateAll((elements) =>
          elements.flatMap((e) => {
            const rect = e.getBoundingClientRect();
            return rect.width && rect.height && (rect.left < -1 || rect.right > innerWidth + 1)
              ? [{ text: e.textContent, className: e.className, right: rect.right }]
              : [];
          }),
        );
        expect(outside).toEqual([]);
        if (await page.locator('.topbar').count()) {
          const contained = await page.locator('.topbar').evaluate((e) => {
            const bar = e.getBoundingClientRect();
            const crumbs = e.querySelector('.crumbs')?.getBoundingClientRect();
            return !crumbs || (crumbs.top >= bar.top && crumbs.bottom <= bar.bottom);
          });
          expect(contained).toBe(true);
        }
      } finally {
        await page.evaluate(() => {
          for (const e of document.querySelectorAll('[data-layout-original-font]')) {
            e.style.fontSize = e.dataset.layoutOriginalFont;
            delete e.dataset.layoutOriginalFont;
          }
        });
      }
    };
    for (const width of [320, 680, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 650 });
      await page.goto(`${uiUrl}/search/all`);
      await expect(page.locator('.r-source-file')).toBeAttached();
      await labelsFit('.r-source-file, .r-source-coll');
      if (width < 1440)
        await enlargedLabelsFit('.mode-btn, .role-chip, .example-chip, .r-source-file');
      if (width <= 1180) await page.locator('.mobile-menu-btn').click();
      await labelsFit('.sb-coll-meta b, .sb-coll-meta span, .sb-cmdk > span, .sb-item .label');
      await page.locator('#sidebarChatHistoryToggle').click();
      await labelsFit('.sb-chat-item strong, .sb-chat-item span');
      if (width < 1440)
        await enlargedLabelsFit('.sb-section > span, .sb-coll-meta b, .sb-coll-meta span');
      if (width <= 1180) await page.keyboard.press('Escape');

      await page.goto(`${uiUrl}/search/all?q=example&mode=keyword`);
      const saveSearch = page.locator('.save-search');
      await expect(saveSearch).toBeVisible();
      await expect(page.locator('.r-foot > .mono')).toHaveText(model);
      const unsavedSize = await saveSearch.boundingBox();
      await saveSearch.click();
      const savedSize = await saveSearch.boundingBox();
      expect(savedSize.width).toBe(unsavedSize.width);
      expect(savedSize.height).toBe(unsavedSize.height);
      if (width < 1440) await enlargedLabelsFit('.r-foot > span, .save-search');

      await page.goto(
        `${uiUrl}/thread?${new URLSearchParams({
          sourceFile,
          collection: collectionNames[0],
          title,
          model,
        })}`,
      );
      await expect(page.locator('.thread-hero')).toBeVisible();
      await labelsFit('.title-preview, .path-crumb, .thread-hero .v');
      if (width < 1440)
        await enlargedLabelsFit('.title-preview, .thread-hero .v, .role-toggle, .composer-send');
      expect(
        await page.locator('#threadContent').evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);

      await page.goto(`${uiUrl}/insights`);
      await expect(page.locator('.longest-row')).toBeAttached();
      await labelsFit('.bar-label, .l-title, .l-meta');
      await expectWithinViewport(page.locator('.insights-scope'));
      if (width < 1440)
        await enlargedLabelsFit('.insights-head h2, .stat-label, .stat-value, .l-title, .l-meta');
      expect(
        await page.locator('.main-scroll').evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
      ).toBe(true);
      await page.locator('.col-slot').last().hover();
      await expectWithinViewport(page.locator('.chart-tip'));
      await labelsFit('.chart-tip');

      await page.goto(`${uiUrl}/chat?private=localized-layout`);
      await expect(page.locator('.model-status-name')).toHaveText(model);
      if (width < 1440) await enlargedLabelsFit('#continuePrompt, .composer-keyboard-help');
      await page.locator('#modelMenuButton').click();
      await page.locator('.model-combobox input').first().click();
      await page.locator('.model-combobox input').first().press('ArrowDown');
      await expect(page.locator('.model-option').first()).toBeVisible();
      await expect(page.locator('.model-option-copy strong').first()).toHaveText(model);
      await expect(page.locator('.model-option-copy > span').first()).toHaveText(modelPath);
      await labelsFit('.model-option-copy strong, .model-option-copy span, .model-status-name');
      if (width < 1440)
        await enlargedLabelsFit(
          '.model-popover-providers button, .model-option-meta, .model-favorite, .model-status-name, .composer-send',
        );

      await page.goto(`${uiUrl}/mcp`);
      for (const panel of await page.locator('.mcp-code-panel').all()) {
        const geometry = await panel.evaluate((e) => ({
          code: e.querySelector('pre').getBoundingClientRect().bottom,
          action: e.querySelector('button').getBoundingClientRect().top,
        }));
        expect(geometry.action).toBeGreaterThanOrEqual(geometry.code);
      }
      const copy = page.locator('.mcp-code-panel button').first();
      const before = await copy.boundingBox();
      await copy.click();
      const after = await copy.boundingBox();
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
      if (width < 1440) {
        await page.keyboard.press('Control+k');
        await expect(page.locator('.cmdk-input input')).toBeVisible();
        await enlargedLabelsFit('.cmdk-input input');
        await page.keyboard.press('Escape');
      }
    }
  });
}

// Exercise complete localized settings and dialogs, including the actual native
// select interaction behind the wrapping selected-value presentation.
for (const locale of ['en', 'hu', 'de', 'fr', 'ru', 'ja']) {
  test(`settings and model dialogs preserve localized text and select behavior (${locale})`, async ({
    page,
    uiUrl,
  }) => {
    const longName = 'SyntheticOrganisation/VeryLongMultilingualModelName_With_Quantization_Q4_K_M';
    const hardware = {
      devices: [],
      totalRamBytes: 16e9,
      freeRamBytes: 12e9,
      modelBudgetBytes: 8e9,
      vramBudgetBytes: 0,
      detectionSource: 'system',
      suggestedVariant: 'cpu',
    };
    const catalogModel = {
      id: longName,
      name: longName,
      author: 'SyntheticPublisherWithALongUnbrokenName',
      downloads: 1200000,
      likes: 450,
      gated: false,
      trustedPublisher: true,
    };
    await page.addInitScript(
      (locale) =>
        localStorage.setItem(
          'threadshelf:ui',
          JSON.stringify({ state: { locale, activeColl: 'archive_00' }, version: 0 }),
        ),
      locale,
    );
    await page.route('**/api/generation/catalog/search*', (route) =>
      route.fulfill({ json: { models: [catalogModel], hardware, tokenConfigured: false } }),
    );
    await page.route('**/api/generation/catalog/model*', (route) =>
      route.fulfill({
        json: {
          model: {
            ...catalogModel,
            projectors: [{ path: `${longName}-vision-projector.gguf`, sizeBytes: 268435456 }],
            quants: [
              {
                label: 'Q4_K_M',
                totalBytes: 2.5e9,
                shards: 1,
                recommended: true,
                fit: 'fits',
                files: [],
              },
            ],
          },
          hardware,
          tokenConfigured: false,
        },
      }),
    );
    await page.route('**/api/generation/directories*', (route) =>
      route.fulfill({
        json: {
          path: `/synthetic/${'LongDirectoryName_'.repeat(8)}`,
          parent: '/synthetic',
          roots: [{ name: 'Synthetic root', path: '/synthetic' }],
          directories: [{ name: 'LongDirectoryName_'.repeat(6), path: '/synthetic/child' }],
          truncated: false,
        },
      }),
    );
    await page.route('**/api/generation/local-api', (route) =>
      route.fulfill({
        json: {
          enabled: true,
          models: [{ id: longName, loaded: false }],
          network: { state: 'disabled', urls: [] },
        },
      }),
    );
    await page.route('**/api/files*', (route) =>
      route.fulfill({
        json: { files: [{ sourceFile: `/synthetic/${'FullVisibleExportName_'.repeat(8)}.json` }] },
      }),
    );
    await page.route('**/api/collections/archive_00/clear', (route) =>
      route.fulfill({
        status: 503,
        json: {
          error:
            'Synthetic test error with a complete diagnostic identifier: ' +
            'LongUnbrokenDiagnosticIdentifier_'.repeat(8),
        },
      }),
    );
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const labelsFit = async (scope, enlarged = false) => {
      const failures = await scope.evaluate((root) =>
        [...root.querySelectorAll('*')].flatMap((e) => {
          const rect = e.getBoundingClientRect(),
            style = getComputedStyle(e);
          if (
            !rect.width ||
            !rect.height ||
            style.visibility === 'hidden' ||
            ['SELECT', 'OPTION', 'INPUT', 'TEXTAREA', 'SVG', 'PATH'].includes(e.tagName) ||
            e.closest('pre, [hidden]')
          )
            return [];
          const clippedX =
            e.scrollWidth > e.clientWidth + 1 && ['hidden', 'clip'].includes(style.overflowX);
          const clippedY =
            e.scrollHeight > e.clientHeight + 1 && ['hidden', 'clip'].includes(style.overflowY);
          const clippedControl =
            e.matches('button, .native-select-value') &&
            e.clientWidth &&
            (e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1);
          const outside = rect.right > innerWidth + 1 || rect.left < -1;
          return clippedX || clippedY || clippedControl || outside
            ? [
                {
                  tag: e.tagName,
                  className: e.className,
                  text: e.textContent?.slice(0, 120),
                  right: rect.right,
                  width: e.clientWidth,
                  scroll: e.scrollWidth,
                },
              ]
            : [];
        }),
      );
      expect(failures).toEqual([]);
      if (!enlarged && ['hu', 'ru'].includes(locale)) {
        // Scale actual per-element text, including px-based labels; body font
        // scaling alone would miss controls with explicit font sizes.
        await scope.evaluate((root) => {
          const sizes = [root, ...root.querySelectorAll('*')].map((e) => [
            e,
            parseFloat(getComputedStyle(e).fontSize),
          ]);
          for (const [element, size] of sizes) {
            element.dataset.layoutOriginalFont = element.style.fontSize;
            element.style.fontSize = `${size * 2}px`;
          }
        });
        try {
          await labelsFit(scope, true);
        } finally {
          await scope.evaluate((root) => {
            for (const element of [root, ...root.querySelectorAll('[data-layout-original-font]')]) {
              element.style.fontSize = element.dataset.layoutOriginalFont;
              delete element.dataset.layoutOriginalFont;
            }
          });
        }
      }
    };
    for (const width of [320, 680, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 650 });
      await page.goto(`${uiUrl}/settings`);
      await expect(page.locator('.settings-save')).toBeEnabled();
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await page.locator('#settings-tab-server').click();
        await labelsFit(page.locator('.settings-page'));
        // Conditional per-collection management, its confirmation, and a long
        // server error must remain readable too. The mutation is fully mocked.
        await page.locator('.danger-row button').first().click();
        await labelsFit(page.getByRole('alertdialog'));
        await page.getByRole('alertdialog').locator('.modal-foot button').last().click();
        await expect(page.locator('.toast[data-type="error"]')).toBeVisible();
        await labelsFit(page.locator('.toaster'));
        const toastBounds = await page.locator('.toaster').boundingBox();
        expect(toastBounds.y).toBeGreaterThanOrEqual(0);
        await page.locator('.toast[data-type="error"]').click();
        const copy = page.locator('.local-api-row > button').first();
        const copyBefore = await copy.boundingBox();
        await copy.click();
        const copyAfter = await copy.boundingBox();
        expect(copyAfter.width).toBe(copyBefore.width);
        expect(copyAfter.height).toBe(copyBefore.height);
        const example = page.locator('.local-api-example');
        const exampleGeometry = await example.evaluate((e) => ({
          code: e.querySelector('pre').getBoundingClientRect().bottom,
          copy: e.querySelector(':scope > button').getBoundingClientRect().top,
        }));
        expect(exampleGeometry.copy).toBeGreaterThanOrEqual(exampleGeometry.code);
        const language = page.locator('#interface-language');
        await language.focus();
        await language.press('Home');
        await language.press('ArrowDown');
        await expect(language).toHaveValue('hu');
        await expect(language.locator('..').locator('.native-select-value')).toHaveText('Magyar');
        await language.selectOption(locale);
        await expect(language).toHaveValue(locale);
        // The guide includes tabbed content, long model IDs and scrollable code.
        await page.locator('.local-api').locator('..').locator('.panel-head-action').click();
        for (const tab of await page.locator('.guide-tabs button').all()) {
          await tab.click();
          await labelsFit(page.locator('.guide-modal'));
        }
        await page.keyboard.press('Escape');
        await page.locator('#settings-tab-ai').click();
        await labelsFit(page.locator('.settings-page'));
        await page.locator('.directory-picker-launch button:visible').first().click();
        await labelsFit(page.locator('.directory-picker').first());
        await page.locator('.directory-picker-bar button').last().click();
        await page.locator('.generation-actions > .btn.primary').first().click();
        await page.locator('.catalog-item-head').first().click();
        await expect(page.locator('.catalog-quant')).toHaveCount(1);
        await labelsFit(page.locator('.catalog-modal'));
        const sort = page.locator('.catalog-controls select');
        await sort.selectOption('likes');
        await expect(sort).toHaveValue('likes');
        const selected = await sort.evaluate((e) => e.selectedOptions[0].label);
        await expect(sort.locator('..').locator('.native-select-value')).toHaveText(selected);
        await page.locator('.catalog-modal .modal-foot button').click();
      }
    }
    expect(errors).toEqual([]);
  });
}

test('conversation sort reserves its option width and the native hit target follows wrapped text', async ({
  page,
  uiUrl,
}) => {
  for (const locale of ['en', 'hu', 'de', 'fr', 'ru', 'ja']) {
    await page.goto(`${uiUrl}/settings`);
    await page.locator('#settings-tab-server').click();
    await page.locator('#interface-language').selectOption(locale);
    await page.setViewportSize({ width: 320, height: 650 });
    await page.goto(`${uiUrl}/search/all`);
    const sort = page.locator('.conv-sort select');
    const shell = sort.locator('..');
    const initial = await shell.boundingBox();
    for (const value of ['title', 'longest', 'recent']) {
      await sort.selectOption(value);
      const current = await shell.boundingBox();
      expect(current.width).toBe(initial.width);
      await expect(sort).toHaveValue(value);
    }
    // A larger user font can make even a compact selector span several lines.
    await shell.evaluate((e) => {
      e.style.width = '100px';
      e.style.fontSize = '24px';
    });
    await shell.scrollIntoViewIfNeeded();
    const geometry = await shell.evaluate((e) => {
      const native = e.querySelector('select'),
        box = e.getBoundingClientRect(),
        control = native.getBoundingClientRect();
      return {
        height: box.height,
        nativeHeight: control.height,
        width: box.width,
        nativeWidth: control.width,
        bottomHit: document.elementFromPoint(box.left + box.width / 2, box.bottom - 3) === native,
      };
    });
    expect(geometry.nativeHeight).toBeGreaterThanOrEqual(geometry.height - 2.1);
    expect(geometry.nativeWidth).toBeGreaterThanOrEqual(geometry.width - 2.1);
    expect(geometry.bottomHit).toBe(true);
  }
});
