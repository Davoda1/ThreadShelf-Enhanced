/* global localStorage, navigator, window, document, getComputedStyle, innerWidth */
// Actual production UI and isolated server, with synthetic per-turn response data.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { test, expect } from './fixtures.js';

const grokCitation = '<grok:render card_id="saved-source" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">0</argument></grok:render>';
const metadata = { content_references: [
  { type: 'grouped_webpages', items: [{ url: 'https://example.com/recorded', title: 'Recorded source', refs: [{ turn_index: 0, ref_index: 0, ref_type: 'search' }] }] },
  { type: 'file', filename: 'Saved-report.pdf', ref_id: 'turn2file0' },
] };
const raw = { card_attachments_json: JSON.stringify([{ id: 'saved-source', cardType: 'citation_card', title: 'Recorded Grok source', url: 'https://example.org/grok' }]) };
const richText = [
  '### Sources inside a conversation',
  'Venice references stay beside the text.^1^^12^ Another passage.^2^',
  'ChatGPT source citeturn0search0 and file fileciteturn2file0L12-L19.',
  'Grok source ' + grokCitation,
  '<mark>Highlighted</mark> and <span style="color:#e64340;background-color:#a8c0ff">Colored text</span>.',
].join('\n\n');

async function openThread(page, baseUrl, turns, preferences = {}) {
  const errors = [];
  const external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(baseUrl + '/')) external.push(request.url());
  });
  await page.addInitScript(preferences => {
    localStorage.setItem('threadshelf:ui', JSON.stringify({ version: 0, state: {
      theme: 'dark', locale: 'en', imageLoadMode: 'click',
      richRendering: { user: true, thinking: false, ai: true },
      conversationDisplay: { jsonVisibility: 'show', jsonAsCode: false, codeDownloads: true, codeWrap: false, codeLineNumbers: false },
      ...preferences,
    } }));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__render142Copied = value; } } });
  }, preferences);
  await page.route('**/api/thread?**', route => route.fulfill({ json: {
    sourceFile: '/synthetic/rendering-142.json', collection: 'pw_fixture', title: 'Rendering 1.4.2', createdInThreadShelf: false, turns,
  } }));
  await page.goto(`${baseUrl}/thread?sourceFile=%2Fsynthetic%2Frendering-142.json&collection=pw_fixture&title=Rendering%201.4.2`);
  await expect(page.locator('.turn .enhanced-markdown')).toHaveCount(turns.length);
  for (const turn of await page.locator('.turn').all()) {
    await turn.scrollIntoViewIfNeeded();
    const expand = turn.getByRole('button', { name: 'Show more', exact: true });
    if (await expand.count()) await expand.click();
    await expect(turn.locator('.enhanced-markdown')).toHaveAttribute('data-render-state', 'mounted');
  }
  return { errors, external };
}

for (const theme of ['light', 'dark']) {
  test(`provider citations and safe HTML render in user and response bubbles (${theme})`, async ({ page, serverContext }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const evidence = await openThread(page, serverContext.baseUrl, [{ user: richText, metadata, raw }, { ai: richText, metadata, raw }], { theme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const role of ['user', 'ai']) {
      const bubble = page.locator(`.turn[data-role="${role}"] .enhanced-markdown`);
      await bubble.scrollIntoViewIfNeeded();
      await expect(bubble.locator('.venice-citation')).toHaveText(['1', '12', '2']);
      await expect(bubble.locator('.venice-citation a,a.venice-citation')).toHaveCount(0);
      await expect(bubble.locator('.rich-citation-link')).toHaveAttribute('href', 'https://example.com/recorded');
      await expect(bubble.locator('.rich-file-reference')).toContainText('Saved-report.pdf');
      await expect(bubble.locator('.rich-file-reference')).toContainText('L12-L19');
      await expect(bubble.locator('.grok-citation a')).toHaveAttribute('href', 'https://example.org/grok');
      await expect(bubble.locator('mark')).toHaveText('Highlighted');
      const colors = await bubble.locator('span').filter({ hasText: /^Colored text$/ }).evaluate(node => {
        const style = getComputedStyle(node); return { color: style.color, background: style.backgroundColor };
      });
      expect(colors).toEqual({ color: 'rgb(230, 67, 64)', background: 'rgb(168, 192, 255)' });
      const citationGeometry = await bubble.locator('.venice-citation').first().evaluate(node => {
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        return { height: rect.height, width: rect.width, radius: parseFloat(style.borderRadius), background: style.backgroundColor };
      });
      expect(citationGeometry.height).toBeGreaterThan(12);
      expect(citationGeometry.height).toBeLessThan(30);
      expect(citationGeometry.width).toBeGreaterThan(12);
      expect(citationGeometry.radius).toBeGreaterThan(0);
      expect(citationGeometry.background).not.toBe('rgba(0, 0, 0, 0)');
      await expect(bubble.locator('script,iframe,object,embed,[onclick],[onerror]')).toHaveCount(0);
    }
    expect(evidence.errors).toEqual([]);
    expect(evidence.external).toEqual([]);
    if (process.env.THREADSHELF_RENDERING_SCREENSHOTS) {
      await mkdir(process.env.THREADSHELF_RENDERING_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.THREADSHELF_RENDERING_SCREENSHOTS, `rendering-142-${theme}.png`), animations: 'disabled' });
    }
  });
}

