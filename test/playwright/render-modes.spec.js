/* global window, document, innerWidth, ThreadShelfRenderer */
import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

// Exercise the real renderer and React adapter without a database, embedding
// model or external service. Every browser request is intercepted explicitly.
const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://renderer.test';
const portrait = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAABkCAIAAAAJyYebAAAAMklEQVR4nO3LMQEAMAgAoLlItrKk2cygN/xEVr+rf56yLMuyLMuyLMuyLMuyLMuyLC8NgoECIU0Tt4wAAAAASUVORK5CYII=', 'base64');
let javascript;
let css;

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Markdown } from './client/src/components/Markdown.tsx';
        export { mountMarkdown, configureMarkdownImages } from './client/src/enhanced-renderer/renderer.js';
        export { setRendererLocale } from './client/src/enhanced-renderer/locale.js';
        export { useUIStore } from './client/src/store.ts';
        const roots = new WeakMap();
        export function mountReact(container, props) {
          let root = roots.get(container);
          if (!root) { root = createRoot(container); roots.set(container, root); }
          root.render(React.createElement(Markdown, props));
        }
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    globalName: 'ThreadShelfRenderer',
    outfile: 'renderer-harness.js',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  javascript = output.outputFiles.find((file) => file.path.endsWith('.js')).text;
  css = output.outputFiles.find((file) => file.path.endsWith('.css')).text;
});

async function prepare(page) {
  const unexpected = [];
  const assets = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><main id="content" class="enhanced-markdown message-content"></main></body></html>' });
    }
    if (url.origin === origin && /^\/renderer\/(mathjax-tex-svg|mermaid\.min)\.js$/.test(url.pathname)) {
      assets.push(url.pathname);
      return route.fulfill({ contentType: 'text/javascript', body: await readFile(join(root, 'client/public', url.pathname)) });
    }
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.goto(origin);
  await page.addStyleTag({ content: ':root{--text-0:#eef2f8;--text-1:#dbe5f1;--text-2:#aab7c9;--bg-0:#101721;--bg-1:#182330;--bg-2:#202d3e;--bg-3:#263547;--border-1:#41516a;--accent:#7ab4ff;--r-xs:4px;--fs-meta:11.5px;--fs-micro:11px;--font-mono:monospace}body{margin:16px;background:var(--bg-0);color:var(--text-0);font:16px/1.5 sans-serif}#content{max-width:900px}button{font:inherit}' + css });
  await page.addScriptTag({ content: javascript });
  return { unexpected, assets };
}

async function mount(page, text, options = {}) {
  await page.evaluate(({ text, options }) => {
    window.dispose?.();
    window.dispose = ThreadShelfRenderer.mountMarkdown(document.querySelector('#content'), text, options);
  }, { text, options });
}

test('basic mode keeps Markdown, underline and tables while advanced content stays inert source', async ({ page }) => {
  const { unexpected, assets } = await prepare(page);
  const equation = '\\(x_1^2 + \\frac{1}{2}\\)';
  const source = [
    '**Bold** and *italic* and <u>underlined</u>.',
    '| Name | Count |\n| --- | --- |\n| First | 2 |',
    '<table><tr><td>HTML cell</td></tr></table>',
    equation,
    '```mermaid\ngraph TD\nA[Start] --> B[End]\n```',
    '<box padding={2}><text>Archived widget</text></box>',
    '<u onclick="window.executed = true">unsafe attribute</u><script>window.executed = true</script>',
    '[unsafe](javascript:alert(1))',
  ].join('\n\n');
  await mount(page, source, { rich: false });
  await expect(page.locator('strong')).toHaveText('Bold');
  await expect(page.locator('em')).toHaveText('italic');
  await expect(page.locator('u')).toHaveText('underlined');
  await expect(page.locator('table')).toHaveCount(2);
  await expect(page.locator('.chatgpt-math-source')).toHaveText(equation);
  await expect(page.locator('pre.language-mermaid code')).toHaveText('graph TD\nA[Start] --> B[End]');
  await expect(page.locator('#content')).toContainText('<box padding={2}>');
  await expect(page.locator('#content')).toContainText('<u onclick=');
  await expect(page.locator('script')).toHaveCount(1); // Only the test's trusted bundle.
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('mjx-container,.mermaid-block,.rich-box')).toHaveCount(0);
  expect(await page.evaluate(() => window.executed)).toBeUndefined();
  expect(unexpected).toEqual([]);
  expect(assets).toEqual([]);
});

