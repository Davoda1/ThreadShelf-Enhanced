import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatJsonResponse,
  isEmptyThoughtsResponse,
  jsonResponseMarkdown,
  shouldHideJsonResponse,
} from '../client/src/json-response.js';

const thoughts = (entries) =>
  JSON.stringify({
    content_type: 'thoughts',
    source_analysis_msg_id: 'synthetic-source',
    thoughts: entries,
  });
const emptyThought = { chunks: [], content: '', finished: true, summary: 'Searched the web' };

test('JSON formatting preserves duplicate members, exact number spelling and string escapes', () => {
  const source = '{"id":9007199254740993123456789,"id":1e+007,"zero":-0,"text":"a\\nb","ok":false}';
  const formatted = formatJsonResponse(source, 'ai');
  assert.equal(
    formatted,
    '{\n  "id": 9007199254740993123456789,\n  "id": 1e+007,\n  "zero": -0,\n  "text": "a\\nb",\n  "ok": false\n}',
  );
  assert.equal(
    source,
    '{"id":9007199254740993123456789,"id":1e+007,"zero":-0,"text":"a\\nb","ok":false}',
  );
});

test('only JSON-shaped AI envelopes are converted, with conservative display repairs', () => {
  assert.equal(formatJsonResponse('{"value":0,}', 'assistant'), '{\n  "value": 0\n}');
  assert.equal(formatJsonResponse('{"line":"one\ntwo"}', 'ai'), '{\n  "line": "one\\ntwo"\n}');
  assert.equal(formatJsonResponse('{"value":', 'ai'), '{"value":');
  for (const source of [
    'A note {"value":1}',
    '{"value":1}\nA note',
    '[link](https://example.test)',
    '![image](saved.png)',
    '```json\n{"value":1}\n```',
    '    {"value":1}',
    '\t{"value":1}',
    'A prose response.',
    '',
  ])
    assert.equal(formatJsonResponse(source, 'ai'), null, source);
  for (const role of ['user', 'system', 'tool'])
    assert.equal(formatJsonResponse('{"value":1}', role), null);
  assert.equal(formatJsonResponse('{"value":1}', 'thinking'), '{\n  "value": 1\n}');
  assert.equal(formatJsonResponse('[]', 'ai'), '[]');
  assert.equal(formatJsonResponse('{}', 'ai'), '{}');
});

test('Hide empty follows known empty Reader export metadata and keeps useful/unknown data', () => {
  for (const source of [
    thoughts([]),
    thoughts([emptyThought]),
    thoughts([{ ...emptyThought, content: ' \n\t' }]),
  ]) {
    assert.equal(isEmptyThoughtsResponse(source, 'ai'), true);
    assert.equal(shouldHideJsonResponse(source, 'ai', 'hide-empty'), true);
    assert.equal(shouldHideJsonResponse(source, 'ai', 'show-all'), false);
    assert.equal(shouldHideJsonResponse(source, 'user', 'hide-empty'), false);
  }
  for (const source of [
    '{}',
    '[]',
    '{"results":[]}',
    '{"count":0}',
    '{"success":false}',
    '{"error":"No results"}',
    thoughts([{ ...emptyThought, content: 'Useful explanation' }]),
    thoughts([{ ...emptyThought, chunks: [{ text: 'Useful chunk' }] }]),
    thoughts([{ ...emptyThought, future_field: '' }]),
    thoughts([{ ...emptyThought, chunks: null }]),
    thoughts([null]),
    '{"content_type":"thoughts","thoughts":[]}',
    '{"content_type":"thoughts","source_analysis_msg_id":"synthetic","thoughts":[],"error":false}',
    thoughts([]).slice(0, -1),
    '```json\n' + thoughts([]) + '\n```',
  ])
    assert.equal(shouldHideJsonResponse(source, 'ai', 'hide-empty'), false, source);
});

test('ambiguous duplicate or escaped-equivalent keys cannot silently hide earlier content', () => {
  for (const source of [
    '{"content_type":"thoughts","source_analysis_msg_id":"synthetic","thoughts":[{"content":"keep"}],"thoughts":[]}',
    '{"content_type":"thoughts","source_analysis_msg_id":"synthetic","thoughts":[{"content":"keep","content":""}]}',
    '{"content_type":"thoughts","source_analysis_msg_id":"synthetic","thoughts":[{"content":"keep","c\\u006fntent":""}]}',
    '{"content_type":"thoughts","source_analysis_msg_id":"synthetic","thoughts":[],"thou\\u0067hts":[]}',
  ]) {
    assert.equal(shouldHideJsonResponse(source, 'ai', 'hide-empty'), false);
    assert.equal(shouldHideJsonResponse(source, 'ai', 'hide-all'), true);
  }
  assert.equal(
    isEmptyThoughtsResponse(
      thoughts([{ ...emptyThought, summary: 'A quoted \\" key: { and [ is harmless.' }]),
      'ai',
    ),
    true,
  );
});

test('visibility policy is independent of code presentation and does not mutate source indexes', () => {
  const turns = [
    { user: 'A prompt' },
    { ai: thoughts([]) },
    { ai: '{"count":0}' },
    { ai: 'Useful prose' },
  ];
  const before = JSON.stringify(turns);
  const visibleIndexes = (policy) =>
    turns.flatMap((turn, index) =>
      shouldHideJsonResponse(turn.ai ?? turn.user, turn.ai === undefined ? 'user' : 'ai', policy)
        ? []
        : [index],
    );
  assert.deepEqual(visibleIndexes('show-all'), [0, 1, 2, 3]);
  assert.deepEqual(visibleIndexes('hide-empty'), [0, 2, 3]);
  assert.deepEqual(visibleIndexes('hide-all'), [0, 3]);
  assert.equal(JSON.stringify(turns), before);
});

test('formatting bounds avoid speculative content and cannot close a generated code fence', () => {
  const source = '{"code":"```json\\ntext\\n```"}';
  const fenced = jsonResponseMarkdown(source, 'ai');
  assert.ok(fenced.startsWith('````json\n'));
  assert.ok(fenced.endsWith('\n````'));
  const large = '{"value":"' + 'x'.repeat(1024 * 1024) + '"}';
  assert.equal(formatJsonResponse(large, 'ai'), null);
  assert.equal(shouldHideJsonResponse(large, 'ai', 'hide-all'), false);
  const deep = '['.repeat(80) + '0' + ']'.repeat(80);
  assert.equal(formatJsonResponse(deep, 'ai'), deep);
  assert.equal(jsonResponseMarkdown('ordinary prose', 'ai'), null);
});
