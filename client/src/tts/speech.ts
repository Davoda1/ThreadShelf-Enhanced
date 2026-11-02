import { marked, type Token } from 'marked';
/** Full-source extraction: collapsed or lazily rendered bubbles never truncate speech. */
export function extractSpeech(
  markdown: string,
  settings: { readCode: boolean; readCitations: boolean },
): string {
  const walk = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        const value = token as Token & {
          tokens?: Token[];
          items?: { tokens: Token[] }[];
          header?: { tokens: Token[] }[];
          rows?: { tokens: Token[] }[][];
          text?: string;
        };
        if (token.type === 'code') return settings.readCode ? `${value.text ?? ''}\n` : '\n';
        if (token.type === 'html')
          return (value.text ?? '')
            .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
            .replace(/<[^>]*>/g, ' ');
        if (token.type === 'list')
          return (value.items ?? []).map((item) => walk(item.tokens)).join('\n');
        if (token.type === 'table')
          return [value.header ?? [], ...(value.rows ?? [])]
            .map((row) => row.map((cell) => walk(cell.tokens)).join('; '))
            .join('\n');
        if (token.type === 'image') return value.text ?? '';
        const text = value.tokens
          ? walk(value.tokens)
          : (value.text ?? (token.type === 'space' || token.type === 'br' ? '\n' : ''));
        return (
          text +
          (['heading', 'paragraph', 'blockquote', 'list_item'].includes(token.type) ? '\n' : '')
        );
      })
      .join('');
  let text = walk(marked.lexer(markdown.replace(/\r\n?/g, '\n')));
  if (!settings.readCitations) text = text.replace(/[^]*|\[\^([^\]]+)\]/g, '');
  return text
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[
          entity
        ] ?? entity,
    )
    .normalize('NFC')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
/** SHA-256 fallback also supports private HTTP LAN origins without WebCrypto.subtle. */
export async function fingerprint(text: string): Promise<{ version: 1; sha256: string }> {
  const bytes = new TextEncoder().encode(text.replace(/\r\n?/g, '\n').normalize('NFC').trim());
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return {
      version: 1,
      sha256: Array.from(digest, (n) => n.toString(16).padStart(2, '0')).join(''),
    };
  }
  return { version: 1, sha256: sha256(bytes) };
}
export function sha256(bytes: Uint8Array): string {
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const buffer = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(buffer.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(buffer.length - 4, (bytes.length * 8) >>> 0);
  const words = new Uint32Array(64),
    rotate = (n: number, bits: number) => (n >>> bits) | (n << (32 - bits));
  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15]!,
        y = words[i - 2]!;
      words[i] =
        (words[i - 16]! +
          (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
          words[i - 7]! +
          (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
          (h +
            (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i]! +
            words[i]!) >>>
          0,
        t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((n, i) => {
      hash[i] = (hash[i]! + n) >>> 0;
    });
  }
  return hash.map((n) => n.toString(16).padStart(8, '0')).join('');
}
