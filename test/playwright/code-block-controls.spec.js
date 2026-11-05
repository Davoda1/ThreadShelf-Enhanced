// Production renderer with synthetic content; no archive, model or server data.
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let bundle;
let stylesheet;
let mermaid;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {mountMarkdown} from './client/src/enhanced-renderer/renderer.js';
        import {parseSvgPreview} from './client/src/enhanced-renderer/svg-preview.js';
        import './client/src/enhanced-renderer/enhanced-markdown.css';
        window.parseSvgPreview = parseSvgPreview;
        window.renderTestMarkdown = (source, options = {}) => {
          window.disposeTestMarkdown?.();
          window.disposeTestMarkdown = mountMarkdown(document.getElementById('host'), source, options);
        };`,
      resolveDir: root,
    },
    outfile: 'renderer-test.js', bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  });
  bundle = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).text;
  mermaid = await readFile(new URL('../../client/public/renderer/mermaid.min.js', import.meta.url), 'utf8');
});

async function openRenderer(page) {
  await page.route('http://localhost/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/renderer-test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (pathname === '/renderer-test.css') return route.fulfill({ contentType: 'text/css', body: stylesheet });
    if (pathname === '/renderer/mermaid.min.js') return route.fulfill({ contentType: 'text/javascript', body: mermaid });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'">
      <link rel="stylesheet" href="/renderer-test.css"><style>
        body { font: 14px/1.55 Arial,sans-serif; margin: 0; padding: 16px; color: #e6eaef; background: #101418; }
        #host { --bg-0:#101418; --bg-1:#171e25; --bg-2:#202a34; --bg-3:#263340; --bg-hover:#324150; --text-0:#f7f9fb; --text-1:#d7e1e9; --text-2:#96a8b9; --border-0:#2b3742; --border-1:#405261; --accent:#27cee8; --warning:#f6c05e; --r-xs:4px; --r-md:8px; --fs-meta:12px; --font-mono:monospace; --role-reasoning:#c394fc; --role-response:#99d795; --danger:#fa97a8; }
        .md-body pre { font: 14px/1.55 monospace; border: 1px solid var(--border-1); border-radius: 8px; background: var(--bg-1); padding: 12px; }
        /* The existing shared rule loads after renderer CSS in the app. */
        .md-body pre code { padding: 0; white-space: pre; }
      </style></head><body><main id="host" class="md-body enhanced-markdown"></main><script src="/renderer-test.js"></script></body></html>` });
  });
  await page.goto('http://localhost/');
  await page.waitForFunction(() => typeof window.renderTestMarkdown === 'function');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost' });
}

async function render(page, source, options = {}) {
  await page.evaluate(({ source, options }) => window.renderTestMarkdown(source, options), { source, options });
}

async function downloadSource(page, button, expectedFilename, source) {
  const downloading = page.waitForEvent('download');
  await button.click();
  const file = await downloading;
  expect(file.suggestedFilename()).toBe(expectedFilename);
  expect(await readFile(await file.path(), 'utf8')).toBe(source);
}

