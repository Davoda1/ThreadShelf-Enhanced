/* global navigator, window, innerWidth */
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { test, expect } from './fixtures.js';

const chart = { chartType: 'bar', xKey: 'name', series: [{ dataKey: 'value', label: 'Value' }], data: [{ name: 'Alpha', value: 0 }, { name: 'Beta', value: -3 }] };
const richText = [
  '# Rich archive regression',
  '| First | Second |\n| --- | --- |\n| A | B |',
  '- [x] Preserved task\n- [ ] Pending task',
  '```fish\nset answer 42\necho $answer\n```',
  'Inline \\(x^2 + 1\\), display:\n\\[\\frac{1}{2} + \\sqrt{4}\\]',
  '```mermaid\ngraph TD\nA[Result (draft)] --> B[Done]\n```',
  '<row gap={2}><AsyncImage query="saved thumbnail query" width="160px" aspectRatio="4:3" /><text>A <Entity category="place" value="London" /> with <Cite ref="turn0search2" />.</text></row>',
  '<AsyncImage query="saved wide image query" width="100%" aspectRatio="16:9" />',
  `genui${JSON.stringify({ chart: { content: chart } })}`,
  '![Saved remote image](https://archive-image.example.test/saved.png)',
  '<img src="https://archive-image.example.test/unsafe.png" onerror="window.ARCHIVE_EXECUTED = true">',
  'Final readable paragraph.',
].join('\n\n');
const metadata = { content_references: [{ type: 'grouped_webpages', items: [{ url: 'https://example.com/source', title: 'Exact saved citation', refs: [{ turn_index: 0, ref_index: 2, ref_type: 'search' }] }] }] };
async function openSynthetic(page, baseUrl, text = richText) {
  await page.route('**/api/thread?**', route => route.fulfill({ json: { sourceFile: '/synthetic/rich.json', collection: 'pw_fixture', createdInThreadShelf: false, turns: [{ ai: text, metadata }] } }));
  await page.goto(`${baseUrl}/thread?sourceFile=%2Fsynthetic%2Frich.json&collection=pw_fixture&title=Rich%20archive`);
  await expect(page.locator('.enhanced-markdown')).toBeVisible();
}

test('rich archive renders locally, preserves source controls and contacts image hosts only after loading', async ({ page, serverContext }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__lastCopied = value; } } }));
  const remoteRequests = [];
  await page.route('**/api/image-cache/resource?**', route => {
    remoteRequests.push(new URL(route.request().url()).searchParams.get('url'));
    return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LxkAAAAASUVORK5CYII=', 'base64') });
  });
  await openSynthetic(page, serverContext.baseUrl);
  await expect(page.locator('.markdown-table-scroll table')).toContainText('Second');
  await expect(page.locator('.enhanced-markdown input[type=checkbox]')).toHaveCount(2);
  await expect(page.locator('pre.language-fish code .hljs-built_in').first()).toBeVisible();
  await page.locator('pre.language-fish .code-copy-button').click();
  expect(await page.evaluate(() => window.__lastCopied)).toBe('set answer 42\necho $answer');
  await expect(page.locator('.chatgpt-math-display mjx-container svg')).toBeVisible();
  await expect(page.locator('.mermaid-block')).toHaveAttribute('data-mermaid-state', 'repaired');
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible();
  await expect(page.locator('.rich-citation-link')).toHaveAttribute('href', 'https://example.com/source');
  await expect(page.locator('[data-placeholder-design="corner-aperture"]')).toHaveCount(1);
  await expect(page.locator('[data-placeholder-design="soft-horizon"]')).toHaveCount(1);
  await expect(page.locator('.rich-chart svg')).toBeVisible();
  await page.locator('.rich-chart summary').filter({ hasText: 'Exact values' }).click();
  await expect(page.locator('.rich-chart table')).toContainText('-3');
  expect(remoteRequests).toEqual([]);
  expect(await page.evaluate(() => window.ARCHIVE_EXECUTED)).toBeUndefined();
  await page.getByRole('button', { name: /Showing repaired Mermaid/ }).click();
  await expect(page.locator('.mermaid-error-source')).toContainText('A[Result (draft)] --> B[Done]');
  await page.locator('[data-copy-mermaid]').click();
  expect(await page.evaluate(() => window.__lastCopied)).toBe('graph TD\nA[Result (draft)] --> B[Done]');
  await page.getByRole('button', { name: /Showing original Mermaid/ }).click();
  await expect(page.locator('.mermaid-diagram svg')).toBeVisible();
  await page.getByRole('button', { name: /^Load image/ }).click();
  await expect(page.locator('.archived-image-loaded img')).toHaveCount(1);
  expect(remoteRequests).toEqual(['https://archive-image.example.test/saved.png']);
});

