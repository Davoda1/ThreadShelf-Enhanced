import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { renderSafeHtml, safeHtmlAttribute, sanitizeInlineStyle, SAFE_HTML_TAGS } from '../client/src/enhanced-renderer/safe-html.js';

test('safe HTML expands inert formatting and reconstructs bounded attributes', () => {
  assert.equal(renderSafeHtml('<span style="color:#e64340;background-color:#a8c0ff">color</span>'), '<span style="color:#e64340;background-color:#a8c0ff">color</span>');
  assert.equal(renderSafeHtml('<MARK>Highlighted</MARK>'), '<mark>Highlighted</mark>');
  assert.equal(renderSafeHtml('<details open><summary>More</summary><small>Details</small></details>'), '<details open=""><summary>More</summary><small>Details</small></details>');
  assert.equal(renderSafeHtml('<abbr title="Hypertext Markup Language">HTML</abbr>'), '<abbr title="Hypertext Markup Language">HTML</abbr>');
  assert.equal(renderSafeHtml('<div lang="hu-HU" dir="ltr">árvíztűrő</div>'), '<div lang="hu-HU" dir="ltr">árvíztűrő</div>');
  assert.equal(renderSafeHtml('<ol start="3"><li value="7">Seven</li></ol>'), '<ol start="3"><li value="7">Seven</li></ol>');
  assert.equal(renderSafeHtml('<table><tr><th scope="col" colspan="2">Title</th></tr></table>'), '<table><tr><th scope="col" colspan="2">Title</th></tr></table>');
});

test('style grammar admits readable color/typography values without executing CSS', () => {
  for (const color of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'rebeccapurple', 'currentcolor', 'rgb(255, 0, 3)', 'rgba(10%, 0%, 100%, .5)', 'rgb(255 0 3 / 50%)', 'hsl(120, 100%, 50%)', 'hsla(120deg 100% 50% / 1)']) {
    assert.equal(sanitizeInlineStyle('color:' + color), 'color:' + color, color);
  }
  assert.equal(sanitizeInlineStyle(' COLOR: RED ; font-weight:700; text-decoration:underline line-through;'), 'color:red;font-weight:700;text-decoration:underline line-through');
  assert.equal(sanitizeInlineStyle('font-style:italic;text-align:center;vertical-align:super'), 'font-style:italic;text-align:center;vertical-align:super');
  assert.equal(sanitizeInlineStyle(''), '');
});

test('CSS bypasses, layout control and malformed values are rejected as a whole', () => {
  const unsafe = [
    'color:expression(alert(1))', 'color:var(--secret)', 'color:attr(title)',
    'background:url(https://unsafe.example/pixel)', 'background-color:url(https://unsafe.example/pixel)',
    'color:red;position:fixed', 'color:red;display:none', 'color:red;z-index:999999',
    'font-size:999999px', 'font-family:evil', 'color:red!important',
    'color:r\\65 d', 'color:r/**/ed', 'color:r&#101;d', 'color:red\n;position:fixed',
    '@import "https://unsafe.example/a"', '--x:red;color:var(--x)',
    'color:rgb(256, 0, 0)', 'color:rgb(-1 0 0)', 'color:rgba(0,0,0,1.1)',
    'color:hsl(200 101% 50%)', 'color:rgb(0,0,0 / 1)', 'color:rgb(0 0 0 /)',
    'color:#ab', 'color:unknowncolor', 'color:red;color:blue', 'color:red; broken',
  ];
  for (const style of unsafe) assert.equal(sanitizeInlineStyle(style), null, style);
  assert.equal(sanitizeInlineStyle('color:' + 'a'.repeat(1024)), null);
});

test('archived tags cannot acquire application classes, IDs, listeners or resource attributes', () => {
  const unsafe = [
    '<span class="code-action-button">', '<span id="threadOverlay">',
    '<span data-chatgpt-math-id="1">', '<span onclick="alert(1)">',
    '<div contenteditable>', '<div tabindex="0">', '<span aria-hidden="true">',
    '<span style="color:red" onpointerenter="alert(1)">',
    '<img src="https://unsafe.example/pixel">', '<iframe src="https://unsafe.example/">',
    '<script>', '<style>', '<svg onload="alert(1)">', '<math>', '<input>',
    '<form action="https://unsafe.example/">', '<object data="data:text/html,">',
  ];
  for (const raw of unsafe) {
    const result = renderSafeHtml(raw);
    assert.ok(result.startsWith('&lt;'), raw);
    assert.equal(result.includes('<'), false, raw);
  }
  assert.equal(SAFE_HTML_TAGS.has('input'), false);
});