test('numbered source retains exact copy, download and native selection, including multiline tokens and blank lines', async ({ page }) => {
  await openRenderer(page);
  const source = '/* A multiline comment\n   retains its syntax style. */\n\nconst greeting = "Árvíztűrő 日本語 😀";\n\tconsole.log(greeting);\n';
  await render(page, '```mjs\n' + source + '\n```', { codeLineNumbers: true, codeWrap: true });
  const pre = page.locator('pre');
  const code = pre.locator('code');
  await expect(code).toHaveText(source);
  expect(await code.textContent()).toBe(source);
  await expect(pre.locator('.code-line-number')).toHaveCount(source.split('\n').length);
  await expect(pre.locator('.code-line-source').nth(1).locator('.hljs-comment')).toHaveText('   retains its syntax style. */');
  expect(await pre.locator('.code-line-number').allTextContents()).toEqual(Array(source.split('\n').length).fill(''));
  const selection = await code.evaluate(node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selection).toBe(source);
  await page.keyboard.press('Control+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await pre.locator('.code-copy-button').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await downloadSource(page, pre.locator('.code-download-button'), 'code-block-1.mjs', source);
  const padding = await code.evaluate(node => { const style = getComputedStyle(node); return [parseFloat(style.paddingTop), parseFloat(style.paddingLeft)]; });
  expect(padding[0]).toBeGreaterThan(5);
  expect(padding[1]).toBeGreaterThan(padding[0]);
});

test('scroll and wrap modes keep long lines within narrow layouts, with one number per source line', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openRenderer(page);
  const source = 'const value = "' + 'very-long-token-'.repeat(40) + '";\n\nconsole.log(value);';
  for (const codeLineNumbers of [false, true]) for (const codeWrap of [false, true]) {
    await render(page, '```javascript\n' + source + '\n```', { codeLineNumbers, codeWrap });
    const pre = page.locator('pre');
    const layout = await pre.evaluate(node => {
      node.scrollLeft = node.scrollWidth;
      const code = node.querySelector('code');
      return { offset: node.scrollLeft, width: node.clientWidth, scroll: node.scrollWidth, docOverflow: document.documentElement.scrollWidth > innerWidth, codeText: code.textContent };
    });
    expect(layout.docOverflow).toBe(false);
    expect(layout.codeText).toBe(source);
    expect(await pre.locator('code').evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    })).toBe(source);
    if (codeWrap) expect(layout.scroll).toBeLessThanOrEqual(layout.width + 1);
    else expect(layout.offset).toBeGreaterThan(0);
    await expect(pre.locator('.code-line-number')).toHaveCount(codeLineNumbers ? 3 : 0);
    if (codeLineNumbers && codeWrap) {
      const heights = await pre.locator('.code-line-source').evaluateAll(lines => lines.map(line => line.getBoundingClientRect().height));
      expect(heights[0]).toBeGreaterThan(heights[2] * 2);
    }
  }
});

test('native selection preserves empty, leading, consecutive, whitespace-only and trailing source lines', async ({ page }) => {
  await openRenderer(page);
  const cases = ['', '\n', '\n\n', 'a\n\n\nb', '\na', 'a\n\n', '  \n  \n\t', '/* multi\n\nline */'];
  for (const source of cases) {
    await render(page, '```javascript\n' + source + '\n```', { codeLineNumbers: true, codeWrap: true });
    const values = await page.locator('pre code').evaluate(code => {
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      return { text: code.textContent, selected: selection.toString() };
    });
    expect(values.text).toBe(source);
    expect(values.selected).toBe(source);
  }
});

test('very large numbered blocks retain complete source without an unbounded presentation DOM', async ({ page }) => {
  await openRenderer(page);
  const source = Array.from({ length: 10_001 }, (_, index) => `line-${index + 1}`).join('\n');
  await render(page, '```text\n' + source + '\n```', { codeLineNumbers: true, codeWrap: true });
  await expect(page.locator('pre')).toHaveAttribute('data-line-numbers-limited', 'true');
  await expect(page.locator('.code-block-note')).toHaveText('Line numbers unavailable for this large block');
  await expect(page.locator('.code-line-number')).toHaveCount(0);
  expect(await page.locator('pre code').textContent()).toBe(source);
  await page.locator('.code-copy-button').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await downloadSource(page, page.locator('.code-download-button'), 'code-block-1.txt', source);
});

test('multi-digit gutter numbers fit a single source row without wrapping or clipping', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openRenderer(page);
  const source = Array.from({ length: 110 }, (_, index) => `const value${index + 1} = ${index + 1};`).join('\n');
  await render(page, '```javascript\n' + source + '\n```', { codeLineNumbers: true, codeWrap: true });
  const overflowing = await page.locator('.code-line-number').evaluateAll(numbers => numbers.filter(number => number.scrollHeight > number.clientHeight + 1 || number.scrollWidth > number.clientWidth + 1).map(number => number.dataset.lineNumber));
  expect(overflowing).toEqual([]);
  await expect(page.locator('.code-line-number').last()).toHaveAttribute('data-line-number', '110');
});