test('archive assets and legacy Processor markers display without altering literal code or triggering remote requests', async ({ page, serverContext }) => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LxkAAAAASUVORK5CYII=';
  const legacy = 'entity["city","London","UK"] citeturn0search2';
  const requests = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(serverContext.baseUrl)) requests.push(request.url()); });
  await page.route('**/api/thread?**', route => route.fulfill({ json: {
    sourceFile: '/synthetic/assets.json', collection: 'pw_fixture', createdInThreadShelf: false,
    turns: [
      { ai: `${legacy}\n\n\`${legacy}\`\n\n![Saved diagram](sandbox:/mnt/data/photo.png)\n\n\`\`\`mermaid\n%%{init: {themeCSS: "@import url(https://unsafe.example.test/style)"}}%%\ngraph TD\nA-->B\n\`\`\``, metadata, assets: [{ source: 'sandbox:/mnt/data/photo.png', url: dataUrl, label: 'photo.png' }] },
      { ai: '[Image attachment: file-service://saved-image]', assets: [{ source: 'file-service://saved-image', url: dataUrl, label: 'attached.png' }] },
    ],
  } }));
  await page.goto(`${serverContext.baseUrl}/thread?sourceFile=%2Fsynthetic%2Fassets.json&collection=pw_fixture`);
  await expect(page.locator('.rich-entity')).toHaveText('London');
  await expect(page.locator('.rich-citation-link')).toHaveAttribute('href', 'https://example.com/source');
  await expect(page.locator('.enhanced-markdown > p > code')).toHaveText(legacy);
  await expect(page.getByRole('button', { name: /^Load image/ })).toHaveCount(2);
  await expect(page.locator('.archived-image-attachments .archived-image')).toHaveCount(1);
  await expect(page.locator('.mermaid-block')).toHaveAttribute('data-mermaid-state', 'error');
  await expect(page.locator('.archived-image img[src]')).toHaveCount(0);
  await page.getByRole('button', { name: /^Load image/ }).first().click();
  await expect(page.locator('.archived-image-loaded img')).toHaveCount(1);
  expect(requests).toEqual([]);
});

test('long code, tables and rich layouts remain reachable on a narrow viewport', async ({ page, serverContext }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openSynthetic(page, serverContext.baseUrl, richText + '\n\n```text\n' + 'long-token-'.repeat(180) + '\n```\n\nTHE LAST PARAGRAPH');
  await page.getByRole('button', { name: 'Show more', exact: true }).click();
  await page.locator('.enhanced-markdown').getByText('THE LAST PARAGRAPH').scrollIntoViewIfNeeded();
  await expect(page.locator('.enhanced-markdown').getByText('THE LAST PARAGRAPH')).toBeInViewport();
  const bounds = await page.locator('.enhanced-markdown').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, right: node.getBoundingClientRect().right, viewport: innerWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
  const code = page.locator('pre.language-plaintext').last();
  const codeScroll = await code.evaluate(node => { node.scrollLeft = node.scrollWidth; return { offset: node.scrollLeft, scroll: node.scrollWidth, width: node.clientWidth }; });
  expect(codeScroll.offset).toBeGreaterThan(0);
});
