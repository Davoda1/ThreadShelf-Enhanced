/* global document, innerWidth, innerHeight, getComputedStyle, RendererLabels */
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let javascript;
let css;
test.beforeAll(async () => {
  const output = await build({
    stdin: { contents: "export { renderChart } from './client/src/enhanced-renderer/rich-charts.js'; export { renderRichNode } from './client/src/enhanced-renderer/rich-renderer.js';", resolveDir: root },
    bundle: true, format: 'iife', platform: 'browser', globalName: 'RendererLabels', write: false,
  });
  javascript = output.outputFiles[0].text;
  css = (await Promise.all(['rich-layout.css', 'rich-charts.css'].map(name => readFile(new URL(`../../client/src/enhanced-renderer/${name}`, import.meta.url), 'utf8')))).join('\n');
});

async function prepare(page, width, height = 640) {
  await page.setViewportSize({ width, height });
  await page.setContent('<!doctype html><html><body><main class="message-content"></main><button id="outside">Outside</button></body></html>');
  await page.addStyleTag({ content: 'body{margin:16px;font:16px/1.5 sans-serif}main{max-width:900px;min-width:0}.rich-chart{margin:0}button{margin-top:20px}' + css });
  await page.addScriptTag({ content: javascript });
}

async function labelBounds(locator) {
  return locator.evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight, left: box.left, right: box.right, lineHeight: parseFloat(style.lineHeight), clamp: style.webkitLineClamp, overflow: style.overflow };
  }));
}

for (const width of [320, 1280]) {
  test(`citation labels wrap without ellipsis at ${width}px`, async ({ page }) => {
    await prepare(page, width);
    const host = `${'archived-source-'.repeat(4)}.${'personal-reference-'.repeat(3)}.example.test`;
    const filename = `archived-conversation-${'long-personal-filename-'.repeat(12)}.json`;
    const missing = 'A mentett forrás jelenleg nem érhető el ebben az archívumban';
    await page.evaluate(({ host, filename, missing }) => {
      const options = { document, t: () => missing, context: { references: { source: { url: `https://${host}/source`, title: filename } } } };
      const main = document.querySelector('main');
      for (const ref of ['source', 'missing']) {
        const p = document.createElement('p');
        p.append(RendererLabels.renderRichNode({ kind: 'component', tag: 'Cite', attrs: { ref } }, options));
        main.append(p);
      }
    }, { host, filename, missing });
    await expect(page.locator('.rich-citation-link')).toHaveText(host);
    await expect(page.locator('.rich-citation-link')).toHaveAccessibleName(`${filename} (source)`);
    await expect(page.locator('.rich-citation-unresolved')).toHaveText(missing);
    for (const box of await labelBounds(page.locator('.rich-citation-link,.rich-citation-unresolved'))) {
      expect(box.scrollWidth).toBeLessThanOrEqual(box.width + 1);
      expect(box.scrollHeight).toBeLessThanOrEqual(box.height + 1);
      expect(box.height).toBeGreaterThan(box.lineHeight * 2);
      expect(box.right).toBeLessThanOrEqual(width);
    }
  });

  test(`long chart tooltip labels remain readable and keyboard scrollable at ${width}px`, async ({ page }) => {
    await prepare(page, width, 480);
    const heading = 'A fully retained archived category with a long filename '.repeat(30) + 'heading-end';
    const label = 'Összesített megőrzött adatsor részletes megnevezése '.repeat(60) + 'label-end';
    const suffix = 'unbroken-saved-unit-'.repeat(100) + 'value-end';
    await page.evaluate(({ heading, label, suffix }) => {
      document.querySelector('main').append(RendererLabels.renderChart({ chartType: 'bar', xKey: 'name', series: [{ dataKey: 'value', label, valueSuffix: suffix }], data: [{ name: heading, value: 42 }] }, { document }));
    }, { heading, label, suffix });
    const target = page.locator('.rich-chart-hit[data-chart-item]').first();
    await target.focus();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('.rich-chart-tooltip-heading')).toHaveText(heading);
    await expect(tooltip.locator('.rich-chart-tooltip-label')).toHaveText(label);
    await expect(tooltip.locator('.rich-chart-tooltip-value')).toContainText(suffix);
    for (const box of await labelBounds(tooltip.locator('.rich-chart-tooltip-heading,.rich-chart-tooltip-label,.rich-chart-tooltip-value'))) {
      expect(box.clamp).toBe('none');
      expect(box.scrollWidth).toBeLessThanOrEqual(box.width + 1);
      expect(box.scrollHeight).toBeLessThanOrEqual(box.height + 1);
    }
    const bounds = await tooltip.evaluate(node => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, scroll: node.scrollHeight, client: node.clientHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(7);
    expect(bounds.right).toBeLessThanOrEqual(bounds.width - 7);
    expect(bounds.top).toBeGreaterThanOrEqual(7);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height - 7);
    expect(bounds.scroll).toBeGreaterThan(bounds.client);
    await page.keyboard.press('Tab');
    await expect(tooltip).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => tooltip.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
    const endVisible = await tooltip.evaluate(panel => {
      const boxes = [...panel.querySelectorAll('.rich-chart-tooltip-label,.rich-chart-tooltip-value')].map(node => {
        const range = document.createRange(); range.setStart(node.firstChild, node.textContent.length - 9); range.setEnd(node.firstChild, node.textContent.length);
        return range.getBoundingClientRect();
      });
      const r = boxes.sort((a, b) => b.bottom - a.bottom)[0], outer = panel.getBoundingClientRect();
      return r.bottom <= outer.bottom && r.top >= outer.top;
    });
    expect(endVisible).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(target).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(tooltip).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await expect(target).toBeFocused();
    await page.locator('#outside').focus();
    await target.focus();
    await expect(tooltip).toBeVisible();
    const rect = await tooltip.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 40);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => tooltip.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await expect(tooltip).toBeVisible();
    await page.locator('#outside').focus();
    await expect(tooltip).toHaveCount(0);
    await target.scrollIntoViewIfNeeded();
    const targetBox = await target.boundingBox();
    await page.mouse.move(Math.min(width - 20, targetBox.x + targetBox.width / 2), targetBox.y + targetBox.height / 2);
    await expect(tooltip).toBeVisible();
    await tooltip.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => tooltip.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await page.mouse.click(1, 1);
    await expect(tooltip).toHaveCount(0);
  });
}
