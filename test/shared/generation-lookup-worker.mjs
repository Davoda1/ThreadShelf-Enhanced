// Synthetic process boundary for the gap between primary and legacy lookups.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';

const [mode, id] = process.argv.slice(2);
const send = (message) => process.send?.(message);
if (mode === 'pause-legacy') {
  const database = await connect(process.env.LANCEDB_PATH);
  const table = await database.openTable('__threads');
  const prototype = Object.getPrototypeOf(table);
  const original = prototype.query;
  let queries = 0;
  prototype.query = function (...args) {
    // Pause before creating the second native query. Pausing a builder after
    // creation would retain its earlier table snapshot and miss the race.
    if (this.name === '__threads' && ++queries === 2) {
      send({ event: 'paused' });
      const gate = join(process.env.THREADSHELF_DATA_DIR, `${id}-lookup-release`);
      const deadline = Date.now() + 20_000;
      while (!existsSync(gate)) {
        if (Date.now() > deadline) throw new Error('Synthetic lookup gate timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return original.apply(this, args);
  };
}

try {
  const chats = await import('../../src/generation/threads.ts');
  send({ event: 'started' });
  const chat = await chats.getThreadShelfChat(id);
  send({ event: 'done', id: chat.id, turns: chat.turns });
} catch (error) {
  send({ event: 'failed', message: error.stack || String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
