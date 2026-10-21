import hljs from 'highlight.js';
import fish from './fish.js';

// The default import contains every upstream grammar, not highlight.js/lib/common.
hljs.registerLanguage('fish', fish);
export const highlighter = hljs;

export const CODE_LANGUAGE_ALIASES = Object.freeze({
  '': 'plaintext',
  'no-highlight': 'plaintext',
  nohighlight: 'plaintext',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  plaintext: 'plaintext',
  output: 'plaintext',
  log: 'plaintext',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  xhtml: 'xml',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  ts: 'typescript',
  py: 'python',
  py3: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  console: 'shell',
  terminal: 'shell',
  shellsession: 'shell',
  'shell-session': 'shell',
  zsh: 'bash',
  posix: 'bash',
  'posix-sh': 'bash',
  'posix-shell': 'bash',
  'sh/posix': 'bash',
  'posix/sh': 'bash',
  dash: 'bash',
  ash: 'bash',
  ksh: 'bash',
  ksh93: 'bash',
  mksh: 'bash',
  fish: 'fish',
  fishshell: 'fish',
  'fish-shell': 'fish',
  env: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  sqlite: 'sql',
  cs: 'csharp',
  'c#': 'csharp',
  csharp: 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  'h++': 'cpp',
  cp: 'cpp',
  cplusplus: 'cpp',
  h: 'c',
  rb: 'ruby',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  pl: 'perl',
  asm: 'x86asm',
  nasm: 'x86asm',
  x86asm: 'x86asm',
  mmd: 'mermaid',
  mermaid: 'mermaid',
});

const LANGUAGE_LABELS = Object.freeze({
  xml: 'HTML/XML',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  bash: 'Bash',
  shell: 'Shell Session',
  fish: 'Fish',
  powershell: 'PowerShell',
  json: 'JSON',
  yaml: 'YAML',
  markdown: 'Markdown',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  ruby: 'Ruby',
  php: 'PHP',
  sql: 'SQL',
  dockerfile: 'Dockerfile',
  ini: 'INI',
  toml: 'TOML',
  diff: 'Diff',
  dart: 'Dart',
  nasm: 'NASM',
  scss: 'SCSS',
  less: 'Less',
  swift: 'Swift',
  kotlin: 'Kotlin',
  lua: 'Lua',
  perl: 'Perl',
  r: 'R',
  mermaid: 'Mermaid',
  plaintext: 'Text',
});


const FENCE_LABELS = Object.freeze({ sh:'POSIX Shell', posix:'POSIX Shell', 'posix-sh':'POSIX Shell', 'posix-shell':'POSIX Shell', 'sh/posix':'POSIX Shell', 'posix/sh':'POSIX Shell', zsh:'Zsh', ksh:'KornShell', ksh93:'KornShell', mksh:'MirBSD Korn Shell', dash:'Dash', ash:'Ash', shell:'Shell', env:'Shell' });
const canonicalByName = new Map();
for (const name of hljs.listLanguages()) {
  canonicalByName.set(name, name);
  for (const alias of hljs.getLanguage(name).aliases || []) canonicalByName.set(alias.toLowerCase(), name);
}
function fenceName(value = '') {
  return String(value).trim().toLowerCase().split(/\s+/, 1)[0]
    .replace(/^\{\.?/, '').replace(/\}$/, '').replace(/^\./, '').replace(/^(?:language|lang)-/, '');
}
export function normalizeCodeLanguage(value = '') {
  const name = fenceName(value);
  // Explicit fence aliases take priority: "shell" is a script, while "console"
  // and "shellsession" select the separate prompted Shell Session grammar.
  const mapped = CODE_LANGUAGE_ALIASES[name] || name || 'plaintext';
  if (mapped === 'mermaid') return 'mermaid';
  return canonicalByName.get(mapped) || 'plaintext';
}
export function getCodeLanguageLabel(language = 'plaintext', originalFence = '') {
  const requested = fenceName(originalFence);
  return FENCE_LABELS[requested] || LANGUAGE_LABELS[language] || hljs.getLanguage(language)?.name || 'Text';
}
export function registeredCodeLanguages() {
  return hljs.listLanguages().sort().map(name => ({name, label:hljs.getLanguage(name).name || name, aliases:[...(hljs.getLanguage(name).aliases || [])].sort()}));
}
