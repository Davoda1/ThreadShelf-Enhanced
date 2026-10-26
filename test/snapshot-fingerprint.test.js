import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFingerprint } from '../src/snapshot-fingerprint.ts';

const archivedRow = () => ({
  collection: 'synthetic',
  sourceFile: 'fixture.json',
  conversationKey: 'conversation-1',
  title: 'Synthetic thread',
  turnsJson: JSON.stringify([{ user: 'Hello' }, { ai: 'A synthetic answer' }]),
  rawJson: JSON.stringify({ nested: { text: 'Preserved raw export' } }),
  sourceIdentityJson: JSON.stringify({ id: 'source-1' }),
  ordinal: 0,
  createdInThreadShelf: false,
  indexPending: 'all',
  indexAttempts: 0,
  indexRetryAt: 0,
  indexError: '',
});

describe('stored snapshot fingerprints', () => {
  it('is deterministic and does not depend on database row order', () => {
    const rows = [archivedRow(), { ...archivedRow(), conversationKey: 'conversation-2' }];
    const expected = snapshotFingerprint(rows);
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.equal(snapshotFingerprint(structuredClone(rows)), expected);
    assert.equal(snapshotFingerprint([...rows].reverse()), expected);
  });

  it('detects changes to all persisted fields, including raw exports and pending jobs', () => {
    const original = archivedRow();
    const before = snapshotFingerprint([original]);
    for (const [key, value] of Object.entries(original)) {
      const replacement = typeof value === 'boolean' ? !value : `${value}-changed`;
      assert.notEqual(snapshotFingerprint([{ ...original, [key]: replacement }]), before, key);
    }
    assert.notEqual(snapshotFingerprint([{ ...original, additionalMetadata: 'new' }]), before);
    const removed = { ...original };
    delete removed.title;
    assert.notEqual(snapshotFingerprint([removed]), before);
  });

  it('detects added, removed and duplicated rows rather than treating rows as a set', () => {
    const first = archivedRow();
    const second = { ...first, conversationKey: 'conversation-2' };
    const empty = snapshotFingerprint([]);
    assert.notEqual(snapshotFingerprint([first]), empty);
    assert.notEqual(snapshotFingerprint([first, first]), snapshotFingerprint([first]));
    assert.notEqual(snapshotFingerprint([first, second]), snapshotFingerprint([first, first]));
    assert.notEqual(
      snapshotFingerprint([first, second, second]),
      snapshotFingerprint([first, first, second]),
    );
    assert.equal(
      snapshotFingerprint([second, first, second]),
      snapshotFingerprint([first, second, second]),
    );
  });

  it('does not mutate the input array or rows', () => {
    const first = Object.freeze(archivedRow());
    const second = Object.freeze({ ...archivedRow(), title: 'Second' });
    const rows = Object.freeze([second, first]);
    snapshotFingerprint(rows);
    assert.equal(rows[0], second);
    assert.equal(rows[1], first);
  });

  it('distinguishes escaped text, Unicode, embedded NULs, and field boundaries', () => {
    const values = [
      'quote"',
      'quote\\"',
      '\u0000',
      '\\u0000',
      '日本語 😀',
      '日本語 😃',
      '\ud800',
      '\ud801',
    ];
    const fingerprints = values.map((text) => snapshotFingerprint([{ text }]));
    assert.equal(new Set(fingerprints).size, values.length);
    assert.notEqual(
      snapshotFingerprint([{ a: 'ab', b: 'c' }]),
      snapshotFingerprint([{ a: 'a', b: 'bc' }]),
    );
  });

  it('fails explicitly on unsupported rows rather than accepting an incomplete fingerprint', () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.throws(() => snapshotFingerprint([cyclic]), TypeError);
    assert.throws(() => snapshotFingerprint([{ value: 1n }]), TypeError);
  });

  it('hashes a sizeable collection and detects a late-row edit', () => {
    const row = { ...archivedRow(), rawJson: 'x'.repeat(128 * 1024) };
    const rows = Array(128).fill(row);
    const before = snapshotFingerprint(rows);
    rows[rows.length - 1] = { ...row, title: 'Changed after embedding' };
    assert.notEqual(snapshotFingerprint(rows), before);
  });
});
