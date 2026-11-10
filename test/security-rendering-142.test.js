// Independent adversarial checks for archived presentation input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { renderSafeHtml, sanitizeInlineStyle } from '../client/src/enhanced-renderer/safe-html.js';
import { referencesFor, createRichContextResolver } from '../client/src/enhanced-renderer/rich-context.js';
import { prepareRichMarkdown } from '../client/src/enhanced-renderer/rich-parser.js';
import { collectGrokCards, grokAt, grokImageUrls } from '../client/src/enhanced-renderer/grok-renderer.js';
import { createFileCitationExtension } from '../client/src/enhanced-renderer/file-citations.js';

function elements(html) {
  const found = [];
  function visit(node) {
    if (node.tagName) found.push(node);
    for (const child of node.childNodes || []) visit(child);
    if (node.content) visit(node.content);
  }
  visit(parseFragment(html));
  return found;
}

test('archived HTML cannot create active elements, resource attributes or event handlers', () => {
  const samples = [
    '<img src="https://tracker.example/x" onerror="alert(1)">',
    '<script>fetch("https://tracker.example/x")</script>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<object data="javascript:alert(1)"></object><embed src="https://tracker.example">',
    '<svg><foreignObject><iframe src="https://tracker.example"></iframe></foreignObject></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
    '<span title="&quot; onmouseover=&quot;alert(1)">safe text</span>',
    '<a href="jav&#x61;script:alert(1)">unsafe</a>',
    '<a href="https://user:pass@example.test">credentials</a>',
    '<details ontoggle="alert(1)" open><summary>saved</summary></details>',
    '<div class="archived-image-source" data-image-url="https://tracker.example">forged</div>',
    '<span id="__proto__" name="constructor">clobber</span>',
    '<base href="https://tracker.example/"><link rel="stylesheet" href="https://tracker.example/x">',
  ];
  const forbiddenTags = /^(?:script|iframe|object|embed|img|svg|math|link|style|base|form|input|button)$/;
  for (const sample of samples) {
    for (const node of elements(renderSafeHtml(sample))) {
      assert.equal(forbiddenTags.test(node.tagName), false, sample);
      for (const attr of node.attrs) {
        assert.equal(/^(?:on|src|srcdoc|data-|id$|name$)/.test(attr.name), false, sample);
        if (attr.name === 'href') assert.match(attr.value, /^(?:https?:\/\/|mailto:|#)/);
      }
    }
  }
});

test('safe HTML style grammar rejects fetching, overlays, escapes and executable CSS', () => {
  for (const style of [
    'background:url(https://tracker.example)',
    'background-color:url(https://tracker.example)',
    'color:expression(alert(1))',
    'color:v\\61r(--x)',
    'color:var(--secret)',
    'color:red!important',
    'color:red;position:fixed;inset:0',
    'color:red;display:none',
    'color:red;opacity:0',
    'color:red;behavior:url(x.htc)',
    'color:red;--x:url(https://tracker.example)',
    'color:red/**/;font-weight:bold',
    'color:red\u0000',
    'color:&#114;ed',
    'color:rgb(1,2,url(https://tracker.example))',
  ]) assert.equal(sanitizeInlineStyle(style), null, style);
  assert.equal(sanitizeInlineStyle('color:#e64340;background-color:#a8c0ff'), 'color:#e64340;background-color:#a8c0ff');
});

test('entity-escaped and declaration/comment HTML is never decoded into executable markup', () => {
  for (const input of [
    '&lt;img src=x onerror=alert(1)&gt;',
    '&#60;script&#62;alert(1)&#60;/script&#62;',
    '<!-- <img src=x onerror=alert(1)> -->',
    '<!DOCTYPE html [<!ENTITY x SYSTEM "https://tracker.example">]>',
    '<?xml-stylesheet href="https://tracker.example"?>',
  ]) assert.equal(elements(renderSafeHtml(input)).length, 0, input);
});

test('ChatGPT citation arrays cannot execute getters or custom iterators', () => {
  const item = { type: 'webpage', ref_id: 'saved', url: 'https://example.test/source' };
  for (const location of ['records', 'items', 'refs']) {
    let executions = 0;
    const array = [];
    Object.defineProperty(array, '0', { get() { executions++; return location === 'refs' ? 'saved' : item; } });
    array.length = 1;
    let records;
    if (location === 'records') records = array;
    else if (location === 'items') records = [{ type: 'grouped_webpages', items: array }];
    else records = [{ type: 'webpage', url: item.url, refs: array }];
    const refs = referencesFor({ metadata: { content_references: records } }).references;
    assert.equal(executions, 0, location);
    assert.equal(Object.hasOwn(refs, 'saved'), false, location);
  }
  let iterations = 0;
  const records = [];
  records[Symbol.iterator] = function* () { iterations++; yield item; };
  const refs = referencesFor({ metadata: { content_references: records } }).references;
  assert.equal(iterations, 0);
  assert.equal(Object.hasOwn(refs, 'saved'), false);
});

test('citation identity mismatch and duplicates cannot borrow a different message source', () => {
  const metadata = url => ({ content_references: [{ type: 'webpage', ref_id: 'same', url }] });
  const resolve = createRichContextResolver({ raw: { mapping: {
    a: { message: { id: 'one', metadata: metadata('https://example.test/a') } },
    b: { message: { id: 'two', metadata: metadata('https://example.test/b') } },
    c: { message: { id: 'duplicate', metadata: metadata('https://example.test/c') } },
    d: { message: { id: 'duplicate', metadata: metadata('https://example.test/d') } },
  } } });
  assert.equal(resolve({ source_message_id: 'one', source_node_id: 'a' }).references.same.url, 'https://example.test/a');
  for (const turn of [{ source_message_id: 'one', source_node_id: 'b' }, { source_message_id: 'duplicate' }, {}, { source_message_id: 'missing' }]) {
    assert.equal(Object.keys(resolve(turn).references).length, 0);
  }
});

test('Grok media eligibility excludes unsafe URLs and non-image families', () => {
  const image = grokAt('<grok:render card_id="image" card_type="image_card" />').node;
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///private.png', '//example.test/a.png', 'https://user:pass@example.test/a.png', 'https://example.test/\u0000a', 'https:\\example.test/a']) {
    const context = { grokCards: collectGrokCards({ cardAttachment: [{ id: 'image', url }] }) };
    assert.deepEqual(grokImageUrls(image, context), [], url);
  }
  const context = { grokCards: collectGrokCards({ cardAttachment: [{ id: 'image', url: 'https://example.test/a.png' }] }) };
  assert.deepEqual(grokImageUrls(image, context), ['https://example.test/a.png']);
  for (const family of ['citation_card', 'ui_card', 'artifact', 'unknown', 'generated_audio_card']) {
    assert.deepEqual(grokImageUrls({ ...image, family }, context), [], family);
  }
  assert.deepEqual(grokImageUrls({ ...image, incomplete: true }, context), []);
  assert.deepEqual(grokImageUrls({ ...image, malformed: true }, context), []);
});

test('file-reference chip markup cannot gain navigation or activation through its filename', () => {
  const extension = createFileCitationExtension();
  for (const filename of ['<img src=x onerror=alert(1)>.svg', '" onclick="alert(1).html', 'javascript:alert(1).js', 'report.pdf']) {
    const nodes = elements(extension.renderer({ filename }));
    assert.ok(nodes.length > 0);
    for (const node of nodes) {
      assert.equal(node.tagName, 'span');
      for (const attr of node.attrs) assert.equal(/^(?:href|src|on|tabindex)/.test(attr.name), false);
    }
  }
});

test('provider markers inside raw HTML code and Markdown code remain literal', () => {
  const grok = '<grok:render card_type="citation_card" card_id="saved" />';
  const chatgpt = 'citeturn0search0';
  for (const marker of [grok, chatgpt]) {
    for (const source of ['<pre><code>' + marker + '</code></pre>', '<code>' + marker + '</code>', '```xml\n' + marker + '\n```', '`' + marker + '`']) {
      assert.equal(prepareRichMarkdown(source).records.size, 0, source);
    }
  }
});
