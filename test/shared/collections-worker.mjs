// Synthetic subprocess fixture for registry races and real HTTP upload/deletion routes.
import express from 'express';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, basename } from 'node:path';

const mode = process.argv[2];
const collections = await import('../../src/services/collections.ts');

if (mode === 'registry-rename') {
  const fault = JSON.parse(process.argv[3]);
  const registry = process.env.COLLECTIONS_PATH;
  const originalRename = fs.rename;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const clockDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  const error = Object.assign(new Error('Injected registry rename failure'), { code: fault.code });
  const snapshots = [];
  let attempts = 0;
  let clock = 0;
  process.send({ kind: 'ready' });
  await new Promise((resolve) => process.once('message', resolve));
  Object.defineProperty(process, 'platform', { value: fault.platform });
  if (fault.advanceClockMs)
    Object.defineProperty(performance, 'now', { configurable: true, value: () => clock });
  fs.rename = async (temporary, destination) => {
    if (destination !== registry) return originalRename(temporary, destination);
    attempts++;
    snapshots.push({
      temporary: JSON.parse(await fs.readFile(temporary, 'utf8')),
      destination: JSON.parse(await fs.readFile(destination, 'utf8')),
    });
    if (attempts <= fault.failures) {
      clock += fault.advanceClockMs || 0;
      throw error;
    }
    return originalRename(temporary, destination);
  };
  syncBuiltinESMExports();
  let outcome;
  try {
    await collections.addManualCollection('new_entry');
    outcome = { status: 'fulfilled' };
  } catch (caught) {
    outcome = { status: 'rejected', code: caught.code, originalError: caught === error };
  } finally {
    fs.rename = originalRename;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (clockDescriptor) Object.defineProperty(performance, 'now', clockDescriptor);
    else delete performance.now;
  }
  const after = await collections.readManualCollections();
  const temporaryFiles = (await fs.readdir(dirname(registry))).filter(
    (name) => name.startsWith(basename(registry) + '.') && name.endsWith('.tmp'),
  );
  // A failed publication must release its registry lock for the next writer.
  await collections.addManualCollection('followup');
  process.send({
    kind: 'result',
    results: {
      outcome,
      attempts,
      snapshots,
      after,
      temporaryFiles,
      followup: await collections.readManualCollections(),
    },
  });
  process.disconnect();
} else if (mode === 'registry') {
  const operations = JSON.parse(process.argv[3]);
  process.send({ kind: 'ready' });
  await new Promise((resolve) => process.once('message', resolve));
  const results = await Promise.allSettled(
    operations.map(({ operation, name, names }) => {
      if (operation === 'add') return collections.addManualCollection(name);
      if (operation === 'remove') return collections.removeManualCollection(name);
      if (operation === 'write') return collections.writeManualCollections(names);
      throw new Error('Unknown fixture operation');
    }),
  );
  process.send({
    kind: 'result',
    results: results.map((result) => ({
      status: result.status,
      ...(result.status === 'rejected' ? { error: String(result.reason) } : {}),
    })),
  });
  process.disconnect();
} else if (mode === 'http') {
  const { default: collectionRouter } = await import('../../src/routes/collections.ts');
  const { default: ingestRouter } = await import('../../src/routes/ingest.ts');
  const app = express();
  app.use(express.json());
  app.use(collectionRouter);
  app.use(ingestRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  process.send({ kind: 'ready', baseUrl: `http://127.0.0.1:${server.address().port}` });
  await new Promise((resolve) => process.once('message', resolve));
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  process.disconnect();
} else {
  throw new Error('Unknown fixture mode');
}
