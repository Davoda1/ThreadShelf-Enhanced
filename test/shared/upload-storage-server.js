import express from 'express';
import uploadsRouter from '../../src/routes/uploads.js';
import { requireLocalOrigin } from '../../src/routes/local-origin.js';

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use('/api', requireLocalOrigin);
app.use(uploadsRouter);
const server = app.listen(0, '127.0.0.1', () => {
  process.send?.({ port: server.address().port });
});
process.once('message', () => {
  server.close();
  server.closeAllConnections();
  process.exit(0);
});
