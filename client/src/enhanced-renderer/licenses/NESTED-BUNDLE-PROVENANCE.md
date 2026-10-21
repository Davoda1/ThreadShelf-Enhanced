# Nested bundle provenance

ThreadShelf Enhanced 1.1.0 ships a reproducible rebuild of **Mermaid 11.17.2**.
See [the build recipe and checksums](BUNDLED-ASSET-PROVENANCE.md). Its generated
metafile identifies nonzero package contributions to the output; additional
components already bundled inside upstream inputs are documented below.

## Mermaid parser

The parser is rebuilt from **@mermaid-js/parser 1.2.1** original source-map
contents, including generated Langium grammars. It is not copied as a prebuilt
chunk. The original generated grammar logic is preserved while the build resolves
Lodash imports to **lodash-es 4.18.1**. The old nested 4.17.23 copy is absent.
The standalone build lock supplies the exact dependency resolution; only packages
with retained output are listed in `dependencies.json`. Some files within
Langium and Chevrotain are eliminated by tree shaking, which does not remove the
license obligations for their retained code.

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

The new build imports `katex/dist/katex.mjs` from official **katex 0.18.10**,
replacing 0.16.47. Its module SHA-256 is
`694a531495903e374957e9a9c904a402e2f413762635df486c4cf6163320d1aa`.
The complete KaTeX license is retained. Its CLI dependency Commander is not
imported by the browser module and is not identified as bundled here.

Source package: <https://registry.npmjs.org/katex/-/katex-0.18.10.tgz>.

## MathJax

The unchanged MathJax 3.2.1 `tex-svg.js` bundle includes speech-rule-engine 4.0.6
and mj-context-menu 0.6.1. Exact upstream release-lock evidence, source notices
and full license terms are recorded in
[BUNDLED-ASSET-PROVENANCE.md](BUNDLED-ASSET-PROVENANCE.md).
`mhchemparser` is an optional autoload; `xmldom-sre`, `wicked-good-xpath` and
Commander belong to external Node fallbacks, not the embedded browser runtime.