test('basic mode retains safe typography and Venice numbers while advanced markers remain literal', async ({ page, serverContext }) => {
  const evidence = await openThread(page, serverContext.baseUrl, [{ user: richText }, { ai: richText }], { richRendering: { user: false, thinking: false, ai: false } });
  for (const bubble of await page.locator('.enhanced-markdown').all()) {
    await bubble.scrollIntoViewIfNeeded();
    await expect(bubble).toHaveAttribute('data-render-mode', 'basic');
    await expect(bubble.locator('.venice-citation')).toHaveText(['1', '12', '2']);
    await expect(bubble.locator('mark')).toHaveText('Highlighted');
    await expect(bubble).toContainText('citeturn0search0');
    await expect(bubble).toContainText(grokCitation);
    await expect(bubble.locator('.grok-citation,.rich-citation-link')).toHaveCount(0);
  }
  expect(evidence.errors).toEqual([]);
  expect(evidence.external).toEqual([]);
});

test('code copy, download and whole-message copy preserve original provider and HTML source', async ({ page, serverContext }) => {
  const source = '^1^ citeturn0search0\n' + grokCitation + '\n<span style="color:#e64340">Árvíztűrő 日本語</span>';
  const message = 'Visible citation.^9^\n\n```html\n' + source + '\n```\n\n`^8^`';
  const evidence = await openThread(page, serverContext.baseUrl, [{ ai: message, metadata, raw }]);
  const bubble = page.locator('.turn[data-role="ai"]');
  await expect(bubble.locator('.venice-citation')).toHaveText(['9']);
  const code = bubble.locator('pre code');
  expect(await code.textContent()).toBe(source);
  await expect(code.locator('.venice-citation,.grok-citation,.rich-citation-link')).toHaveCount(0);
  await bubble.locator('.code-copy-button').click();
  expect(await page.evaluate(() => window.__render142Copied)).toBe(source);
  const downloading = page.waitForEvent('download');
  await bubble.locator('.code-download-button').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('code-block-1.html');
  expect(await readFile(await download.path(), 'utf8')).toBe(source);
  await bubble.locator('.turn-head .copy-turn').first().click();
  expect(await page.evaluate(() => window.__render142Copied)).toBe(message);
  expect(evidence.errors).toEqual([]);
  expect(evidence.external).toEqual([]);
});

test('escaped, mathematical and code caret sequences stay source while plain markers render', async ({ page, serverContext }) => {
  const source = ['Plain.^123^', '`^8^`', '\\^6^', '<code>^4^</code>', '<pre>^5^</pre>', '    ^7^', 'Math $x^2$ and \\(x^{2}\\)', 'Malformed ^x^ ^-1^ ^1.5^ ^ 1 ^'].join('\n\n');
  const evidence = await openThread(page, serverContext.baseUrl, [{ ai: source }]);
  const bubble = page.locator('.enhanced-markdown');
  await expect(bubble.locator('.venice-citation')).toHaveText(['123']);
  for (const literal of ['^8^', '^6^', '^4^', '^5^', '^7^', '^x^', '^-1^', '^1.5^', '^ 1 ^']) await expect(bubble).toContainText(literal);
  await expect(bubble.locator('code .venice-citation,pre .venice-citation')).toHaveCount(0);
  expect(evidence.errors).toEqual([]);
  expect(evidence.external).toEqual([]);
});