test('rich mode still renders local equations and diagrams', async ({ page }) => {
  const { unexpected, assets } = await prepare(page);
  await mount(page, '\\[x^2+1\\]\n\n```mermaid\ngraph TD\nA[Start] --> B[End]\n```');
  await expect(page.locator('mjx-container svg')).toBeVisible();
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible();
  expect(new Set(assets)).toEqual(new Set(['/renderer/mathjax-tex-svg.js', '/renderer/mermaid.min.js']));
  expect(unexpected).toEqual([]);
});

test('per-role settings select basic or rich rendering and survive a reload', async ({ page }) => {
  const { assets } = await prepare(page);
  await page.evaluate(() => {
    ThreadShelfRenderer.useUIStore.getState().setRichRendering('user', false);
    ThreadShelfRenderer.useUIStore.getState().setRichRendering('thinking', false);
    ThreadShelfRenderer.useUIStore.getState().setRichRendering('ai', true);
    const root = document.querySelector('#content');
    ThreadShelfRenderer.mountReact(root, { text: '**Prompt** \\(x^2\\)', role: 'user', eager: true });
  });
  await expect(page.locator('[data-render-mode="basic"] strong')).toHaveText('Prompt');
  await expect(page.locator('mjx-container')).toHaveCount(0);
  expect(assets).toEqual([]);
  await page.evaluate(() => ThreadShelfRenderer.useUIStore.getState().setRichRendering('user', true));
  await expect(page.locator('[data-render-mode="rich"] mjx-container')).toBeVisible();
  await page.reload();
  await page.addScriptTag({ content: javascript });
  expect(await page.evaluate(() => ThreadShelfRenderer.useUIStore.getState().richRendering)).toEqual({ user: true, thinking: false, ai: true });
});

test('collapsed and offscreen messages defer full rich work without losing their source', async ({ page }) => {
  const { assets } = await prepare(page);
  const text = '**Preview**\n\n' + 'paragraph '.repeat(300) + '\n\n\\[x^2+1\\]';
  await page.evaluate((text) => {
    const root = document.querySelector('#content');
    root.style.marginTop = '3000px';
    ThreadShelfRenderer.mountReact(root, { text, role: 'ai', collapsed: true });
  }, text);
  await expect(page.locator('[data-render-state="deferred"]')).toHaveCount(1);
  expect(assets).toEqual([]);
  await page.locator('[data-render-state="deferred"]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-render-preview] strong')).toHaveText('Preview');
  await expect(page.locator('#content')).not.toContainText('x^2+1');
  expect(assets).toEqual([]);
  await page.evaluate((text) => ThreadShelfRenderer.mountReact(document.querySelector('#content'), { text, role: 'ai', collapsed: false }), text);
  await expect(page.locator('mjx-container')).toHaveCount(1);
  await expect(page.locator('#content')).toContainText('paragraph '.repeat(20).trim());
});

test('image clicks load through the collection proxy and never navigate, including linked images', async ({ page }) => {
  const { unexpected } = await prepare(page);
  const fetched = [];
  await page.route('**/api/image-cache/resource?**', (route) => {
    fetched.push(new URL(route.request().url()));
    return route.fulfill({ contentType: 'image/png', body: portrait });
  });
  await mount(page, '[before ![Portrait](https://image.example.test/photo.png) after](https://destination.example.test/)\n\nEnd.', { rich: false, collection: 'photos' });
  await expect(page.locator('.reader-image-load')).toBeVisible();
  await expect(page.locator('a .reader-markdown-image')).toHaveCount(0);
  await expect(page.locator('a')).toHaveCount(2);
  expect(fetched).toEqual([]);
  const startUrl = page.url();
  await page.getByRole('button', { name: /Load image/ }).click();
  await expect(page.locator('[data-image-state="loaded"] img')).toBeVisible();
  expect(fetched).toHaveLength(1);
  expect(fetched[0].searchParams.get('collection')).toBe('photos');
  expect(fetched[0].searchParams.get('url')).toBe('https://image.example.test/photo.png');
  await page.locator('[data-image-state="loaded"] img').click();
  expect(page.url()).toBe(startUrl);
  expect(unexpected).toEqual([]);
});

