import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  collLabel,
  shortPath,
  fmtModel,
  compactModel,
  compactPath,
  fmtTime,
  fmtDate,
  escapeRegex,
  queryHighlightRegex,
  splitHighlightedText,
  isPotentialExport,
  buildThreadMarkdown,
  slugify,
  moreLikeThisQuery,
  appendStableStreamChunk,
} from '../client/src/utils.ts';
import { getProvider } from '../client/src/constants.ts';

describe('collLabel', () => {
  it('maps pseudo collections to friendly labels', () => {
    assert.strictEqual(collLabel('all'), 'All collections');
    assert.strictEqual(collLabel('__all__'), 'All collections');
    assert.strictEqual(collLabel('chunks'), 'Chunks');
  });

  it('passes through ordinary collection names', () => {
    assert.strictEqual(collLabel('work_2026'), 'work_2026');
  });
});

describe('shortPath', () => {
  it('keeps the last two path segments', () => {
    assert.strictEqual(shortPath('/a/b/c/d.json'), 'c/d.json');
  });

  it('normalizes backslashes', () => {
    assert.strictEqual(shortPath('C:\\users\\me\\export.json'), 'me/export.json');
  });

  it('returns short paths unchanged and handles empty input', () => {
    assert.strictEqual(shortPath('only.json'), 'only.json');
    assert.strictEqual(shortPath(''), '');
  });
});

describe('fmtModel', () => {
  it('strips the models/ prefix', () => {
    assert.strictEqual(fmtModel('models/gemini-test'), 'gemini-test');
  });

  it('leaves other models untouched and handles undefined', () => {
    assert.strictEqual(fmtModel('claude-test'), 'claude-test');
    assert.strictEqual(fmtModel(undefined), '');
  });
});

describe('appendStableStreamChunk', () => {
  it('freezes completed blocks and only extends the final block', () => {
    const first = appendStableStreamChunk([], 'abcdefghij', 4);
    assert.deepStrictEqual(first, ['abcd', 'efgh', 'ij']);

    const second = appendStableStreamChunk(first, 'klmnop', 4);
    assert.deepStrictEqual(second, ['abcd', 'efgh', 'ijkl', 'mnop']);
    assert.deepStrictEqual(first, ['abcd', 'efgh', 'ij']);
  });

  it('handles empty deltas and invalid block sizes safely', () => {
    assert.deepStrictEqual(appendStableStreamChunk(['kept'], '', 4), ['kept']);
    assert.deepStrictEqual(appendStableStreamChunk([], 'abc', 0), ['a', 'b', 'c']);
  });
});

describe('complete path and model labels', () => {
  it('keeps full Windows and POSIX paths for the wrapping UI', () => {
    for (const path of [
      'C:\\Users\\synthetic-user\\models\\Bielik\\Bielik-11B-v3.0-Instruct.Q4_K_M.gguf',
      '/synthetic/models/Bielik/Bielik-11B-v3.0-Instruct.Q4_K_M.gguf',
    ])
      assert.equal(compactPath(path), path);
  });

  it('keeps full portable GGUF names and remote provider namespaces', () => {
    assert.equal(
      compactModel('C:\\models\\Bielik-11B-v3.0-Instruct.Q4_K_M.gguf'),
      'Bielik-11B-v3.0-Instruct.Q4_K_M',
    );
    assert.equal(
      compactModel('synthetic-provider/FullModelName_With_Quantization_Q4_K_M'),
      'synthetic-provider/FullModelName_With_Quantization_Q4_K_M',
    );
  });
});

describe('fmtTime', () => {
  it('formats sub-minute durations in seconds', () => {
    assert.strictEqual(fmtTime(5000), '5s');
    assert.strictEqual(fmtTime(59_000), '59s');
  });

  it('formats minute+ durations as "Xm Ys"', () => {
    assert.strictEqual(fmtTime(60_000), '1m 0s');
    assert.strictEqual(fmtTime(125_000), '2m 5s');
  });
});

describe('fmtDate', () => {
  it('returns empty string for missing or invalid input', () => {
    assert.strictEqual(fmtDate(undefined), '');
    assert.strictEqual(fmtDate('not-a-date'), '');
  });

  it('formats a valid ISO date to a non-empty string', () => {
    assert.ok(fmtDate('2026-02-02T02:40:00.000Z').length > 0);
  });
});

describe('escapeRegex', () => {
  it('escapes regex metacharacters so the result matches literally', () => {
    const input = 'a.b*c+(d)';
    const escaped = escapeRegex(input);
    assert.ok(new RegExp(escaped).test(input));
    assert.strictEqual(escaped, 'a\\.b\\*c\\+\\(d\\)');
  });
});

