import { spawnSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const repoRoot = resolve('.');
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
});

if (listed.status !== 0) {
  throw new Error(`Could not list commit candidates:\n${listed.stderr || listed.stdout}`);
}

const files = [...new Set(listed.stdout.split('\0').filter(Boolean))].sort();
const violations: string[] = [];

// Runtime data roots are matched by prefix, not exact name. The data root moves
// with THREADSHELF_PATH, so an exact `\.threadshelf` once let a 130 MB
// `.threadshelf-demo/` LanceDB tree reach the index unnoticed.
const forbiddenDirectories =
  /(^|\/)(DO_NOT_COMMIT|personal|private|exports|node_modules|\.local|\.cache|\.home|\.config|\.npm-cache|\.npm-global|\.lancedb[^/]*|\.uploads[^/]*|\.threadshelf[^/]*|\.tmp-[^/]+|\.playwright-mcp|test-results|playwright-report)(\/|$)/i;
const forbiddenExtensions =
  /\.(?:zip|7z|tar|gz|gguf|onnx|lance|txn|manifest|db|sqlite3?|sqlite-(?:journal|wal|shm)|pem|key|p12|log)$/i;
const allowedJson = [
  /^(?:package|package-lock|tsconfig|tsconfig\.build|vite\.config)\.json$/i,
  /^client\/(?:package|tsconfig)\.json$/i,
  /^client\/src\/enhanced-renderer\/licenses\/dependencies\.json$/,
  /^scripts\/renderer-build\/package(?:-lock)?\.json$/,
  /^test\/fixture\.json$/i,
  /^test\/fixtures\/.+\.json$/i,
];
const allowedImages = /^docs\/assets\/.+\.(?:png|gif|jpe?g|webp)$/i;

for (const rawPath of files) {
  const path = rawPath.replace(/\\/g, '/');
  try {
    if ((await lstat(resolve(repoRoot, path))).isSymbolicLink()) {
      violations.push(`${path}: symbolic link outside the source-file policy`);
    }
  } catch {
    continue; // A tracked deletion is not a publication candidate.
  }
  const basename = path.split('/').at(-1) ?? path;

  if (forbiddenDirectories.test(path)) {
    violations.push(`${path}: private/runtime directory`);
  }
  if (path === '.collections.json') {
    violations.push(`${path}: local collection registry`);
  }
  if ((basename === '.env' || basename.startsWith('.env.')) && path !== '.env.example') {
    violations.push(`${path}: populated environment file`);
  }
  if (forbiddenExtensions.test(path)) {
    violations.push(`${path}: private or generated binary/log extension`);
  }
  if (/\.json$/i.test(path) && !allowedJson.some((pattern) => pattern.test(path))) {
    violations.push(`${path}: JSON outside the synthetic/config allowlist`);
  }
  if (/\.(?:png|gif|jpe?g|webp)$/i.test(path) && !allowedImages.test(path)) {
    violations.push(`${path}: image outside docs/assets`);
  }
}

const textExtensions = new Set([
  '',
  '.css',
  '.example',
  '.html',
  '.js',
  '.mjs',
  '.ps1',
  '.py',
  '.sh',
  '.json',
  '.md',
  '.scss',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
const allowedHomeSegments = new Set(['example', 'private-user', 'tester', 'username', 'your-name']);

for (const path of files) {
  if (!textExtensions.has(extname(path).toLowerCase())) continue;

  let content: string;
  try {
    content = await readFile(resolve(repoRoot, path), 'utf8');
  } catch {
    continue;
  }
  if (content.includes('\0')) continue;

  if (/github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}/.test(content)) {
    violations.push(`${path}: value resembling a GitHub credential`);
  }
  if (/sk-or-v1-[A-Za-z0-9_-]{20,}/.test(content)) {
    violations.push(`${path}: value resembling an OpenRouter API key`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
    violations.push(`${path}: private-key material`);
  }

  for (const match of content.matchAll(/[A-Za-z]:\\Users\\([^\\/\r\n`'"]+)/g)) {
    if (!allowedHomeSegments.has(match[1].toLowerCase())) {
      violations.push(`${path}: user-specific Windows home path (${match[1]})`);
    }
  }
  for (const match of content.matchAll(/\/(?:Users|home)\/([^/\s`'"]+)/g)) {
    if (!allowedHomeSegments.has(match[1].toLowerCase())) {
      violations.push(`${path}: user-specific home path (${match[1]})`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(`Repository hygiene check failed:\n- ${violations.join('\n- ')}`);
}

console.log(`Repository hygiene OK (${files.length} tracked/untracked commit candidates checked).`);