test('download preferences, original fence extensions and deterministic numbering are independent of syntax aliases', async ({ page }) => {
  await openRenderer(page);
  const samples = [
    { language: 'html', source: '<div>HTML</div>', extension: 'html' },
    { language: 'xml', source: '<value>XML</value>', extension: 'xml' },
    { language: 'svg', source: '<svg><circle r="5"/></svg>', extension: 'svg' },
    { language: 'fish', source: 'echo $fish_pid', extension: 'fish' },
    { language: 'not-a-language', source: 'unknown type', extension: 'txt' },
    { language: '', source: 'untagged', extension: 'txt' },
    { language: 'plain', source: 'plain text', extension: 'txt' },
  ];
  const markdown = samples.map(sample => '```' + sample.language + '\n' + sample.source + '\n```').join('\n\n');
  await render(page, markdown);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    await downloadSource(page, page.locator('.code-download-button').nth(index), `code-block-${index + 1}.${sample.extension}`, sample.source);
  }
  await render(page, markdown, { codeDownloads: false, rich: false, codeLineNumbers: true });
  await expect(page.locator('.code-download-button')).toHaveCount(0);
  await expect(page.locator('.code-copy-button')).toHaveCount(samples.length);
  await expect(page.locator('[data-toggle-svg]')).toHaveCount(0);
  await expect(page.locator('.code-line-number')).toHaveCount(samples.length);
});

test('SVG eligibility validates standalone XML and Base64 while preserving source in both views', async ({ page }) => {
  await openRenderer(page);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><rect width="240" height="80" fill="#087a92"/><text x="10" y="45" fill="white">Árvíztűrő 日本語 😀</text></svg>';
  const base64 = Buffer.from(svg).toString('base64');
  const samples = [
    ['svg', svg, true], ['xml', svg, true], ['', svg, true],
    ['svg', '<!-- before -->\n' + svg + '\n<!-- after -->', true],
    ['svg', '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>', true],
    ['', base64, true], ['xml', 'data:image/svg+xml;base64,' + base64, true],
    ['svg', base64.match(/.{1,60}/g).join('\n'), true],
    ['html', svg, false], ['text', svg, false], ['javascript', svg, false],
    ['xml', '<html><body>' + svg + '</body></html>', false], ['', '<div>' + svg + '</div>', false],
    ['svg', 'extra ' + svg, false], ['xml', svg + ' extra', false], ['svg', svg + svg, false],
    ['xml', svg + '<p/>', false], ['svg', '<svg><rect></svg>', false],
    ['svg', '<!-- bad -- comment -->' + svg, false],
    ['xml', '<svg xmlns="https://invalid.example/"/>', false],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg" xmlns="http://www.w3.org/2000/svg"/>', false],
    ['xml', '<svg><g xmlns:x="urn:x" xmlns:x="urn:x"/></svg>', false],
    ['svg', Buffer.from('<html>' + svg + '</html>').toString('base64'), false],
    ['', base64 + '!', false], ['svg', Buffer.from([0xff, 0xfe, 0x3c]).toString('base64'), false],
    ['svg', '<!DOCTYPE svg [<!ENTITY x "expanded">]><svg>&x;</svg>', false],
    ['xml', '<?xml-stylesheet href="https://invalid.example/x"?><svg/>', false],
  ];
  await render(page, samples.map(([fence, source]) => '```' + fence + '\n' + source + '\n```').join('\n\n'), { codeLineNumbers: true });
  const blocks = page.locator('pre');
  await expect(blocks).toHaveCount(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const [, source, eligible] = samples[index];
    const pre = blocks.nth(index);
    expect(await pre.locator('code').textContent()).toBe(source);
    await expect(pre.locator('[data-toggle-svg]')).toHaveCount(Number(eligible));
    if (!eligible) continue;
    const toggle = pre.locator('[data-toggle-svg]');
    await expect(pre.locator('.code-svg-preview img[src]')).toHaveCount(0);
    for (let pass = 0; pass < 2; pass++) {
      await toggle.click();
      await pre.locator('.code-svg-preview img').evaluate(image => image.decode());
      await expect(toggle).toHaveText('Code');
      await expect(pre.locator('code')).toBeHidden();
      await pre.locator('.code-copy-button').click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
      await toggle.click();
      await expect(toggle).toHaveText('Render');
      await expect(pre.locator('code')).toBeVisible();
    }
  }
  expect(await page.evaluate(() => window.parseSvgPreview('<svg>' + ' '.repeat(2 * 1024 * 1024) + '</svg>', 'svg'))).toBeNull();
});