describe('query highlighting helpers', () => {
  it('highlights individual meaningful query terms instead of requiring the full phrase', () => {
    const regex = queryHighlightRegex('semantic chromatography workflow');
    assert.ok(regex);
    assert.strictEqual(regex.test('Chromatography'), true);
    assert.strictEqual(regex.test('unrelated'), false);
  });

  it('splits text around multiple query terms and ignores very short words', () => {
    assert.deepStrictEqual(splitHighlightedText('alpha beta gamma', 'a beta gamma'), [
      'alpha ',
      'beta',
      ' ',
      'gamma',
    ]);
  });

  it('falls back to the whole phrase when every word is shorter than 3 chars', () => {
    const regex = queryHighlightRegex('AI');
    assert.ok(regex);
    assert.strictEqual(regex.test('ai'), true);
    assert.strictEqual(regex.test('air'), true);
    assert.strictEqual(regex.test('bot'), false);
    assert.strictEqual(queryHighlightRegex('   '), null);
  });
});

describe('provider metadata', () => {
  it('brands LM Studio and Grok instead of falling back to unknown', () => {
    assert.strictEqual(getProvider('lm-studio').short, 'LM Studio');
    assert.strictEqual(getProvider('grok').short, 'Grok');
    assert.notStrictEqual(getProvider('lm-studio').color, 'var(--border-2)');
    assert.notStrictEqual(getProvider('grok').color, 'var(--border-2)');
  });
});

describe('isPotentialExport', () => {
  it('accepts json files and extensionless names', () => {
    assert.strictEqual(isPotentialExport('export.json'), true);
    assert.strictEqual(isPotentialExport('/some/dir/conversation'), true);
  });

  it('rejects known non-export json names', () => {
    assert.strictEqual(isPotentialExport('users.json'), false);
    assert.strictEqual(isPotentialExport('shared_conversations.json'), false);
  });

  it('rejects empty input and provider asset files like file-xxxx.png', () => {
    assert.strictEqual(isPotentialExport(''), false);
    assert.strictEqual(isPotentialExport('file-abc123.png'), false);
  });
});

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    assert.strictEqual(slugify('Hello, World!'), 'hello-world');
  });

  it('trims leading/trailing dashes and caps length', () => {
    assert.strictEqual(slugify('  --Edge--  '), 'edge');
    assert.ok(slugify('a'.repeat(200)).length <= 60);
  });

  it('falls back to "conversation" for empty / symbol-only titles', () => {
    assert.strictEqual(slugify(''), 'conversation');
    assert.strictEqual(slugify('---'), 'conversation');
    assert.strictEqual(slugify('世界'), 'conversation');
  });
});

describe('buildThreadMarkdown', () => {
  const turns = [
    { user: 'What is a unit test?' },
    { thinking: 'Break down the question.', model: 'models/gemini-test' },
    { ai: 'A unit test checks one function in isolation.', model: 'models/gemini-test' },
  ];

  it('renders a title heading and role headings with emoji', () => {
    const md = buildThreadMarkdown('My Thread', turns);
    assert.match(md, /^# My Thread/);
    assert.ok(md.includes('### 🧑 User'));
    assert.ok(md.includes('### 💭 Reasoning'));
    assert.ok(md.includes('### 🤖 Response'));
  });

  it('includes turn text content', () => {
    const md = buildThreadMarkdown('T', turns);
    assert.ok(md.includes('What is a unit test?'));
    assert.ok(md.includes('A unit test checks one function in isolation.'));
  });

  it('renders a meta line when meta is provided', () => {
    const md = buildThreadMarkdown('T', turns, {
      model: 'models/gemini-test',
      sourceFile: 'chat.json',
      collection: 'work',
    });
    assert.ok(md.includes('**Model:** gemini-test'));
    assert.ok(md.includes('**Turns:** 3'));
    assert.ok(md.includes('**Collection:** work'));
    assert.ok(md.includes('**Source:** `chat.json`'));
    assert.ok(md.includes('---'));
  });

  it('falls back to "Conversation" for an empty title', () => {
    assert.match(buildThreadMarkdown('', turns), /^# Conversation/);
  });

  it('always ends with a single trailing newline and no 3+ blank runs', () => {
    const md = buildThreadMarkdown('T', turns);
    assert.ok(md.endsWith('\n'));
    assert.ok(!md.endsWith('\n\n'));
    assert.ok(!/\n{3,}/.test(md));
  });

  it('handles an empty turn list without throwing', () => {
    const md = buildThreadMarkdown('Empty', []);
    assert.match(md, /^# Empty/);
    assert.ok(md.endsWith('\n'));
  });
});

describe('moreLikeThisQuery', () => {
  it('collapses whitespace and trims', () => {
    assert.strictEqual(moreLikeThisQuery('  hello\n\tworld  '), 'hello world');
  });

  it('returns short text unchanged', () => {
    assert.strictEqual(moreLikeThisQuery('short text'), 'short text');
  });

  it('truncates long text at a word boundary within the limit', () => {
    const text = Array(100).fill('lorem ipsum dolor').join(' ');
    const q = moreLikeThisQuery(text);
    assert.ok(q.length <= 280);
    assert.ok(!q.endsWith(' '));
    // Must cut between words, not through one.
    assert.ok(text.startsWith(q));
    assert.strictEqual(text[q.length], ' ');
  });

  it('hard-cuts when there is no usable word boundary', () => {
    const q = moreLikeThisQuery('x'.repeat(1000));
    assert.strictEqual(q.length, 280);
  });

  it('returns empty string for whitespace-only input', () => {
    assert.strictEqual(moreLikeThisQuery('   \n  '), '');
  });
});
