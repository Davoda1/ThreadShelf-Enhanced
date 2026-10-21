import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

test(
  'ONNX installer proxy dependency retains CommonJS bootstrap and loopback bypass',
  { timeout: 20_000 },
  () => {
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^GLOBAL_AGENT_/i.test(name) || /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name))
        delete env[name];
    }
    delete env.NODE_OPTIONS;

    // Isolate the global HTTP agent replacement from the test runner. The proxy
    // returns a synthetic response itself; it never forwards to the .invalid host.
    const script = String.raw`
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const { createRequire } = require('node:module');
    const onnxRequire = createRequire(require.resolve('onnxruntime-node'));
    const { bootstrap } = onnxRequire('global-agent');
    const proxyRequests = [];
    const proxy = http.createServer((req, res) => {
      proxyRequests.push(req.url);
      res.end('through-loopback-proxy');
    });
    const direct = http.createServer((_req, res) => res.end('direct-loopback'));
    const listen = server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server.address().port);
      });
    });
    const close = server => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    });
    const get = url => new Promise((resolve, reject) => {
      const req = http.get(url, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Loopback proxy request timed out')));
    });
    (async () => {
      try {
        const proxyPort = await listen(proxy);
        const directPort = await listen(direct);
        process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + proxyPort;
        process.env.GLOBAL_AGENT_NO_PROXY = '127.0.0.1';
        assert.equal(bootstrap(), true);
        assert.equal(bootstrap(), false);
        const proxied = await get('http://threadshelf-proxy-test.invalid/probe');
        assert.deepEqual(proxied, { status: 200, body: 'through-loopback-proxy' });
        assert.deepEqual(proxyRequests, ['http://threadshelf-proxy-test.invalid/probe']);
        const bypassed = await get('http://127.0.0.1:' + directPort + '/probe');
        assert.deepEqual(bypassed, { status: 200, body: 'direct-loopback' });
        assert.equal(proxyRequests.length, 1, 'Loopback request must bypass the proxy');
        console.log(JSON.stringify({ commonJsBootstrap: true, idempotentBootstrap: true, proxy: true, noProxy: true }));
      } finally {
        await Promise.all([close(proxy), close(direct)]);
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '-e', script], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      commonJsBootstrap: true,
      idempotentBootstrap: true,
      proxy: true,
      noProxy: true,
    });
  },
);
