import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRichMarkdown, parseRichSpan } from '../client/src/enhanced-renderer/rich-parser.js';
import { referencesFor } from '../client/src/enhanced-renderer/rich-context.js';
import { normalizeChart } from '../client/src/enhanced-renderer/rich-charts.js';
import { buildMermaidRepairCandidates } from '../client/src/enhanced-renderer/mermaid-repair.js';
import { safeImageUrl } from '../client/src/enhanced-renderer/images.js';

const chart = { chartType: 'bar', xKey: 'name', series: [{ dataKey: 'value', label: 'Value' }], data: [{ name: 'A', value: 0 }, { name: 'B', value: -3 }] };

test('rich parser recognizes bounded layouts while code fences remain literal', () => {
  const source = '<row gap={2}><AsyncImage query="landscape" width="160px" /><text>**Caption**</text></row>';
  const parsed = prepareRichMarkdown(source);
  assert.equal(parsed.records.size, 1);
  const node = [...parsed.records.values()][0];
  assert.equal(node.tag, 'row');
  assert.equal(node.children[0].tag, 'AsyncImage');
  assert.equal(prepareRichMarkdown('```html\n' + source + '\n```').records.size, 0);
  assert.equal(source, '<row gap={2}><AsyncImage query="landscape" width="160px" /><text>**Caption**</text></row>');
});

test('executable rich attributes and prototype properties cannot become rendered components', () => {
  assert.throws(() => parseRichSpan('<text onClick={alert(1)}>bad</text>'));
  assert.throws(() => parseRichSpan('<box padding={999999}><text>bad</text></box>'));
  assert.throws(() => parseRichSpan('<AsyncImage src="javascript:alert(1)" />'));
  const unsafe = prepareRichMarkdown('<box onClick={alert(1)}><text>literal</text></box>');
  assert.equal([...unsafe.records.values()].some(node => node.kind === 'component'), false);
});

test('citation context is scoped, URL validated and conflicting identifiers stay unresolved', () => {
  const ref = { turn_index: 0, ref_index: 2, ref_type: 'search' };
  const metadata = { content_references: [{ type: 'grouped_webpages', items: [{ url: 'https://example.com/source', title: 'Source', refs: [ref] }] }] };
  const original = JSON.stringify(metadata);
  assert.equal(referencesFor({ metadata }).references.turn0search2.url, 'https://example.com/source');
  metadata.content_references[0].items.push({ url: 'https://example.com/other', refs: [ref] });
  assert.equal(referencesFor({ metadata }).references.turn0search2, undefined);
  assert.equal(referencesFor({ metadata: {} }).references.turn0search2, undefined);
  assert.equal(original, JSON.stringify({ content_references: [{ type: 'grouped_webpages', items: [{ url: 'https://example.com/source', title: 'Source', refs: [ref] }] }] }));
});

test('chart adapter preserves zero, negative and exact decimal values without mutation', () => {
  const before = JSON.stringify(chart);
  const result = normalizeChart(chart);
  assert.equal(result.ok, true);
  assert.deepEqual(result.chart.series[0].values, [0, -3]);
  assert.equal(JSON.stringify(chart), before);
});

test('Mermaid repairs are deterministic alternate display sources', () => {
  const source = 'graph TD\nA[Result (draft)] --> B[Done]';
  assert.deepEqual(buildMermaidRepairCandidates(source), buildMermaidRepairCandidates(source));
  assert.ok(buildMermaidRepairCandidates(source).some(candidate => candidate !== source));
  assert.equal(source, 'graph TD\nA[Result (draft)] --> B[Done]');
});

test('image loading accepts only explicit safe URLs, never local files or executable payloads', () => {
  for (const unsafe of ['javascript:alert(1)', 'file:///home/example/private.png', 'sandbox:/tmp/pic.png', '//tracker.test/x', 'https://user:pass@example.com/x', 'data:image/svg+xml,<svg/>', 'cute cats']) assert.equal(safeImageUrl(unsafe), null);
  for (const safe of ['https://example.com/picture.png', '/images/saved.png', 'data:image/png;base64,aGVsbG8=']) assert.equal(safeImageUrl(safe), safe);
});

test('Processor legacy markers become data-only display nodes and stay literal inside code', () => {
  const source = 'entity["city","London","United Kingdom"] citeturn0search2';
  const rich = prepareRichMarkdown(source);
  assert.deepEqual([...rich.records.values()].map(node => node.tag), ['Entity', 'Cite']);
  assert.equal([...rich.records.values()][0].attrs.value, 'London');
  assert.equal(prepareRichMarkdown('`' + source + '`').records.size, 0);
  const hostile = prepareRichMarkdown('entity["x","<script>alert(1)</script>"]');
  assert.equal([...hostile.records.values()][0].attrs.value, '<script>alert(1)</script>');
});
