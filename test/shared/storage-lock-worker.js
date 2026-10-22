import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withInterprocessLock } from '../../src/interprocess-lock.ts';

const options = JSON.parse(process.argv[2]);
const send = (message) => process.send?.(message);
const waitForMessage = (type) =>
  new Promise((resolve) => {
    const listener = (message) => {
      if (message.type === type) {
        process.off('message', listener);
        resolve();
      }
    };
    process.on('message', listener);
  });

try {
  if (options.mode === 'lock') {
    send({ type: 'ready' });
    await withInterprocessLock(options.resource, async () => {
      const released = waitForMessage('release');
      send({ type: 'acquired' });
      await released;
    });
  } else {
    const store = await import('../../src/store.ts');
    send({ type: 'ready' });
    if (options.readFirst) await store.getStoredThreads(options.collection, options.sourceFile);
    for (let index = 0; index < (options.count ?? 1); index++) {
      await store.updateStoredThreadFromCurrent(
        options.collection,
        options.sourceFile,
        options.key,
        (current) => {
          if (options.barrier) {
            writeFileSync(join(options.barrier, options.label + '-read'), 'read');
            const deadline = Date.now() + 15_000;
            while (!existsSync(join(options.barrier, options.label + '-release'))) {
              if (Date.now() > deadline) throw new Error('Synthetic writer barrier timed out');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          }
          return {
            provider: current.provider,
            conversation: {
              key: current.conversationKey,
              title: current.title,
              turns: [
                ...JSON.parse(current.turnsJson),
                { ai: options.label + '-' + index, createdInThreadShelf: true },
              ],
            },
          };
        },
      );
    }
  }
  send({ type: 'done' });
  process.disconnect?.();
} catch (error) {
  send({ type: 'error', error: error.stack || String(error) });
  process.exitCode = 1;
  process.disconnect?.();
}
