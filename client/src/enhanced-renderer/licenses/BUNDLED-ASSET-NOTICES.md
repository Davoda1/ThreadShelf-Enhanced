# Bundled browser asset notices

This directory preserves the original terms for browser assets redistributed with
ThreadShelf Enhanced. The application MIT license does not replace these terms.
The assets are unchanged copies of the corresponding official npm distributions;
see [verification and source records](BUNDLED-ASSET-PROVENANCE.md).

## MathJax

`client/public/renderer/mathjax-tex-svg.js` is MathJax 3.2.1, Copyright (c)
2017-2022 The MathJax Consortium. Its full Apache-2.0 license is retained in
[MathJax-Upstream-LICENSE.txt](MathJax-Upstream-LICENSE.txt), with the source
attribution in [MathJax-NOTICE.txt](MathJax-NOTICE.txt).

## Mermaid and included components

`client/public/renderer/mermaid.min.js` is Mermaid 11.17.2, Copyright (c)
2014-2022 Knut Sveidqvist. Its MIT license is retained in
[Mermaid-LICENSE.txt](Mermaid-LICENSE.txt). The prebuilt asset also contains the
components listed below; their original license files are reproduced separately.
Its embedded legal comments are retained unchanged.

Versions were recovered from the exact official bundle's source maps and verified
nested bundle sources. [Nested bundle provenance](NESTED-BUNDLE-PROVENANCE.md)
records the parser, Rough.js, Venn and KaTeX checks. This inventory describes the
prebuilt browser asset, independently of this application's npm lockfile.
Some source-map inputs may be eliminated by the bundler; retaining their notices
also covers those inputs without claiming that every exported function is present.

DOMPurify offers Apache-2.0 or MPL-2.0. This distribution uses its Apache-2.0
option and preserves the complete original license files. Other included
components retain their MIT, ISC, BSD-3-Clause or Apache-2.0 terms as shown below.
Original copyright and attribution notices in the reproduced licenses are kept.

