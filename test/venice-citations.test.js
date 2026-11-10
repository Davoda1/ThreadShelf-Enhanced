import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { createVeniceCitationExtension } from '../client/src/enhanced-renderer/venice-citations.js';

const marked = new Marked(createVeniceCitationExtension());
test('Venice decimal markers render as inert labels, including adjacent and repeated citations', () => {
  const rendered = marked.parse('Read.^1^ Sources.^2^^12^ Repeat.^1^ Zero.^0^');
  assert.equal((rendered.match(/class="venice-citation"/g) || []).length, 5);
  assert.match(rendered, />12<\/span>/);
  assert.doesNotMatch(rendered, /<(?:a|button)\b/);
});
test('Venice code, escaped markers and malformed values remain source', () => {
  for (const source of ['`^1^`', '```text\n^1^\n```', '\\^1\\^', '^word^', '^-1^', '^1.5^', '^1234567890123^', '^ 1 ^', '<code>^1^</code>', '<pre>^1^</pre>']) {
    assert.doesNotMatch(marked.parse(source), /class="venice-citation"/, source);
  }
});
test('Venice markup cannot consume arbitrary payloads or change link destinations', () => {
  assert.doesNotMatch(marked.parse('^[<script>alert(1)</script>]^'), /class="venice-citation"/);
  const linked = marked.parse('[source](https://example.test/^1^)');
  assert.match(linked, /href="https:\/\/example.test\/%5E1%5E"/);
  assert.doesNotMatch(linked, /class="venice-citation"/);
});
