# Provider rendering in 1.4.2

These adapters change only the displayed conversation. Stored turns, original
exports, whole-message copy and conversation export retain their exact source.
The existing per-role rich-rendering switches remain in control.

## Grok

The bounded parser recognizes `grok:render`, `grok:richcontent`, `grok`,
`grok-card`, `grok-card-list`, `grok-generated-images`, `grok-file-card-group`,
`xaiArtifact`, `xai:tool_usage_card`, `image-card`, and `file-mention`, including
observed `card_type`, `data-type`, `data-plain-type`, and `data-arg-*` transports.
The legacy Markdown-link transport whose destination starts with
`grok_render_citation_card_json=` is also recognized.

Card metadata is bound only by explicit saved card IDs in the same message's
`cardAttachment`, `cardAttachmentsJson`, `card_attachments_json`, or
`cardAttachments`. Server turns may retain these inside `raw` or `metadata`.
Conflicting IDs are unresolved; numeric citation positions never guess URLs.
References with a safe saved URL are navigable. Missing sources have an inert
label, exact identity and original markup available for inspection.

Images use the existing archived-image slots and local server resource route;
they respect click/automatic image settings and cache policy. Audio, video and
file cards expose validated saved links without loading an embedded player.
Generated UI, app, permission, connector, checkout, location and task cards are
passive archived data. They never run an action or replay permission.

Complete `chartjs` fences with a supported literal Chart.js subset display local
SVG charts and retain the original code. Unsupported semantic options (such as
callbacks, stacking, logarithmic axes or datasets with incompatible geometry)
remain data. `xaitask` fences display passive task data. Ordinary code fences,
inline code, escapes, Markdown links and math are protected from conversion.
Artifacts retain source; Markdown artifacts use the existing safe Markdown
renderer. Standalone SVG artifact source uses the existing inert Render/Code
preview eligibility rules.

## ChatGPT

Native `cite` and `filecite` markers retain exact reference IDs and file line
ranges. Direct webpage/file reference metadata and grouped webpage/file records
are supported in addition to the previous tuple form. File references never
invent attachment URLs. `:codex-file-citation{...}` becomes an inert filename/type
chip; its path is a label and grants no filesystem or network access.

Native navigation lists and complete unknown/future widget families receive
readable archived presentations with their source retained. Supported existing
entities, rich layouts, charts, images, legacy Processor aliases and explicit
links remain supported. Native area and doughnut chart types now use the local
chart renderer; unsupported chart semantics continue to fall back to saved data.

## Bounds and safety

All provider data is literal data, not executable XML, HTML, CSS, JavaScript or
component code. Recognized Grok cards are at most 200,000 characters each;
message parsing and repeated rendered metadata have separate bounded budgets.
The rich parser limits component fragments to 256 and retains original text when
limits or malformed structures prevent a safe presentation. Getters, custom
array iterators, prototype keys, cyclic structures and ambiguous bindings do not
become data sources. Unknown families remain inspectable; actions stay inert.

## VeniceAI and safe HTML

A caret, one to twelve decimal digits, and a closing caret render as a small
soft-square label using the server's theme palette. Adjacent and repeated markers
are supported, including `^1^^12^`. This typography is available in basic and rich
mode. A number alone has no verified source URL: its tooltip retains the original
marker and reports the source unavailable; it never invents a clickable target.
Escaped markers, raw code/preformatted content, fenced and inline code, and
protected math remain source. Original data and whole-message copy are untouched.

[Safe HTML](SAFE-HTML-RENDERING.md) supports inert formatting and limited text
CSS in both user and response bubbles. Unsupported/unsafe attributes are shown as
literal source. HTML cannot supply application classes, event handlers, active
content, external CSS resources or arbitrary overlay/layout styles.
