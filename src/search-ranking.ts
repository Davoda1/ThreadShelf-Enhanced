import type { SearchResult } from './store.js';

/** A stable identity shared only by ranking, never a replacement for public IDs. */
export const searchIdentity = (row: SearchResult): string =>
  JSON.stringify([
    row.metadata.collection ?? '',
    row.metadata.sourceFile,
    row.metadata.conversationKey ?? '',
    row.metadata.turnIndex,
    row.id,
  ]);

export const stableSearchTie = (a: SearchResult, b: SearchResult): number => {
  const left = searchIdentity(a),
    right = searchIdentity(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

/** Keep only the best k results while visiting every eligible row. */
export class TopResults<T> {
  private readonly heap: T[] = [];
  constructor(
    private readonly limit: number,
    private readonly compare: (a: T, b: T) => number,
  ) {}
  add(value: T): void {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(value);
      let i = this.heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this.compare(this.heap[parent]!, this.heap[i]!) >= 0) break;
        [this.heap[parent], this.heap[i]] = [this.heap[i]!, this.heap[parent]!];
        i = parent;
      }
      return;
    }
    if (this.compare(value, this.heap[0]!) >= 0) return;
    this.heap[0] = value;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1,
        right = left + 1;
      let worst = i;
      if (left < this.heap.length && this.compare(this.heap[left]!, this.heap[worst]!) > 0)
        worst = left;
      if (right < this.heap.length && this.compare(this.heap[right]!, this.heap[worst]!) > 0)
        worst = right;
      if (worst === i) break;
      [this.heap[i], this.heap[worst]] = [this.heap[worst]!, this.heap[i]!];
      i = worst;
    }
  }
  values(): T[] {
    return [...this.heap].sort(this.compare);
  }
}

export const normalizeLexical = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export const lexicalTerms = (text: string): string[] =>
  [...new Set(normalizeLexical(text).match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32);

/** Saturated term frequency avoids making long repeated passages dominate. */
export const lexicalScore = (row: SearchResult, query: string): number => {
  const text = normalizeLexical(row.document);
  const title = normalizeLexical(row.metadata.title ?? '');
  const phrase = normalizeLexical(query.trim());
  const terms = lexicalTerms(query);
  if (!phrase || !terms.length) return text.includes(phrase) && phrase ? 1 : 0;
  const tokens = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const titleTokens = new Set(title.match(/[\p{L}\p{N}]+/gu) ?? []);
  let score = 0,
    matched = 0;
  for (const term of terms) {
    const count = counts.get(term) ?? 0;
    if (count || titleTokens.has(term)) matched++;
    score += count / (count + 1.2 + tokens.length / 350);
    if (titleTokens.has(term)) score += 1.5;
  }
  if (!matched) return 0;
  score += (3 * matched) / terms.length;
  if (text.includes(phrase)) score += 4;
  if (title.includes(phrase)) score += 6;
  // Complete code identifiers/paths matter more than separate component words.
  if (/[\d_./:-]/u.test(query) && text.includes(phrase)) score += 3;
  return score;
};

export const lexicalResultComparator =
  (query: string) =>
  (a: SearchResult, b: SearchResult): number =>
    lexicalScore(b, query) - lexicalScore(a, query) || stableSearchTie(a, b);

/** Independent retrieval lists are fused; lexical matches are never limited to a vector window. */
export const fuseSearchResults = (
  semantic: readonly SearchResult[],
  lexical: readonly SearchResult[],
  query: string,
  n: number,
): SearchResult[] => {
  const entries = new Map<string, { row: SearchResult; score: number }>();
  const add = (rows: readonly SearchResult[], weight: number) =>
    rows.forEach((row, index) => {
      const key = searchIdentity(row);
      const entry = entries.get(key) ?? { row, score: 0 };
      entry.score += weight / (60 + index + 1);
      if (row.distance !== undefined) entry.row = row;
      entries.set(key, entry);
    });
  add(semantic, 1);
  add(lexical, 1.15);
  const ranked = [...entries.values()]
    .map((entry) => ({
      ...entry,
      score: entry.score + Math.min(lexicalScore(entry.row, query), 18) * 0.0004,
    }))
    .sort((a, b) => b.score - a.score || stableSearchTie(a.row, b.row));
  // First pass spreads results across conversations and repeated chunk content.
  // Deferred hits are still available when there are fewer distinct conversations.
  const counts = new Map<string, number>(),
    texts = new Set<string>();
  const selected: SearchResult[] = [],
    deferred: SearchResult[] = [];
  for (const { row } of ranked) {
    const conversation = JSON.stringify([
      row.metadata.collection,
      row.metadata.sourceFile,
      row.metadata.conversationKey,
    ]);
    const text = row.document.normalize('NFC').replace(/\s+/g, ' ').trim();
    if ((counts.get(conversation) ?? 0) >= 2 || texts.has(text)) {
      deferred.push(row);
      continue;
    }
    selected.push(row);
    texts.add(text);
    counts.set(conversation, (counts.get(conversation) ?? 0) + 1);
  }
  return [...selected, ...deferred].slice(0, n);
};
