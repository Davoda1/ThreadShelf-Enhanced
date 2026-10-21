function firstMeaningfulLine(source) {
  for (const rawLine of String(source || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('%%')) continue;
    return line;
  }
  return '';
}

function diagramType(source) {
  const line = firstMeaningfulLine(source);
  if (!line) return 'other';
  const keyword = line.split(/\s+/, 1)[0].toLowerCase();
  if (keyword === 'sequencediagram') return 'sequence';
  if (keyword === 'flowchart' || keyword === 'graph') return 'flowchart';
  if (keyword === 'xychart-beta') return 'xychart';
  if (keyword === 'bar') return 'legacy-bar';
  return 'other';
}

function sequenceArrowPrefix(prefix) {
  return /(?:--?|==?)(?:>>|>|x|\)|o)/.test(prefix);
}

function looksLikeSequenceFragment(source) {
  return String(source || '').split(/\r?\n/).some((line) => {
    const colon = line.indexOf(':');
    return colon > 0 && sequenceArrowPrefix(line.slice(0, colon));
  });
}

function looksLikeFlowchartFragment(source) {
  const meaningful = String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));

  if (!meaningful.length) return false;
  if (meaningful.some((line) => /(?:-->|---|-.->|==>)/.test(line))) return true;
  return meaningful.every((line) => /^[A-Za-z_][A-Za-z0-9_.-]*\s*(?:\[|\{|\(|>)/.test(line));
}

function withInferredHeader(source, type) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  if (type === 'sequence') return `sequenceDiagram${newline}${source}`;
  if (type === 'flowchart') return `flowchart TD${newline}${source}`;
  return source;
}

function repairSequenceDiagram(source, { normalizeQuotedText = false } = {}) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;

  const lines = source.split(/\r?\n/).map((line) => {
    let repaired = line;

    if (normalizeQuotedText) {
      repaired = repaired.replace(
        /^(\s*(?:participant|actor)\s+\S+\s+as\s+)"([^"]*)"\s*$/i,
        (match, prefix, alias) => {
          changed = true;
          return `${prefix}${alias}`;
        },
      );
    }

    const colon = repaired.indexOf(':');
    if (colon < 0) return repaired;

    const prefix = repaired.slice(0, colon);
    if (!sequenceArrowPrefix(prefix)) return repaired;

    let message = repaired.slice(colon + 1);
    if (message.includes(';')) {
      message = message.replace(/#59;|;/g, (token) => (token === ';' ? '#59;' : token));
      changed = true;
    }

    if (normalizeQuotedText) {
      const leading = message.match(/^\s*/)?.[0] || '';
      const body = message.slice(leading.length);
      if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
        message = `${leading}${body.slice(1, -1)}`;
        changed = true;
      }
    }

    return `${repaired.slice(0, colon + 1)}${message}`;
  });

  return changed ? lines.join(newline) : source;
}

function quoteSquareBracketLabels(source, { quoteAll = false } = {}) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;

  const lines = source.split(/\r?\n/).map((line) => line.replace(
    /(\b[A-Za-z_][A-Za-z0-9_.-]*\s*)\[([^\]\r\n]*)\]/g,
    (match, nodePrefix, rawLabel) => {
      const label = rawLabel.trim();
      if (!label || /^"[\s\S]*"$/.test(label)) return match;

      // Quoting a square-bracket node label preserves the visible label while
      // shielding punctuation that Mermaid may otherwise interpret as syntax.
      if (!quoteAll && !/[();<>]/.test(label)) return match;

      changed = true;
      const safeLabel = label.replace(/"/g, '&quot;');
      return `${nodePrefix}["${safeLabel}"]`;
    },
  ));

  return changed ? lines.join(newline) : source;
}

function repairLegacyBarChart(source) {
  const lines = String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines[0]?.toLowerCase() !== 'bar') return null;

  let title = '';
  const labels = [];
  const values = [];
  for (const line of lines.slice(1)) {
    const titleMatch = line.match(/^title\s+(.+)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    const valueMatch = line.match(/^(.+?)\s+(-?(?:\d+(?:\.\d+)?|\.\d+))$/);
    if (!valueMatch) return null;
    labels.push(valueMatch[1].trim());
    values.push(Number(valueMatch[2]));
  }

  if (!labels.length || values.some((value) => !Number.isFinite(value))) return null;
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  if (min === max) return null;

  const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const output = ['xychart-beta'];
  if (title) output.push(`  title ${quote(title)}`);
  output.push(`  x-axis [${labels.map(quote).join(', ')}]`);
  output.push(`  y-axis ${min} --> ${max}`);
  output.push(`  bar [${values.join(', ')}]`);
  return output.join('\n');
}

function uniqueChangedCandidates(original, candidates) {
  const seen = new Set([original]);
  const result = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

export function buildMermaidRepairCandidates(source = '') {
  const original = String(source || '');
  if (!original.trim()) return [];

  let type = diagramType(original);
  let base = original;
  const candidates = [];

  if (type === 'other' && looksLikeSequenceFragment(original)) {
    type = 'sequence';
    base = withInferredHeader(original, 'sequence');
    candidates.push(base);
  } else if (type === 'other' && looksLikeFlowchartFragment(original)) {
    type = 'flowchart';
    base = withInferredHeader(original, 'flowchart');
    candidates.push(base);
  }

  if (type === 'sequence') {
    const minimal = repairSequenceDiagram(base);
    candidates.push(minimal);
    candidates.push(repairSequenceDiagram(minimal, { normalizeQuotedText: true }));
  } else if (type === 'flowchart') {
    const minimal = quoteSquareBracketLabels(base);
    candidates.push(minimal);
    candidates.push(quoteSquareBracketLabels(minimal, { quoteAll: true }));
  } else if (type === 'legacy-bar') {
    candidates.push(repairLegacyBarChart(original));
  }

  return uniqueChangedCandidates(original, candidates);
}

export function buildMermaidRepairCandidate(source = '') {
  return buildMermaidRepairCandidates(source)[0] || null;
}
