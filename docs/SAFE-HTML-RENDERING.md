# Safe HTML formatting in conversations

ThreadShelf Enhanced 1.4.2 expands the same HTML formatting path for user and assistant
bubbles. Original conversation text remains unchanged for copying and exports.
Inline code, fenced code and escaped HTML are source text.

Existing inert headings, paragraphs, lists, tables, emphasis, underline, `mark`,
superscript, subscript, `pre`, `code` and `kbd` remain supported. Added formatting
includes `span`, `div`, `small`, `abbr`, `time`, `details`/`summary`, definition
lists, `samp`, `var`, `wbr` and explicit safe links.

The accepted inline CSS properties are `color`, `background-color`, `font-weight`,
`font-style`, `text-decoration`, `text-decoration-line`, `text-align` and
`vertical-align`. Colors support standard names, hexadecimal values and bounded
numeric RGB/HSL forms. For example:

```html
<span style="color:#e64340;background-color:#a8c0ff">color</span>
```

HTML attributes are a separate allowlist: `title`, valid `lang`/`dir`, safe link
`href`, bounded table/list metadata, `time datetime` and `details open`.
Links accept HTTP, HTTPS, mailto and explicit fragment identifiers. HTTP(S)
credentials are rejected; links receive `noopener noreferrer` and open separately.

Unsupported tags, malformed markup, or tags containing unsupported attributes or
CSS remain visible source. No archived classes, IDs, event handlers, data
attributes, forms, scripts, stylesheets, SVG/MathML markup, embedded documents,
media tags, CSS resource URLs, positioning, animations, or application selectors
are admitted by this path. Markdown images retain the existing controlled image
loader; fenced SVG retains its separate inert image preview.

The HTML-token formatter reconstructs a deliberately small grammar without
parsing archived markup into a live DOM. The final DOM sanitizer repeats style
and attribute checks. This is a formatting subset, not a general HTML/CSS viewer.
