import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_LANGUAGE_ALIASES,
  normalizeCodeLanguage,
  registeredCodeLanguages,
} from '../client/src/enhanced-renderer/highlight.js';
import {
  CODE_FENCE_EXTENSIONS,
  CODE_LANGUAGE_EXTENSIONS,
  codeDownloadExtension,
  codeDownloadFileName,
} from '../client/src/enhanced-renderer/code-downloads.js';

test('every bundled grammar and alias has an explicit download extension', () => {
  const registry = registeredCodeLanguages();
  assert.ok(registry.length > 190, 'exercise the complete bundled highlighter, including Fish');
  const knownFences = new Set(['mermaid', 'mmd', ...Object.keys(CODE_LANGUAGE_ALIASES)]);
  for (const grammar of registry) {
    assert.ok(Object.hasOwn(CODE_LANGUAGE_EXTENSIONS, grammar.name), grammar.name);
    knownFences.add(grammar.name);
    for (const alias of grammar.aliases) knownFences.add(alias);
  }
  for (const fence of knownFences) {
    const language = normalizeCodeLanguage(fence);
    assert.ok(Object.hasOwn(CODE_LANGUAGE_EXTENSIONS, language), `${fence} → ${language}`);
    const extension = Object.hasOwn(CODE_FENCE_EXTENSIONS, fence)
      ? CODE_FENCE_EXTENSIONS[fence]
      : CODE_LANGUAGE_EXTENSIONS[language];
    assert.equal(codeDownloadExtension(fence), extension, fence);
    assert.match(extension, /^[a-z0-9+]+(?:\.[a-z0-9+]+)*$/, fence);
    assert.equal(codeDownloadFileName(fence, 2), `code-block-2.${extension}`, fence);
  }
});

test('original fences preserve formats that share a highlighting grammar', () => {
  const formats = {
    html: 'html',
    htm: 'htm',
    xml: 'xml',
    svg: 'svg',
    xhtml: 'xhtml',
    js: 'js',
    mjs: 'mjs',
    cjs: 'cjs',
    jsx: 'jsx',
    ts: 'ts',
    mts: 'mts',
    cts: 'cts',
    tsx: 'tsx',
    c: 'c',
    h: 'h',
    cpp: 'cpp',
    hpp: 'hpp',
    'h++': 'h++',
    cc: 'cc',
    ini: 'ini',
    toml: 'toml',
    json: 'json',
    json5: 'json5',
    jsonc: 'jsonc',
    sh: 'sh',
    shell: 'sh',
    zsh: 'zsh',
    fish: 'fish',
    'fish-shell': 'fish',
    console: 'txt',
    terminal: 'txt',
    'shell-session': 'txt',
    python: 'py',
    'python-repl': 'txt',
    irb: 'txt',
    perl: 'pl',
    pm: 'pm',
    kotlin: 'kt',
    kts: 'kts',
    objectivec: 'm',
    'objective-c++': 'mm',
    dockerfile: 'dockerfile',
    makefile: 'mk',
    mermaid: 'mmd',
    mmd: 'mmd',
    wasm: 'wat',
    excel: 'txt',
    xlsx: 'txt',
    tp: 'ls',
  };
  for (const [fence, extension] of Object.entries(formats)) {
    assert.equal(codeDownloadExtension(fence), extension, fence);
    assert.equal(codeDownloadExtension(`language-${fence.toUpperCase()}`), extension, fence);
    assert.equal(codeDownloadExtension(`{.${fence}}`), extension, fence);
    assert.equal(codeDownloadExtension(`${fence} title="example"`), extension, fence);
  }
});

test('unknown and untagged blocks remain text with safe predictable file names', () => {
  for (const fence of [
    undefined,
    null,
    '',
    ' ',
    'text',
    'txt',
    'plain',
    'plaintext',
    'unknown-language',
    '../../unsafe.js',
    '__proto__',
    'constructor',
    '<svg onload=x>',
  ]) {
    assert.equal(codeDownloadExtension(fence), 'txt', String(fence));
    assert.equal(codeDownloadFileName(fence), 'code-block-1.txt', String(fence));
  }
  for (const index of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '../../bad']) {
    assert.equal(codeDownloadFileName('javascript', index), 'code-block-1.js');
  }
});
