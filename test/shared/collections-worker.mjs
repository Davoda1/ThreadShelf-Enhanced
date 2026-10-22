// Synthetic subprocess fixture for registry races and real HTTP upload/deletion routes.
import express from 'express';

const mode = process.argv[2];
const collections = await import('../../src/services/collections.ts');

if (mode === 'registry') {
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
