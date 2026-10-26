import {
  withCollectionMutationGuard,
  withIndexOperation,
  withServerInstance,
} from '../../src/indexing-coordinator.js';

const mode = process.argv[2];
const collection = process.argv[3] || 'alpha';
const hold = () =>
  new Promise((resolve) => {
    process.send?.({ state: 'owned' });
    process.once('message', resolve);
  });
try {
  if (mode === 'server') await withServerInstance(hold);
  else if (mode === 'index' || mode === 'clear') {
    await withIndexOperation(collection, mode === 'clear', hold, { timeoutMs: 0 });
  } else if (mode === 'write') {
    await withCollectionMutationGuard(collection, async () => process.send?.({ state: 'written' }));
  } else if (mode === 'hold-write') {
    await withCollectionMutationGuard(collection, hold);
  } else if (mode === 'clear-cancel') {
    await withIndexOperation(collection, true, async () => process.send?.({ state: 'written' }), {
      signal: AbortSignal.timeout(100),
    });
  } else if (mode === 'expired-clear') {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let detached;
    await withIndexOperation(collection, true, async () => {
      detached = new Promise((resolve, reject) =>
        setTimeout(() => {
          void gate
            .then(() =>
              withCollectionMutationGuard(collection, async () =>
                process.send?.({ state: 'written' }),
              ),
            )
            .then(resolve, reject);
        }, 1),
      );
    });
    process.send?.({ state: 'released' });
    process.once('message', release);
    await detached;
  } else if (mode === 'nested') {
    await withIndexOperation(collection, true, () =>
      withIndexOperation(collection, true, () =>
        withCollectionMutationGuard(collection, async () => process.send?.({ state: 'written' })),
      ),
    );
  } else throw new Error('Unknown worker operation');
  process.exit(0);
} catch (error) {
  process.send?.({ state: 'rejected', code: error.code, message: error.message });
  process.exit(17);
}
