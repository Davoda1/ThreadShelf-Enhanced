import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LOCALES, normalizeLocale, translate, countLabel } from '../client/src/i18n/core.ts';
import { translations } from '../client/src/i18n/translations.ts';
import { useUIStore } from '../client/src/store.ts';
import { fmtDate, fmtRelative, collLabel } from '../client/src/utils.ts';

const placeholders = (value) =>
  [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();

test('all application catalog entries provide every supported locale and preserve interpolation fields', () => {
  assert.ok(Object.keys(translations).length > 700);
  for (const [source, localized] of Object.entries(translations)) {
    for (const locale of LOCALES.filter((item) => item !== 'en')) {
      assert.equal(typeof localized[locale], 'string', `${locale}: ${source}`);
      assert.ok(localized[locale].trim(), `${locale}: ${source}`);
      assert.deepEqual(
        placeholders(localized[locale]),
        placeholders(source),
        `${locale}: ${source}`,
      );
    }
  }
});

test('English is the default and unknown strings and interpolation values retain their exact text', () => {
  assert.equal(normalizeLocale(undefined), 'en');
  assert.equal(normalizeLocale('unsupported'), 'en');
  assert.equal(translate('A future application message', 'hu'), 'A future application message');
  assert.equal(translate('  Settings  ', 'hu'), '  Beállítások  ');
  const originalTitle = '<b>Untranslated title {count}</b>';
  assert.equal(
    translate('Delete “{title}”?', 'de', { title: originalTitle }),
    `„${originalTitle}“ löschen?`,
  );
  assert.equal(
    translate('Delete “{title}”?', 'en', { title: originalTitle }),
    `Delete “${originalTitle}”?`,
  );
});

test('count labels use locale plural rules including Russian one/few/many and Japanese', () => {
  assert.equal(countLabel(1, 'file', 'ru'), '1 файл');
  assert.equal(countLabel(2, 'file', 'ru'), '2 файла');
  assert.equal(countLabel(5, 'file', 'ru'), '5 файлов');
  assert.equal(countLabel(21, 'file', 'ru'), '21 файл');
  assert.equal(countLabel(2, 'message', 'hu'), '2 üzenet');
  assert.equal(countLabel(1, 'conversation', 'ja'), '1 会話');
  assert.equal(countLabel(1, 'file', 'en'), '1 file');
  assert.equal(countLabel(2, 'file', 'en'), '2 files');
});

test('chosen UI locale drives dates and collection labels while source names remain unchanged', () => {
  const original = useUIStore.getState().locale;
  const date = new Date('2026-02-16T01:05:09.000Z');
  try {
    for (const locale of LOCALES) {
      useUIStore.setState({ locale });
      assert.equal(
        fmtDate(date.toISOString()),
        new Intl.DateTimeFormat(locale, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(date),
      );
      assert.equal(collLabel('all'), translate('All collections', locale));
      assert.equal(collLabel('Synthetic_Collection'), 'Synthetic_Collection');
      if (locale !== 'en') {
        const now = Date.parse('2026-02-16T12:00:00Z');
        assert.equal(
          fmtRelative(new Date(now - 3 * 60_000).toISOString(), now),
          new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-3, 'minute'),
        );
      }
    }
  } finally {
    useUIStore.setState({ locale: original });
  }
});

test('statically declared interface labels have translations or are intentional technical names', () => {
  const technical = new Set([
    '/absolute/path/to/exports',
    '16k',
    'AMD ROCm',
    'API',
    'Anthropic SDK',
    'ChatGPT / Claude',
    'Claude Code',
    'Codex CLI',
    'DeepSeek Harness',
    'Google AI Studio',
    'LM Studio',
    'MCP',
    'NVIDIA CUDA',
    'OpenAI SDK',
    'OpenRouter',
    'OpenRouter API',
    'ThreadShelf',
    'ThreadShelf Enhanced',
    'Vulkan (AMD / Intel)',
    'Windows PowerShell',
    'Windows:',
    'curl',
    'gpt-5, claude, gemini...',
    'http://127.0.0.1:8080',
    'llama.cpp',
    'macOS / Linux',
    'macOS / Linux:',
    's',
    'sk-or-v1-…',
    'v',
    '· sha256',
    '→ llama.cpp',
  ]);
  const missing = new Set();
  const inspectLiteral = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const key = node.text.trim().replace(/\s+/g, ' ');
      if (key && !Object.hasOwn(translations, key) && !technical.has(key)) missing.add(key);
    } else if (ts.isConditionalExpression(node)) {
      inspectLiteral(node.whenTrue);
      inspectLiteral(node.whenFalse);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      for (const property of node.expression.properties) {
        if (ts.isPropertyAssignment(property)) inspectLiteral(property.initializer);
      }
    }
  };
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['enhanced-renderer', 'i18n'].includes(entry.name)) scan(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        const tree = ts.createSourceFile(
          path,
          readFileSync(path, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
        const visit = (node) => {
          if (ts.isCallExpression(node) && node.expression.getText() === 't' && node.arguments[0])
            inspectLiteral(node.arguments[0]);
          ts.forEachChild(node, visit);
        };
        visit(tree);
      }
    }
  };
  scan(fileURLToPath(new URL('../client/src/', import.meta.url)));
  assert.deepEqual([...missing].sort(), []);
});
