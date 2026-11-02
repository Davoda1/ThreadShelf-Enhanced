/** Capture the real UI using an isolated archive made entirely from synthetic text. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { getAvailablePort, stopChildProcess, waitForHealth } from '../test/shared/helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'docs/extras');
const temp = await mkdtemp(join(tmpdir(), 'threadshelf-docs-'));
const port = await getAvailablePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(port),
  ALLOWED_HOSTS: '',
  ALLOWED_ORIGINS: '',
  ALLOW_LAN_AI: '0',
  ALLOW_LAN_TTS: '0',
  THREADSHELF_DATA_DIR: join(temp, 'data'),
  LANCEDB_PATH: join(temp, 'db'),
  UPLOADS_DIR: join(temp, 'uploads'),
  COLLECTIONS_PATH: join(temp, 'collections.json'),
  GENERATION_CONFIG_PATH: join(temp, 'generation.json'),
  MASTER_PROMPTS_PATH: join(temp, 'prompts.json'),
  OBSIDIAN_CONFIG_PATH: join(temp, 'notes.json'),
  THREADSHELF_MODELS_PATH: join(temp, 'models'),
  THREADSHELF_TOOLS_PATH: join(temp, 'tools'),
  THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS: '1',
  THREADSHELF_MEMORY_RESERVE_MB: '256',
  THREADSHELF_PROCESS_MEMORY_MB: '2048',
  OPENROUTER_API_KEY: '',
  OPENAI_COMPATIBLE_API_KEY: '',
  OPENAI_COMPATIBLE_BASE_URL: '',
  STRATA_API_KEY: '',
  THREADSHELF_API_KEY: '',
};
const samples = [
  {
    key: 'reading',
    title: 'Designing a calmer reading experience',
    user: 'How can a conversation archive stay readable as it grows?',
    ai: '# A clearer place for your conversations\n\nA useful archive preserves the structure of an answer and makes the next step easy to find.\n\n## Three small choices that help\n\n| Design choice | Benefit |\n| --- | --- |\n| Clear headings and generous spacing | Scan long answers with less effort |\n| Search by meaning and exact phrases | Find the right passage in different ways |\n| Optional read-aloud controls | Listen while reviewing a saved response |\n\n> Keep the original conversation intact. Let the interface help you navigate it.\n\nStart with a small collection, give it a clear name, and save a few useful searches. Add notes when you need a short explanation of why a result matters.\n\n## A review routine\n\n1. Find a useful conversation.\n2. Check its context and original sources.\n3. Save a concise note with a reference back to the archive.',
  },
  {
    key: 'code',
    title: 'A small, typed search helper',
    user: 'Show a readable TypeScript function for ranking matching titles.',
    ai: '## A focused search helper\n\nNormalize the query once, retain exact matches, and keep ties predictable.\n\n```typescript\ntype Entry = { id: string; title: string };\n\nexport function searchTitles(entries: Entry[], query: string) {\n  const needle = query.trim().toLocaleLowerCase();\n  if (!needle) return [];\n\n  return entries\n    .filter(({ title }) => title.toLocaleLowerCase().includes(needle))\n    .sort((a, b) => a.title.localeCompare(b.title));\n}\n```\n\nThis small helper is useful for exact title filtering. For a larger archive, combine lexical matching with semantic retrieval and keep the original source attached to every result.\n\n### Check the edge cases\n\n- Empty queries return no results.\n- Matching ignores differences in letter case.\n- Results keep their stable source identifiers.\n- Equal titles retain a predictable order.',
  },
  {
    key: 'diagram',
    title: 'From archive search to a useful note',
    user: 'Sketch a workflow for reviewing a search result before adding it to my notes.',
    ai: '## Review before you save\n\nUse the full conversation to understand a result in context.\n\n```mermaid\nflowchart TD\n  A[Search the archive] --> B[Read the source]\n  B --> C{Useful evidence?}\n  C -->|Yes| D[Draft a short note]\n  C -->|No| E[Refine the query]\n  E --> A\n  D --> F[Review and approve]\n  F --> G[Save to the note folder]\n```\n\nKeep the source reference in the note so that later readers can check the original explanation.',
  },
  {
    key: 'chart',
    title: 'Making time for a weekly review',
    user: 'Give me a simple example of a five-day archive review schedule.',
    ai: '## A manageable review rhythm\n\nThese illustrative values show minutes set aside for reviewing saved conversations.\n\ngenui{"chart":{"content":{"chartType":"bar","xKey":"day","series":[{"dataKey":"minutes","label":"Review minutes"}],"data":[{"day":"Mon","minutes":20},{"day":"Tue","minutes":30},{"day":"Wed","minutes":25},{"day":"Thu","minutes":35},{"day":"Fri","minutes":40}]}}}\n\nThe average is \\[\\bar{x}=\\frac{20+30+25+35+40}{5}=30\\text{ minutes}.\\]\n\nA short, regular review makes it easier to connect an older answer to a current question.',
  },
  {
    key: 'hybrid',
    title: 'Finding an answer with hybrid search',
    user: 'When should I combine exact words with semantic search?',
    ai: '## Two ways to find the same idea\n\nSemantic search helps when your wording differs from the original conversation. Exact words are valuable for identifiers, quoted phrases and specific names. Hybrid search retrieves both kinds of candidates independently, then combines the rankings.\n\nTry a broad question first, narrow the collection, and inspect the complete source before relying on a short excerpt.',
  },
  {
    key: 'notes',
    title: 'Keeping research notes connected',
    user: 'How should I organize notes from an archive review?',
    ai: '## Keep notes small and traceable\n\nUse one note for one idea. Include a short summary, the question it answers and a source reference. Review changes before writing them, and keep revision history so that an earlier explanation can be recovered.\n\nSearch the live Markdown folder when you need an exact heading or a related passage.',
  },
];
let server: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output, { recursive: true });
  const seed = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const { replaceImportedFiles } = await import('./src/store.ts');
    const samples = ${JSON.stringify(samples)};
    for (const [collection, provider] of [['research','openai'],['engineering','anthropic'],['learning','google-ai-studio'],['ideas','openrouter']]) {
      await replaceImportedFiles(collection, [{ sourceFile: 'demo-library.json', provider,
        conversations: samples.map((item, index) => ({ key: item.key,
          title: item.title, turns: [
            { user: item.user, createdAt: '2026-10-' + String(12 + index).padStart(2,'0') + 'T10:00:00Z' },
            { ai: item.ai, model: 'Example model', createdAt: '2026-10-' + String(12 + index).padStart(2,'0') + 'T10:01:00Z' }
          ] })) }]);
    }
  `,
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 120_000 },
  );
  if (seed.status !== 0) throw new Error(`Synthetic archive setup failed: ${seed.stderr}`);
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: root,
    env,
    stdio: 'ignore',
  });
  await waitForHealth(base);
  const enabled = await fetch(`${base}/api/tts/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { enabled: true, showPillSettings: true } }),
  });
  if (!enabled.ok) throw new Error('Could not enable synthetic speech controls.');
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  });
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
    });
    await context.addInitScript(
      (themeName) =>
        localStorage.setItem(
          'threadshelf:ui',
          JSON.stringify({
            state: {
              theme: themeName,
              activeColl: 'all',
              roles: { user: true, thinking: true, ai: true },
            },
            version: 0,
          }),
        ),
      theme,
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const capture = async (name: string) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      if (errors.length) throw new Error(errors.join('\n'));
      await page.screenshot({ path: join(output, name) });
      console.log(name);
    };
    const thread = async (key: string) => {
      const item = samples.find((sample) => sample.key === key)!;
      const params = new URLSearchParams({
        collection: 'research',
        sourceFile: 'demo-library.json',
        conversationKey: key,
        title: item.title,
      });
      await page.goto(`${base}/thread?${params}`, { waitUntil: 'networkidle' });
      await page.locator('.enhanced-markdown').first().waitFor();
      await page.locator('.turn[data-role="ai"] .turn-head').first().hover();
    };
    await thread('reading');
    await capture(theme === 'dark' ? '01-reader-dark.png' : '02-reader-light.png');
    if (theme === 'dark') {
      await thread('code');
      await capture('03-code-dark.png');
      await thread('chart');
      await page.locator('.rich-chart svg').waitFor();
      await page.locator('.thread-inner').evaluate((element) => {
        element.scrollTop = 260;
      });
      await capture('05-chart-math-dark.png');
      await page.goto(`${base}/search/all`, { waitUntil: 'networkidle' });
      await capture('07-archive-dark.png');
    } else {
      await thread('diagram');
      await page.locator('.mermaid-diagram svg').waitFor();
      await page
        .locator('.mermaid-diagram')
        .evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await capture('04-diagram-light.png');
      await page.goto(`${base}/search/all?q=archive%20search&mode=hybrid`, {
        waitUntil: 'networkidle',
      });
      await page.locator('.result').first().waitFor();
      await capture('06-search-light.png');
      await page.goto(`${base}/insights`, { waitUntil: 'networkidle' });
      await capture('08-insights-light.png');
    }
    await page.goto(`${base}/settings`, { waitUntil: 'networkidle' });
    await page.locator('#settings-tab-tts').click();
    await page.locator('.tts-settings-mount').waitFor();
    await capture(theme === 'dark' ? '09-speech-dark.png' : '10-speech-light.png');
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) await stopChildProcess(server);
  await rm(temp, { recursive: true, force: true });
}
