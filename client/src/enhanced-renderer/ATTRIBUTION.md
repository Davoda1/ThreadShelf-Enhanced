# Renderer provenance

The bounded rich-content parser, rich layout and chart rendering, chart inspection,
code-language adapters (including Fish), citation binding, math delimiter repair,
and deterministic Mermaid repair are adapted from **ThreadShelf Local Reader**, Copyright (c) 2026 davoda1, MIT.
The adjacent licenses preserve the original notices; this attribution does not
claim the adapted implementation is identical to any public release.

`renderer.js` adapts the same Reader's Markdown sanitizer, code controls, Mermaid
fallback/copy/original-versus-repaired controls and clipboard fallback. Its React
mount lifecycle, per-message cleanup, application-token stylesheet bridge and
explicit image loading were added for ThreadShelf Enhanced. All adaptations are
transient display operations; no archive source is rewritten.

Legacy `cite`, `entity`, image and URL marker payload contracts also follow the
**ChatGPT Export Processor GUI** source (MIT; notice in `licenses/`).
They enter the same bounded display parser, including code-fence protection;
unsupported markers remain source. This is not a wholesale Processor conversion.

The original Corner aperture and Soft horizon placeholders remain for missing
images. A saved, validated image URL has a separate download-arrow load control;
no search query is sent, URL invented, or image fetched before a click.

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

See [bundled asset notices](licenses/BUNDLED-ASSET-NOTICES.md) for dependency
licenses, copyright notices, and verified asset provenance.
