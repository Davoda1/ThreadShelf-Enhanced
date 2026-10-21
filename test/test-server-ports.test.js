import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getAvailablePort } from './shared/helpers.js';

test(
  'test ports remain Fetch-compatible and avoid an already-bound fixture',
  { timeout: 10000 },
  async (t) => {
    // The previous 3500 + floor(random * 1000) selection chose 4045 here.
    // Fetch rejects that port before making any HTTP request, regardless of
    // whether a server is listening there, so health polling could never pass.
    t.mock.method(Math, 'random', () => 0.545);
    await assert.rejects(fetch('http://127.0.0.1:4045/api/health'), (error) => {
      assert.equal(error.cause?.message, 'bad port');
      return true;
    });

    const ports = [];
    for (let fixture = 0; fixture < 2; fixture++) {
      const port = await getAvailablePort();
      const server = createServer((_req, res) => res.end(`fixture-${fixture}`));
      t.after(
        () =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      );
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `fixture-${fixture}`);
      ports.push(port);
    }
    assert.notEqual(ports[0], ports[1], 'parallel fixtures must not share a listening port');
  },
);
