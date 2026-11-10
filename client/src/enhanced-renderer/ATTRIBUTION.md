# Renderer provenance

The bounded rich-content parser, rich layout and chart rendering, chart inspection,
code-language adapters (including Fish), citation binding, math delimiter repair,
and deterministic Mermaid repair are adapted from **ThreadShelf Local Reader
3.3.0**, supplied source revision 9, Copyright (c) 2026 davoda1, MIT.

`renderer.js` adapts the same Reader's Markdown sanitizer, code controls, Mermaid
fallback/copy/original-versus-repaired controls and clipboard fallback. Its React
mount lifecycle, per-message cleanup, application-token stylesheet bridge and
explicit image loading were added for ThreadShelf Enhanced. All adaptations are
transient display operations; no archive source is rewritten.

Legacy `cite`, `entity`, image and URL marker payload contracts also follow the
supplied **ChatGPT Export Processor GUI 1.1.0** source (MIT; notice in `licenses/`).
They enter the same bounded display parser, including code-fence protection;
unsupported markers remain source. This is not a wholesale Processor conversion.

The image controller, size-aware layout and six placeholder designs are adapted
from the supplied **ThreadShelf Local Reader 4.0.0 revision 5** (MIT, same retained
Reader notice): Corner aperture and Soft horizon for unavailable sources, compact
and wide download-arrow controls, and compact and wide failed-load artwork.
`markdown-images.js` and `markdown-images.css` retain that geometry and lifecycle.
The Enhanced adapter routes explicit external image URLs through its local server,
supports optional server-side collection caches, and offers click or automatic
loading. Images stay within the conversation and never act as navigation links.
No image search query is executed and no URL is invented.

Enhanced 1.3.0 adds basic Markdown as a per-message-role alternative to full rich
formatting. Both modes sanitize archived content and preserve original source for
copy/export. Basic mode retains standard formatting and inert HTML formatting
tags, while equations, diagram source and custom rich components remain source.
Collapsed messages use bounded previews and offscreen formatting is deferred.

The bundled offline assets in `client/public/renderer` are MathJax 3.2.1
(Apache-2.0) and Mermaid 11.17.2 (MIT). MathJax remains the verified original
asset used by the Local Reader. ThreadShelf Enhanced 1.1.0 rebuilds Mermaid from
its original sources and generated grammar inputs with patched DOMPurify,
js-yaml, KaTeX and Lodash dependencies. The separate locked build recipe is
`scripts/rebuild-renderer.py`; exact versions, hashes and nested components are
recorded in `licenses/`. Their original notices and the Reader license are retained.
`marked` and `highlight.js` are pinned to the Reader's versions; their notices are
also retained. The application continues to use the upstream light/dark palette.

Only the observed, bounded rich vocabulary is supported. Unsupported components,
unsafe HTML/JavaScript, oversized rich data, failed diagrams and failed equations
remain readable source or inert placeholders. Local image identifiers need a
matching resolved archive asset; private filesystem and sandbox links are not
served or guessed.

See [bundled asset notices](licenses/BUNDLED-ASSET-NOTICES.md) for complete
licenses, copyright notices and verified asset provenance.

Enhanced 1.4.1 adapts standalone SVG eligibility and inert preview rules from the
**ThreadShelf Local Reader** SVG adapter (`svg-preview.cjs`), and
the token-preserving JSON presentation/empty-thoughts policy from its reader
sources. The JSON adapter is `client/src/json-response.js`; SVG validation is
`svg-preview.js`. The existing Reader MIT license and copyright notice remain
unchanged in `licenses/ThreadShelf-Local-Reader-LICENSE.txt`. Enhanced adds browser
preferences, duplicate-key ambiguity checks for hiding, and its React lifecycle
integration. These additions do not replace or modify existing license holders.

Enhanced 1.4.2 adapts native ChatGPT marker/context handling, bounded Grok
protocol presentation, and the display-only file-reference suffix catalogue
from **ThreadShelf Local Reader**, Copyright (c) 2026 davoda1, under the
retained license in `licenses/ThreadShelf-Local-Reader-LICENSE.txt`. The document
icon source is retained in `assets/file-document.svg`; its visible paths are
normalized as a theme-aware mask in `provider-rendering.css`.

Enhanced preserves its existing image-slot and local image-cache boundaries,
explicit source metadata bindings, code controls and server theme tokens. New
provider interface strings are localized in `provider-locale.js`; archived text
is never translated. `docs/RENDERING-1.4.2.md` describes the supported protocols
and inert fallbacks.
