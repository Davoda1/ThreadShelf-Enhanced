import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
const root = process.cwd();
const result = await build({
  absWorkingDir: root,
  entryPoints: ['packages/mermaid/src/mermaid.ts'],
  outfile: 'output/mermaid.min.js',
  bundle: true,
  minify: true,
  keepNames: true,
  platform: 'browser',
  format: 'iife',
  globalName: '__esbuild_esm_mermaid_nm["mermaid"]',
  footer: { js: 'globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;' },
  sourcemap: 'external',
  metafile: true,
  resolveExtensions: ['.ts', '.js', '.json', '.jison', '.yaml'],
  external: ['require', 'fs', 'path'],
  define: {
    'injected.includeLargeFeatures': 'true',
    'injected.profiling': 'false',
    'injected.version': '"11.17.2"',
    'import.meta.vitest': 'undefined',
  },
  alias: { '@mermaid-js/parser': resolve(root, 'packages/parser/src/index.ts') },
  plugins: [
    {
      name: 'upstream-generated-inputs',
      setup(b) {
        b.onLoad({ filter: /\.(jison|schema\.yaml)$/ }, async (args) => ({
          contents: await readFile(args.path, 'utf8'),
          loader: 'js',
        }));
      },
    },
  ],
  logLevel: 'info',
});
await writeFile('output/metafile.json', JSON.stringify(result.metafile, null, 2) + '\n');

// Only retained output counts as embedded code. Walk up past package.json files
// that merely declare module type to find the actual package name and version.
const packages = new Map();
const packageCache = new Map();
const add = (name, version) => packages.set(`${name}@${version}`, { name, version });
for (const [output, details] of Object.entries(result.metafile.outputs)) {
  if (!output.endsWith('.js')) continue;
  for (const [input, contribution] of Object.entries(details.inputs)) {
    if (!contribution.bytesInOutput) continue;
    if (input.startsWith('packages/mermaid/')) add('mermaid', '11.17.2');
    else if (input.startsWith('packages/parser/')) add('@mermaid-js/parser', '1.2.1');
    else if (input.startsWith('node_modules/')) {
      let directory = dirname(resolve(root, input));
      while (directory !== root) {
        if (!packageCache.has(directory)) {
          let metadata = null;
          try {
            metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          packageCache.set(directory, metadata);
        }
        const metadata = packageCache.get(directory);
        if (metadata?.name && metadata?.version) {
          add(metadata.name, metadata.version);
          break;
        }
        directory = dirname(directory);
      }
      if (directory === root) throw new Error(`No package identity for ${input}`);
    } else throw new Error(`Unclassified bundled input: ${input}`);
  }
}

// These upstream inputs are themselves bundles. Their independently reviewed
// nested inventories remain valid only while their complete bytes are unchanged.
const nestedBundles = [
  {
    name: 'roughjs',
    path: 'node_modules/roughjs/bundled/rough.esm.js',
    sha256: 'e921535f216ebc93d422489d614da955b5286812220b3149fc70978f4cb5bd45',
    packages: [
      ['hachure-fill', '0.5.2'],
      ['path-data-parser', '0.1.0'],
      ['points-on-curve', '0.2.0'],
      ['points-on-path', '0.2.1'],
    ],
  },
  {
    name: '@upsetjs/venn.js',
    path: 'node_modules/@upsetjs/venn.js/build/venn.esm.js',
    sha256: '47e73982c0cf8a4e692c57a06656fc928aeced63267d9a1e6f48122c4127da30',
    packages: [['fmin', '0.0.4']],
  },
];
for (const nested of nestedBundles) {
  if (![...packages.values()].some(({ name }) => name === nested.name)) continue;
  const hash = createHash('sha256')
    .update(await readFile(nested.path))
    .digest('hex');
  if (hash !== nested.sha256) throw new Error(`Reaudit changed nested bundle: ${nested.name}`);
  for (const [name, version] of nested.packages) add(name, version);
}
const inventory = [...packages.values()].sort((a, b) => {
  const first = `${a.name}@${a.version}`;
  const second = `${b.name}@${b.version}`;
  return first < second ? -1 : first > second ? 1 : 0;
});
await writeFile('output/packages.json', JSON.stringify(inventory, null, 2) + '\n');