test('automatic image loading preserves decoded images when switched back to click mode', async ({ page }) => {
  const { unexpected } = await prepare(page);
  let fetched = 0;
  await page.route('**/api/image-cache/resource?**', (route) => {
    fetched++;
    return route.fulfill({ contentType: 'image/png', body: portrait });
  });
  await page.evaluate(() => {
    ThreadShelfRenderer.useUIStore.getState().setImageLoadMode('auto');
    ThreadShelfRenderer.mountReact(document.querySelector('#content'), { text: '![Portrait](https://image.example.test/auto.png)', role: 'ai', eager: true, collection: 'photos' });
  });
  await expect(page.locator('[data-image-state="loaded"] img')).toBeVisible();
  await page.evaluate(() => ThreadShelfRenderer.useUIStore.getState().setImageLoadMode('click'));
  await expect(page.locator('[data-image-state="loaded"] img')).toBeVisible();
  expect(fetched).toBe(1);
  expect(unexpected).toEqual([]);
});

test('all six Reader placeholder designs keep compact and full-width geometry', async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 680, height: 900 });
  await page.route('**/api/image-cache/resource?**', (route) => route.fulfill({ status: 404, body: 'Unavailable' }));
  await mount(page, [
    '![Missing wide](sandbox:/missing-wide.png)',
    'Inline ![Missing compact](sandbox:/missing-compact.png) prose.',
    '![Click wide](https://image.example.test/wide.png)',
    'Inline ![Click compact](https://image.example.test/compact.png) prose.',
  ].join('\n\n'), { rich: false, collection: 'photos' });
  await expect(page.locator('[data-image-state="missing"][data-image-design="wide"] [data-placeholder-design="soft-horizon"]')).toHaveCount(1);
  await expect(page.locator('[data-image-state="missing"][data-image-design="compact"] [data-placeholder-design="corner-aperture"]')).toHaveCount(1);
  await expect(page.locator('[data-image-design="wide"] .reader-image-load-background')).toHaveCount(1);
  await expect(page.locator('[data-image-design="compact"] .reader-image-load-art')).toHaveCount(1);
  await page.getByRole('button', { name: 'Load image · Click wide', exact: true }).click();
  await page.getByRole('button', { name: 'Load image · Click compact', exact: true }).click();
  await expect(page.locator('[data-image-state="failed"] .reader-image-failure-art')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Retry image · Click compact', exact: true })).toBeVisible();
  const retriesDoNotCoverLabels = await page.locator('[data-image-state="failed"]').evaluateAll((elements) => elements.every((element) => {
    const label = element.querySelector('.reader-image-failure-copy').getBoundingClientRect();
    const retry = element.querySelector('.reader-image-retry').getBoundingClientRect();
    return retry.top >= label.bottom;
  }));
  expect(retriesDoNotCoverLabels).toBe(true);
  const ratios = await page.locator('.reader-image-fallback').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { design: element.closest('.reader-markdown-image').dataset.imageDesign, ratio: box.width / box.height };
  }));
  for (const item of ratios) expect(item.ratio).toBeCloseTo(item.design === 'compact' ? 5 / 4 : 16 / 9, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('renderer controls and image states honor Russian localization', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => ThreadShelfRenderer.setRendererLocale('ru'));
  await mount(page, '```text\nsource\n```\n\n![Image](https://image.example.test/localized.png)', { rich: false });
  await expect(page.getByRole('button', { name: 'Копировать блок кода в буфер обмена' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Загрузить изображение/ })).toBeVisible();
});