| Component | Version | License | Full original terms |
| --- | --- | --- | --- |
| @braintree/sanitize-url | 7.1.2 | MIT | [LICENSE.txt](mermaid-dependencies/braintree--sanitize-url-7.1.2/LICENSE.txt) |
| @chevrotain/gast | 11.1.2 | Apache-2.0 | [LICENSE.txt](mermaid-dependencies/chevrotain--gast-11.1.2/LICENSE.txt) |
| @chevrotain/regexp-to-ast | 11.1.2 | Apache-2.0 | [LICENSE.txt](mermaid-dependencies/chevrotain--regexp-to-ast-11.1.2/LICENSE.txt) |
| @chevrotain/utils | 11.1.2 | Apache-2.0 | [LICENSE.txt](mermaid-dependencies/chevrotain--utils-11.1.2/LICENSE.txt) |
| @iconify/utils | 3.0.2 | MIT | [license.txt](mermaid-dependencies/iconify--utils-3.0.2/license.txt) |
| @mermaid-js/parser | 1.2.1 | MIT | [LICENSE.txt](mermaid-dependencies/mermaid-js--parser-1.2.1/LICENSE.txt) |
| @upsetjs/venn.js | 2.0.0 | MIT | [LICENSE.txt](mermaid-dependencies/upsetjs--venn.js-2.0.0/LICENSE.txt) |
| chevrotain | 11.1.2 | Apache-2.0 | [LICENSE.txt](mermaid-dependencies/chevrotain-11.1.2/LICENSE.txt) |
| chevrotain-allstar | 0.3.1 | MIT | [LICENSE.txt](mermaid-dependencies/chevrotain-allstar-0.3.1/LICENSE.txt) |
| cose-base | 1.0.3 | MIT | [LICENSE.txt](mermaid-dependencies/cose-base-1.0.3/LICENSE.txt) |
| cose-base | 2.2.0 | MIT | [LICENSE.txt](mermaid-dependencies/cose-base-2.2.0/LICENSE.txt) |
| cytoscape | 3.34.0 | MIT | [LICENSE.txt](mermaid-dependencies/cytoscape-3.34.0/LICENSE.txt) |
| cytoscape-cose-bilkent | 4.1.0 | MIT | [LICENSE.txt](mermaid-dependencies/cytoscape-cose-bilkent-4.1.0/LICENSE.txt) |
| cytoscape-fcose | 2.2.0 | MIT | [LICENSE.txt](mermaid-dependencies/cytoscape-fcose-2.2.0/LICENSE.txt) |
| d3 | 7.9.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-7.9.0/LICENSE.txt) |
| d3-array | 2.12.1 | BSD-3-Clause | [LICENSE.txt](mermaid-dependencies/d3-array-2.12.1/LICENSE.txt) |
| d3-array | 3.2.4 | ISC | [LICENSE.txt](mermaid-dependencies/d3-array-3.2.4/LICENSE.txt) |
| d3-axis | 3.0.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-axis-3.0.0/LICENSE.txt) |
| d3-brush | 3.0.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-brush-3.0.0/LICENSE.txt) |
| d3-chord | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-chord-3.0.1/LICENSE.txt) |
| d3-color | 3.1.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-color-3.1.0/LICENSE.txt) |
| d3-contour | 4.0.2 | ISC | [LICENSE.txt](mermaid-dependencies/d3-contour-4.0.2/LICENSE.txt) |
| d3-delaunay | 6.0.4 | ISC | [LICENSE.txt](mermaid-dependencies/d3-delaunay-6.0.4/LICENSE.txt) |
| d3-dispatch | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-dispatch-3.0.1/LICENSE.txt) |
| d3-drag | 3.0.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-drag-3.0.0/LICENSE.txt) |
| d3-dsv | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-dsv-3.0.1/LICENSE.txt) |
| d3-ease | 3.0.1 | BSD-3-Clause | [LICENSE.txt](mermaid-dependencies/d3-ease-3.0.1/LICENSE.txt) |
| d3-fetch | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-fetch-3.0.1/LICENSE.txt) |
| d3-force | 3.0.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-force-3.0.0/LICENSE.txt) |
| d3-format | 3.1.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-format-3.1.0/LICENSE.txt) |
| d3-geo | 3.1.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-geo-3.1.1/LICENSE.txt) |
| d3-hierarchy | 3.1.2 | ISC | [LICENSE.txt](mermaid-dependencies/d3-hierarchy-3.1.2/LICENSE.txt) |
| d3-interpolate | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-interpolate-3.0.1/LICENSE.txt) |
| d3-path | 1.0.9 | BSD-3-Clause | [LICENSE.txt](mermaid-dependencies/d3-path-1.0.9/LICENSE.txt) |
| d3-path | 3.1.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-path-3.1.0/LICENSE.txt) |
| d3-polygon | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-polygon-3.0.1/LICENSE.txt) |
| d3-quadtree | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-quadtree-3.0.1/LICENSE.txt) |
| d3-random | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-random-3.0.1/LICENSE.txt) |
| d3-sankey | 0.12.3 | BSD-3-Clause | [LICENSE.txt](mermaid-dependencies/d3-sankey-0.12.3/LICENSE.txt) |
| d3-scale | 4.0.2 | ISC | [LICENSE.txt](mermaid-dependencies/d3-scale-4.0.2/LICENSE.txt) |
| d3-scale-chromatic | 3.1.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-scale-chromatic-3.1.0/LICENSE.txt) |
| d3-selection | 3.0.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-selection-3.0.0/LICENSE.txt) |
| d3-shape | 1.3.7 | BSD-3-Clause | [LICENSE.txt](mermaid-dependencies/d3-shape-1.3.7/LICENSE.txt) |
| d3-shape | 3.2.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-shape-3.2.0/LICENSE.txt) |
| d3-time | 3.1.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-time-3.1.0/LICENSE.txt) |
| d3-time-format | 4.1.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-time-format-4.1.0/LICENSE.txt) |
| d3-timer | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-timer-3.0.1/LICENSE.txt) |
| d3-transition | 3.0.1 | ISC | [LICENSE.txt](mermaid-dependencies/d3-transition-3.0.1/LICENSE.txt) |
| d3-zoom | 3.0.0 | ISC | [LICENSE.txt](mermaid-dependencies/d3-zoom-3.0.0/LICENSE.txt) |
| dagre-d3-es | 7.0.14 | MIT | [LICENSE.md](mermaid-dependencies/dagre-d3-es-7.0.14/LICENSE.md) |
| dayjs | 1.11.21 | MIT | [LICENSE.txt](mermaid-dependencies/dayjs-1.11.21/LICENSE.txt) |
| dompurify | 3.4.12 | (MPL-2.0 OR Apache-2.0) | [LICENSE.txt](mermaid-dependencies/dompurify-3.4.12/LICENSE.txt), [LICENSE-MPL.txt](mermaid-dependencies/dompurify-3.4.12/LICENSE-MPL.txt) |
| es-toolkit | 1.45.1 | MIT | [LICENSE.txt](mermaid-dependencies/es-toolkit-1.45.1/LICENSE.txt) |
| fastdom | 1.0.12 | MIT | [README-LICENSE.txt](mermaid-dependencies/fastdom-1.0.12/README-LICENSE.txt) |
| fmin | 0.0.4 | BSD-3-Clause | [LICENSE.txt](mermaid-dependencies/fmin-0.0.4/LICENSE.txt) |
| hachure-fill | 0.5.2 | MIT | [LICENSE.txt](mermaid-dependencies/hachure-fill-0.5.2/LICENSE.txt) |
| internmap | 2.0.3 | ISC | [LICENSE.txt](mermaid-dependencies/internmap-2.0.3/LICENSE.txt) |
| js-yaml | 4.3.0 | MIT | [LICENSE.txt](mermaid-dependencies/js-yaml-4.3.0/LICENSE.txt) |
| katex | 0.16.47 | MIT | [LICENSE.txt](mermaid-dependencies/katex-0.16.47/LICENSE.txt) |
| khroma | 2.1.0 | MIT (license file; registry field absent) | [license.txt](mermaid-dependencies/khroma-2.1.0/license.txt) |
| langium | 4.2.1 | MIT | [LICENSE.txt](mermaid-dependencies/langium-4.2.1/LICENSE.txt) |
| layout-base | 1.0.2 | MIT | [LICENSE.txt](mermaid-dependencies/layout-base-1.0.2/LICENSE.txt) |
| layout-base | 2.0.1 | MIT | [LICENSE.txt](mermaid-dependencies/layout-base-2.0.1/LICENSE.txt) |
| lodash-es | 4.17.23 | MIT | [LICENSE.txt](mermaid-dependencies/lodash-es-4.17.23/LICENSE.txt) |
| lodash-es | 4.18.1 | MIT | [LICENSE.txt](mermaid-dependencies/lodash-es-4.18.1/LICENSE.txt) |
| marked | 16.3.0 | MIT | [LICENSE.md](mermaid-dependencies/marked-16.3.0/LICENSE.md) |
| mermaid | 11.17.2 | MIT | [LICENSE.txt](mermaid-dependencies/mermaid-11.17.2/LICENSE.txt) |
| path-data-parser | 0.1.0 | MIT | [LICENSE.txt](mermaid-dependencies/path-data-parser-0.1.0/LICENSE.txt) |
| points-on-curve | 0.2.0 | MIT | [LICENSE.txt](mermaid-dependencies/points-on-curve-0.2.0/LICENSE.txt) |
| points-on-path | 0.2.1 | MIT | [LICENSE.txt](mermaid-dependencies/points-on-path-0.2.1/LICENSE.txt) |
| roughjs | 4.6.6 | MIT | [LICENSE.txt](mermaid-dependencies/roughjs-4.6.6/LICENSE.txt) |
| stylis | 4.3.6 | MIT | [LICENSE.txt](mermaid-dependencies/stylis-4.3.6/LICENSE.txt) |
| ts-dedent | 2.2.0 | MIT | [LICENSE.txt](mermaid-dependencies/ts-dedent-2.2.0/LICENSE.txt) |
| uuid | 14.0.0 | MIT | [LICENSE.md](mermaid-dependencies/uuid-14.0.0/LICENSE.md) |
| vscode-jsonrpc | 8.2.0 | MIT | [License.txt](mermaid-dependencies/vscode-jsonrpc-8.2.0/License.txt) |
| vscode-languageserver-protocol | 3.17.5 | MIT | [License.txt](mermaid-dependencies/vscode-languageserver-protocol-3.17.5/License.txt) |
| vscode-languageserver-textdocument | 1.0.12 | MIT | [License.txt](mermaid-dependencies/vscode-languageserver-textdocument-1.0.12/License.txt) |
| vscode-languageserver-types | 3.17.5 | MIT | [License.txt](mermaid-dependencies/vscode-languageserver-types-3.17.5/License.txt) |

## Application adaptations and package-installed dependencies

The renderer's Reader adaptations remain under the retained
[ThreadShelf Local Reader MIT license](ThreadShelf-Local-Reader-LICENSE.txt).
The Processor reference notice remains in
[ChatGPT-Export-Processor-GUI-LICENSE.txt](ChatGPT-Export-Processor-GUI-LICENSE.txt).
The Reader license's historical `licenses/ThreadShelf-MIT.txt` reference refers
to the upstream MIT terms retained in the repository's root `LICENSE`.

Separately installed `marked` 16.4.2 and `highlight.js` 11.12.0 retain their
[Marked/Markdown license](marked-LICENSE.md) and
[highlight.js BSD-3-Clause license](highlight.js-LICENSE.txt). Mermaid contains
its own separately listed Marked version. Other npm dependencies are downloaded
at installation and retain their own package licenses; their binaries are not
included in the source release archives.
