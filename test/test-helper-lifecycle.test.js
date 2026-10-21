import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { ingestViaNdjson, stopChildProcess, waitForHealth } from './shared/helpers.js';

const httpFixture = async (t, handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
};

const readyChild = async (t, script) => {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  t.after(() => {
    child.kill('SIGKILL');
    for (const stream of child.stdio) stream?.destroy();
    child.unref();
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Test child did not become ready')), 5000);
    const finish = (error) => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.stdout.off('data', onData);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(`Child exited early: ${code}/${signal}`));
    const onData = () => {
      if (output.includes('ready')) finish();
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', onData);
  });
  return { child, output: () => output };
};

test('ingest helper keeps existing arguments and parses a completed NDJSON response', async (t) => {
  let requestBody = '';
  const baseUrl = await httpFixture(t, (req, res) => {
    assert.equal(req.url, '/api/ingest-progress');
    req.on('data', (chunk) => {
      requestBody += chunk;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end('\n{"status":"started"}\n{"status":"completed","result":{"ingested":2}}\n');
    });
  });
  assert.deepEqual(await ingestViaNdjson(baseUrl, '/synthetic-exports', 'example', false), {
    ingested: 2,
  });
  assert.deepEqual(JSON.parse(requestBody), {
    folderPath: '/synthetic-exports',
    collection: 'example',
    clearFirst: false,
  });
});

for (const sendHeaders of [false, true]) {
  test(
    `ingest helper aborts stalled ${sendHeaders ? 'NDJSON bodies' : 'response headers'}`,
    { timeout: 10000 },
    async (t) => {
      let closeResponse;
      const responseClosed = new Promise((resolve) => {
        closeResponse = resolve;
      });
      const baseUrl = await httpFixture(t, (req, res) => {
        req.resume();
        res.once('close', closeResponse);
        if (sendHeaders) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write('{"status":"started"}\n');
        }
      });
      await assert.rejects(
        ingestViaNdjson(baseUrl, '/synthetic-exports', 'example', true, { timeoutMs: 750 }),
        /Ingest timed out after 750 ms.*\/api\/ingest-progress.*example/,
      );
      await responseClosed;
    },
  );
}

test(
  'health checks also stop when response headers never arrive',
  { timeout: 10000 },
  async (t) => {
    const baseUrl = await httpFixture(t, (req) => req.resume());
    await assert.rejects(waitForHealth(baseUrl, 750), /did not become healthy within 750 ms/);
  },
);

test('ingest HTTP failures retain their actual status instead of becoming timeouts', async (t) => {
  const baseUrl = await httpFixture(t, (req, res) => {
    req.resume();
    res.writeHead(503);
    res.end('temporarily unavailable');
  });
  await assert.rejects(
    ingestViaNdjson(baseUrl, '/synthetic-exports', 'example'),
    /Ingest failed: 503/,
  );
});

test(
  'child shutdown waits for close and removes its listener after normal termination',
  { timeout: 10000 },
  async (t) => {
    const { child, output } = await readyChild(
      t,
      `process.on('SIGTERM', () => {
      console.log('cleanup-complete');
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    console.log('ready');`,
    );
    await stopChildProcess(child);
    if (process.platform !== 'win32') {
      assert.equal(child.exitCode, 0);
      assert.match(output(), /cleanup-complete/);
    }
    assert.equal(child.listenerCount('close'), 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    // Repeated cleanup of an already-exited child must not add an orphan listener.
    await stopChildProcess(child);
    assert.equal(child.listenerCount('close'), 0);
  },
);

test(
  'child shutdown escalates to SIGKILL when SIGTERM is ignored',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const { child } = await readyChild(
      t,
      `process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      console.log('ready');`,
    );
    await stopChildProcess(child, { termTimeoutMs: 750, killTimeoutMs: 2000 });
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.listenerCount('close'), 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  },
);

test(
  'a child whose pipes never close cannot keep teardown waiting indefinitely',
  { timeout: 10000 },
  async () => {
    const child = new EventEmitter();
    const signals = [];
    let destroyed = false;
    let unreferenced = false;
    Object.assign(child, {
      // The process has exited, but an inherited pipe still prevents close.
      exitCode: 0,
      signalCode: null,
      pid: 123,
      kill: (signal) => signals.push(signal),
      stdio: [{ destroy: () => (destroyed = true) }],
      unref: () => (unreferenced = true),
    });
    await assert.rejects(
      stopChildProcess(child, { termTimeoutMs: 250, killTimeoutMs: 250 }),
      /did not close after SIGTERM \(250 ms\) and SIGKILL \(250 ms\)/,
    );
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(destroyed, true);
    assert.equal(unreferenced, true);
    assert.equal(child.listenerCount('close'), 0);
  },
);
