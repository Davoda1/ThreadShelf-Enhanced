# Nested Mermaid bundle provenance

The offline `client/public/renderer/mermaid.min.js` asset is the unchanged
`dist/mermaid.min.js` published in the official **mermaid 11.17.2** npm package.
Its official source map identifies several already-bundled inputs. The
dependency notices supplied in this directory also cover the components below;
the top-level Mermaid license alone does not replace their licenses.

Source package: <https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz>.
The source map used for this inventory is `package/dist/mermaid.min.js.map`
inside that tarball. No dependency was installed or executed for this inventory.

## Mermaid parser

All **32** `../../parser/dist/` inputs embedded in the Mermaid source map
match the corresponding files in **@mermaid-js/parser 1.2.1** byte for byte.
The exact source is
<https://registry.npmjs.org/@mermaid-js/parser/-/parser-1.2.1.tgz>.
The parser's own source maps identify these nested packages and versions:

| Package | Version |
| --- | --- |
| @chevrotain/gast | 11.1.2 |
| @chevrotain/regexp-to-ast | 11.1.2 |
| @chevrotain/utils | 11.1.2 |
| chevrotain | 11.1.2 |
| chevrotain-allstar | 0.3.1 |
| langium | 4.2.1 |
| lodash-es | 4.17.23 and 4.18.1 |
| vscode-jsonrpc | 8.2.0 |
| vscode-languageserver-protocol | 3.17.5 |
| vscode-languageserver-textdocument | 1.0.12 |
| vscode-languageserver-types | 3.17.5 |

These versions come from package paths in the published source maps, including
both Lodash versions. Development dependencies that are absent from the bundle
are not included merely because they occur in package metadata.

## Rough.js

The embedded `roughjs/bundled/rough.esm.js` is byte-identical to the same file
in the official **roughjs 4.6.6** package. Its SHA-256 is
`e921535f216ebc93d422489d614da955b5286812220b3149fc70978f4cb5bd45`.
Although Mermaid's pnpm source-map path includes a patch identifier, the
bundled file used here has no difference from the published Rough.js file.

Rough.js includes these additional packages:

| Package | Version |
| --- | --- |
| hachure-fill | 0.5.2 |
| path-data-parser | 0.1.0 |
| points-on-curve | 0.2.0 |
| points-on-path | 0.2.1 |

The versions are recorded in the upstream `package-lock.json` at the npm
release's `gitHead`, commit `56a2762171b1294d643501e8d14f120db6b27bd7`:
<https://raw.githubusercontent.com/pshihn/rough/56a2762171b1294d643501e8d14f120db6b27bd7/package-lock.json>.
That lockfile has SHA-256
`da065ed0bdfb3bf196c7cb05bf20dcb10100b6aa0f1f1d6037ea8aeb108b3ad5`.

## Venn.js and fmin

The embedded `@upsetjs/venn.js/build/venn.esm.js` is byte-identical to the
official **@upsetjs/venn.js 2.0.0** file. Its SHA-256 is
`47e73982c0cf8a4e692c57a06656fc928aeced63267d9a1e6f48122c4127da30`.

The package's published `package.json` specifies the patched npm alias
`patch:fmin@npm%3A0.0.4#~/.yarn/patches/fmin-npm-0.0.4-e439f499bd.patch`.
The Venn bundle contains fmin's `bisect`, `nelderMead`, `wolfeLineSearch`, and
`conjugateGradient` implementations. The retained **fmin 0.0.4** license
covers this underlying component; the version here identifies the pinned
npm source, rather than claiming the patched implementation is an unchanged
copy of that package.

Source package:
<https://registry.npmjs.org/@upsetjs/venn.js/-/venn.js-2.0.0.tgz>.

## KaTeX

The embedded `katex/dist/katex.mjs` is byte-identical to the official
**katex 0.16.47** file. Its SHA-256 is
`09a78a9812d1e7d3ace85033512e6a450127b9554ef281b4b6567408694c6e36`.
The retained KaTeX license applies to this code. Its CLI dependency Commander
is not imported by the browser module and is not identified as bundled here.

Source package: <https://registry.npmjs.org/katex/-/katex-0.16.47.tgz>.