test('links require explicit safe schemes and never carry credentials or active attributes', () => {
  const safe = 'https://example.com/search?a=1&b=2';
  assert.equal(renderSafeHtml(`<a href="${safe}">Source</a>`), '<a href="https://example.com/search?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Source</a>');
  assert.equal(safeHtmlAttribute('A', 'href', 'mailto:person@example.test'), 'mailto:person@example.test');
  assert.equal(safeHtmlAttribute('a', 'href', '#section-1'), '#section-1');
  for (const href of ['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'data:text/html,x', 'file:///home/tester', '/api/settings', '//example.com', 'https://user:pass@example.com', 'https://example.com/\n', 'https:\\example.com', 'https://']) {
    assert.equal(safeHtmlAttribute('a', 'href', href), null, href);
  }
  assert.equal(safeHtmlAttribute('a', 'target', '_top'), null);
  assert.ok(renderSafeHtml('<a href="https://example.com" ping="https://unsafe.example">').startsWith('&lt;'));
});

test('malformed and ambiguous HTML stays source without partial attribute recovery', () => {
  for (const raw of [
    '<span style="color:red"style="color:blue">', '<span style="color:red" style="color:blue">',
    '<span STYLE="color:red" style="color:blue">', '<span title="unterminated>',
    '<span/title=x>', '<span title=`x`>', '<span title="x"junk>', '<span/>',
    '</span style="color:red">', '</br>', '<span title="x><img src=x">',
  ]) {
    const result = renderSafeHtml(raw);
    assert.ok(result.startsWith('&lt;') || result === '<span title="x&gt;&lt;img src=x">', raw);
    assert.equal(result.includes('<img'), false);
  }
  assert.equal(renderSafeHtml('<br/><hr /><wbr>'), '<br><hr><wbr>');
  assert.equal(renderSafeHtml('<!-- <mark>not markup</mark> -->'), '&lt;!-- &lt;mark&gt;not markup&lt;/mark&gt; --&gt;');
  assert.equal(renderSafeHtml('<!DOCTYPE html>'), '&lt;!DOCTYPE html&gt;');
  assert.ok(renderSafeHtml('<span title="' + 'x'.repeat(9000) + '">').startsWith('&lt;'));
});

test('escaped entities remain text and never receive a second HTML parse', () => {
  assert.equal(renderSafeHtml('&lt;mark&gt;literal&lt;/mark&gt;'), '&lt;mark&gt;literal&lt;/mark&gt;');
  assert.equal(renderSafeHtml('A & B <mark>C &amp; D</mark>'), 'A &amp; B <mark>C &amp; D</mark>');
  assert.equal(renderSafeHtml('&#60;script&#62;alert(1)&#60;/script&#62;'), '&#60;script&#62;alert(1)&#60;/script&#62;');
});

test('numeric/metadata attributes stay bounded and cannot introduce behavior', () => {
  for (const [tag, name, value] of [
    ['td', 'colspan', '999999'], ['td', 'rowspan', '-1'], ['td', 'align', 'char'],
    ['ol', 'start', '1000001'], ['li', 'value', '1e6'], ['time', 'datetime', '<script>'],
    ['span', 'lang', 'x" onclick="x'], ['span', 'dir', 'rtl;display:none'],
    ['span', 'title', 'bad\nvalue'], ['details', 'open', 'false'],
  ]) assert.equal(safeHtmlAttribute(tag, name, value), null, `${tag} ${name}=${value}`);
});

test('HTML5 reparsing cannot turn rejected content into active or namespaced markup', () => {
  const sources = [
    '<span title="x><img src=https://unsafe.example/>">text</span>',
    '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
    '<svg><foreignObject><iframe src="https://unsafe.example/"></iframe></foreignObject></svg>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<textarea><img src=https://unsafe.example/ onerror=alert(1)></textarea>',
    '&lt;script&gt;alert(1)&lt;/script&gt;',
    '<div><details open><summary>Details</summary><mark>Safe</mark></details></div>',
    '<span style="color:red;background-color:#fff">safe</span>',
    '<a href="https://example.com/?one=1&two=2">safe</a>',
    '<span style="color:red&#59;position:fixed">bad</span>',
    '<table><tr><td><svg><style>@import "https://unsafe.example/x";</style></svg></td></tr></table>',
  ];
  function inspect(node) {
    if (node.tagName) {
      assert.equal(SAFE_HTML_TAGS.has(node.tagName), true, node.tagName);
      assert.equal(node.namespaceURI, 'http://www.w3.org/1999/xhtml');
      for (const attr of node.attrs) {
        if (node.tagName === 'a' && attr.name === 'target') assert.equal(attr.value, '_blank');
        else if (node.tagName === 'a' && attr.name === 'rel') assert.equal(attr.value, 'noopener noreferrer');
        else assert.notEqual(safeHtmlAttribute(node.tagName, attr.name, attr.value), null, attr.name);
      }
    }
    for (const child of node.childNodes || []) inspect(child);
  }
  for (const source of sources) inspect(parseFragment(renderSafeHtml(source)));
});