test('hostile HTML, CSS and archived widgets cannot execute or load external resources', async ({ page, serverContext }) => {
  const hostile = [
    '<span style="color:red;background-image:url(https://attacker.example.test/a);position:fixed;inset:0" onclick="window.render142Executed=true">Dangerous attributes</span>',
    '<img src="https://attacker.example.test/image" onerror="window.render142Executed=true">',
    '<script>window.render142Executed=true</script>',
    '<iframe src="https://attacker.example.test/frame"></iframe>',
    '<a href="javascript:window.render142Executed=true">Unsafe link</a>',
    '<svg onload="window.render142Executed=true"><a href="https://attacker.example.test/svg">SVG link</a></svg>',
    '<grok:render card_type="ui_card" card_id="future"><argument name="html"><![CDATA[<script>window.render142Executed=true</script>]]></argument></grok:render>',
    'genui{"future_widget":{"html":"<img src=https://attacker.example.test/widget>","action":"run"}}',
    'Surviving text.^2^',
  ].join('\n\n');
  const evidence = await openThread(page, serverContext.baseUrl, [{ user: hostile }, { ai: hostile }]);
  for (const bubble of await page.locator('.enhanced-markdown').all()) {
    await bubble.scrollIntoViewIfNeeded();
    await expect(bubble).toContainText('Surviving text.');
    await expect(bubble.locator('.venice-citation')).toHaveText(['2']);
    await expect(bubble.locator('script,iframe,object,embed,form,img[src],[onclick],[onerror],[onload],a[href^="javascript:"]')).toHaveCount(0);
    const unsafeStyles = await bubble.locator('[style]').evaluateAll(nodes => nodes.filter(node => /url\(|position\s*:|inset\s*:/i.test(node.getAttribute('style'))).length);
    expect(unsafeStyles).toBe(0);
  }
  expect(await page.evaluate(() => window.render142Executed)).toBeUndefined();
  expect(evidence.errors).toEqual([]);
  expect(evidence.external).toEqual([]);
});

test('same citation IDs in different turns remain scoped and unresolved sources do not acquire links', async ({ page, serverContext }) => {
  const text = 'ChatGPT citeturn0search0. Grok ' + grokCitation + ' Venice.^1^';
  const evidence = await openThread(page, serverContext.baseUrl, [
    { ai: text, metadata, raw },
    { ai: text, metadata: { content_references: [{ type: 'webpage', ref_id: 'turn0search0', url: 'https://example.net/second' }] }, raw: { card_attachments_json: JSON.stringify([{ id: 'saved-source', cardType: 'citation_card', url: 'https://example.net/second-grok' }]) } },
    { ai: text },
  ]);
  const bubbles = page.locator('.enhanced-markdown');
  await expect(bubbles.nth(0).locator('.rich-citation-link')).toHaveAttribute('href', 'https://example.com/recorded');
  await expect(bubbles.nth(1).locator('.rich-citation-link')).toHaveAttribute('href', 'https://example.net/second');
  await expect(bubbles.nth(0).locator('.grok-citation a')).toHaveAttribute('href', 'https://example.org/grok');
  await expect(bubbles.nth(1).locator('.grok-citation a')).toHaveAttribute('href', 'https://example.net/second-grok');
  await expect(bubbles.nth(2).locator('a')).toHaveCount(0);
  await expect(bubbles.nth(2).locator('.venice-citation')).toHaveText(['1']);
  expect(evidence.errors).toEqual([]);
  expect(evidence.external).toEqual([]);
});

for (const width of [320, 680]) {
  test(`rendering additions stay within the conversation panel at ${width}px`, async ({ page, serverContext }) => {
    await page.setViewportSize({ width, height: 700 });
    const evidence = await openThread(page, serverContext.baseUrl, [{ user: richText, metadata, raw }, { ai: richText, metadata, raw }]);
    for (const bubble of await page.locator('.enhanced-markdown').all()) {
      await bubble.scrollIntoViewIfNeeded();
      await expect(bubble.locator('.venice-citation')).toHaveCount(3);
      const geometry = await bubble.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, right: node.getBoundingClientRect().right, viewport: innerWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(evidence.errors).toEqual([]);
    expect(evidence.external).toEqual([]);
  });
}

test('saved Grok images use the existing explicit-load proxy and never contact the archived host directly', async ({ page, serverContext }) => {
  const requests = [];
  await page.route('**/api/image-cache/resource?**', route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LxkAAAAASUVORK5CYII=', 'base64') });
  });
  const marker = '<grok-card data-id="saved-image" data-type="image_card" data-plain-type="render_searched_image"></grok-card>';
  const evidence = await openThread(page, serverContext.baseUrl, [{ ai: marker, raw: { cardAttachment: [{ id: 'saved-image', cardType: 'image_card', image: { original: 'https://example.org/saved-image.png', title: 'Recorded image' } }] } }]);
  const bubble = page.locator('.enhanced-markdown');
  await expect(bubble.getByRole('button', { name: /^Load image/ })).toBeVisible();
  await expect(bubble.locator('img[src]')).toHaveCount(0);
  expect(requests).toEqual([]);
  await bubble.getByRole('button', { name: /^Load image/ }).click();
  await expect(bubble.locator('.archived-image-loaded img')).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get('url')).toBe('https://example.org/saved-image.png');
  expect(requests[0].searchParams.get('collection')).toBe('pw_fixture');
  expect(evidence.errors).toEqual([]);
  expect(evidence.external).toEqual([]);
});