test('SVG image mode cannot execute or fetch embedded content and errors restore source controls', async ({ page }) => {
  await openRenderer(page);
  const external = [];
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('https://svg-preview.invalid/**', route => { external.push(route.request().url()); return route.abort(); });
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" onload="parent.svgExecuted=true"><script>parent.svgExecuted=true;fetch("https://svg-preview.invalid/script")</script><style>@import url("https://svg-preview.invalid/style");rect{fill:url("https://svg-preview.invalid/paint")}</style><image href="https://svg-preview.invalid/image"/><use href="https://svg-preview.invalid/use#x"/><foreignObject width="100" height="100"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://svg-preview.invalid/html-image" onerror="parent.svgExecuted=true"/><iframe src="https://svg-preview.invalid/frame"/></div></foreignObject><a href="https://svg-preview.invalid/link"><text x="10" y="20">Inert image</text></a></svg>';
  await render(page, '```svg\n' + source + '\n```', { codeLineNumbers: true, codeWrap: true });
  await page.locator('[data-toggle-svg]').click();
  const image = page.locator('.code-svg-preview img');
  await image.evaluate(image => image.decode());
  expect(await page.evaluate(() => window.svgExecuted)).toBeUndefined();
  await expect(page.locator('#host script, #host foreignObject, #host iframe')).toHaveCount(0);
  await expect(image).toHaveAttribute('draggable', 'false');
  expect(await image.evaluate(image => ['click', 'auxclick', 'contextmenu', 'dragstart'].map(type => image.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))))).toEqual([false, false, false, false]);
  await downloadSource(page, page.locator('.code-download-button'), 'code-block-1.svg', source);
  await image.dispatchEvent('error');
  await expect(page.locator('pre code')).toBeVisible();
  await expect(page.locator('.code-svg-preview')).toBeHidden();
  await expect(page.locator('[data-toggle-svg]')).toBeDisabled();
  await expect(page.locator('[data-toggle-svg]')).toHaveAttribute('aria-label', 'SVG preview unavailable');
  await page.locator('.code-copy-button').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('Mermaid downloads follow repaired/original source and remain numbered between ordinary fences', async ({ page }) => {
  await openRenderer(page);
  const source = 'graph TD\nA[Result (draft)] --> B[Done]';
  await render(page, '```text\nfirst\n```\n\n```mermaid\n' + source + '\n```\n\n```json\n{}\n```', { codeLineNumbers: true, codeWrap: true });
  const block = page.locator('.mermaid-block');
  await expect(block).toHaveAttribute('data-mermaid-state', 'repaired');
  const repaired = await block.evaluate(node => node.mermaidRepairSource);
  expect(repaired).not.toBe(source);
  await downloadSource(page, block.locator('.code-download-button'), 'code-block-2.mmd', repaired);
  await block.locator('[data-toggle-mermaid-version]').click();
  await expect(block).toHaveAttribute('data-mermaid-state', 'original-error');
  expect(await block.locator('code').textContent()).toBe(source);
  await expect(block.locator('.code-line-number')).toHaveCount(2);
  await downloadSource(page, block.locator('.code-download-button'), 'code-block-2.mmd', source);
  await block.locator('[data-copy-mermaid]').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await downloadSource(page, page.locator('pre.language-json .code-download-button'), 'code-block-3.json', '{}');
  await render(page, '```svg\n<svg/>\n```');
  await page.evaluate(() => window.disposeTestMarkdown());
  await page.locator('[data-toggle-svg]').click();
  await expect(page.locator('[data-toggle-svg]')).toHaveAttribute('aria-pressed', 'false');
});
