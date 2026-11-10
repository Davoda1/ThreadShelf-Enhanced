// Venice exports use caret + decimal digits + caret, not XML or JSON.
// A number alone cannot identify a source URL. Keep it an inert reference label.
export function createVeniceCitationExtension({ t = value => value } = {}) {
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return {
    extensions: [{
      name: 'veniceCitation',
      level: 'inline',
      start(source) { return source.search(/\^\d{1,12}\^/); },
      tokenizer(source) {
        // Marked handles fenced/inline code and backslash escapes first; math is
        // protected by the shared renderer before this inline token is parsed.
        if (this.lexer.state.inRawBlock) return;
        const match = /^\^(\d{1,12})\^/.exec(source);
        if (!match) return;
        return { type: 'veniceCitation', raw: match[0], number: match[1] };
      },
      renderer(token) {
        return `<span class="venice-citation" title="${escape(token.raw)} · ${escape(t('Source unavailable'))}" aria-label="${escape(token.raw)}">${token.number}</span>`;
      },
    }],
  };
}
