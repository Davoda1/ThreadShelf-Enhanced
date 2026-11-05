# Conversation display

Open **Settings → Server → Conversation display**. Changes apply immediately and
are saved for the current browser. Each option has its own explanatory panel.
These settings affect reading presentation; original conversation data remains
available to storage, search, speech, copying and exports.

## JSON-only responses

**Response visibility** applies to AI responses that contain only JSON:

| Setting | Behavior |
| --- | --- |
| Show all | Keep all JSON-only responses visible. |
| Hide empty (default) | Hide recognized empty export metadata. Meaningful values such as `0` and `false`, unknown structures, malformed JSON and duplicate-key content remain visible. |
| Hide all | Hide JSON-only AI responses from the reader. |

**Render JSON as code** is on by default. Visible JSON-only responses appear as
JSON code blocks; turn it off to retain their original formatting. Formatting
preserves numeric tokens, including large integers, and duplicate keys.

Messages with separate reasoning content and messages containing assets retain
their existing visibility safeguards. These display options never delete messages.

## Code blocks

| Setting | Default | Behavior |
| --- | --- | --- |
| Show code download button | On | Download the code's original text using the registered language or alias extension; plain text and unknown labels use `.txt`. |
| Wrap long code lines | Off | Off uses horizontal scrolling; on wraps long lines within the code block. |
| Show code line numbers | Off | Add a reading gutter that is excluded from selection, copied code, downloads and conversation exports. |

Automatically formatted JSON downloads use the displayed JSON text. Mermaid
downloads use the selected original or repaired source. See the complete
[language and filename extension catalog](CODE-DOWNLOAD-EXTENSIONS.md).

Copy stays at the far right of the toolbar. When enabled, Download sits immediately
to its left. Padding keeps text and controls clear of the code-block edges.

## Standalone SVG

Eligible code blocks offer **Render/Code** views. The block must be untagged,
`svg` or `xml` and contain a valid standalone SVG, with only whitespace or comments
outside it. Supported Base64 SVG is validated after decoding. HTML containing an
embedded SVG and malformed documents remain code.

The preview is displayed as an inert image. Copy and Download keep the original
source, and existing rich/basic rendering preferences continue to apply.
