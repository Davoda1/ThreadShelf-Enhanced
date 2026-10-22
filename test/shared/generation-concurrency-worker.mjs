// Synthetic native-store worker. Filesystem gates make overlapping legacy repairs
// reproducible without a real model, user archive, or external service.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [mode, id] = process.argv.slice(2);
const sourceFile = `threadshelf://chat/${id}`;
const collection = 'threadshelf_conversations';
const store = await import('../../src/store.ts');
const chats = await import('../../src/generation/threads.ts');
const send = (message) => process.send?.(message);
if (mode === 'normalize' || mode === 'migrate') {
  // Pause immediately after decoding the snapshot read from the native store,
  // before its repair reaches a write API. Pausing at the write itself would
  // miss a stale snapshot obtained before the write lock was acquired.
  const original = JSON.parse;
  let intercepted = false;
  JSON.parse = function (text, ...rest) {
    const value = original.call(this, text, ...rest);
    if (!intercepted && text === '[{"user":"A"}]') {
      intercepted = true;
      send({ event: 'paused' });
      const deadline = Date.now() + 20_000;
      const gate = join(process.env.THREADSHELF_DATA_DIR, `${id}-release`);
      while (!existsSync(gate)) {
        if (Date.now() > deadline) throw new Error('Synthetic worker gate timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return value;
  };
}

try {
  send({ event: 'started' });
  if (mode !== 'append') await chats.getThreadShelfChat(id);
  if (mode === 'append' || mode === 'get-and-append') {
    await store.updateStoredThreadFromCurrent(collection, sourceFile, id, (current) => ({
      provider: current.provider,
      conversation: {
        key: id,
        title: current.title,
        turns: [...JSON.parse(current.turnsJson), { ai: 'B', createdInThreadShelf: true }],
        createdInThreadShelf: true,
        threadCreatedAt: current.threadCreatedAt,
      },
    }));
  }
  send({ event: 'done' });
} catch (error) {
  send({ event: 'failed', message: error.stack || String(error) });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
