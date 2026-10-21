import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const mermaidAsset = fileURLToPath(
  new URL('../../client/public/renderer/mermaid.min.js', import.meta.url),
);

// Exercise both the original Jison diagrams and source-rebuilt Langium parsers.
// These tests load the exact shipped asset without the server or a network CDN.
const diagrams = {
  flowchart: '---\ntitle: Saved diagram\n---\nflowchart LR\n A[First] --> B[Second]',
  sequence: 'sequenceDiagram\n participant A\n participant B\n A->>B: Hello\n B-->>A: Received',
  class: 'classDiagram\n Animal <|-- Duck\n Animal : +int age\n Duck : +swim()',
  state: 'stateDiagram-v2\n [*] --> Reading\n Reading --> Complete\n Complete --> [*]',
  entity: 'erDiagram\n READER ||--o{ ARCHIVE : saves\n READER {\n string name\n }',
  gantt:
    'gantt\n title Archive progress\n dateFormat YYYY-MM-DD\n section Import\n Read :2026-01-01, 2d',
  pie: 'pie title Stored threads\n "Imported" : 4\n "Written" : 2',
  journey:
    'journey\n title Review archive\n section Review\n Open thread: 5: Reader\n Read: 4: Reader',
  mindmap: 'mindmap\n root((Archive))\n  Threads\n  Collections',
  timeline: 'timeline\n title Archive history\n 2025 : First export\n 2026 : Import',
  quadrant:
    'quadrantChart\n x-axis Low --> High\n y-axis Small --> Large\n quadrant-1 Review\n Item: [0.6, 0.7]',
  xy: 'xychart-beta\n x-axis [Jan, Feb, Mar]\n y-axis "Count" 0 --> 10\n bar [2, 4, 8]',
  block: 'block-beta\n columns 2\n a["First"] b["Second"]\n a --> b',
  packet: 'packet-beta\n 0-15: "Header"\n 16-31: "Data"',
  architecture:
    'architecture-beta\n group archive(cloud)[Archive]\n service database(database)[Database] in archive\n service server(server)[Server] in archive\n database:R -- L:server',
};

test('bundled Mermaid renders retained diagram families entirely offline', async ({ page }) => {
  const requests = [];
  await page.route('**/*', (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.setContent('<main></main>');
  await page.addScriptTag({ path: mermaidAsset });
  await page.evaluate(() =>
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' }),
  );
  for (const [name, source] of Object.entries(diagrams)) {
    const result = await page.evaluate(
      async ({ name, source }) => {
        const { svg } = await window.mermaid.render(`diagram-${name}`, source);
        const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
        return {
          tag: document.documentElement.localName,
          error: !!document.querySelector('parsererror'),
        };
      },
      { name, source },
    );
    expect(result, name).toEqual({ tag: 'svg', error: false });
  }
  expect(requests).toEqual([]);
});

test('bundled Mermaid uses its patched KaTeX for mathematical labels', async ({ page }) => {
  await page.setContent('<main></main>');
  await page.addScriptTag({ path: mermaidAsset });
  const math = await page.evaluate(async () => {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      forceLegacyMathML: true,
    });
    const { svg } = await window.mermaid.render(
      'diagram-math',
      'flowchart LR\n A["$$x^2 + \\frac{1}{2}$$"] --> B["Done"]',
    );
    const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return {
      math: !!document.querySelector('math'),
      error: !!document.querySelector('.katex-error'),
    };
  });
  expect(math).toEqual({ math: true, error: false });
});
