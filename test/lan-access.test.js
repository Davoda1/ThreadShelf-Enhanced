import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFeatureManagementRequest,
  requireAiManagement,
  requireTtsManagement,
} from '../src/routes/feature-access.js';
import { isLoopbackHttpRequest } from '../src/routes/loopback.js';
import { requireLocalOrigin } from '../src/routes/local-origin.js';

const originalEnv = { ...process.env };
beforeEach(() => {
  delete process.env.ALLOW_LAN_AI;
  delete process.env.ALLOW_LAN_TTS;
  delete process.env.ALLOWED_ORIGINS;
  process.env.HOST = '127.0.0.1';
  process.env.ALLOWED_HOSTS = 'archive.home.arpa';
});
afterEach(() => {
  process.env = { ...originalEnv };
});

const request = ({ address = '192.168.1.23', host = 'archive.home.arpa:3000', headers = {} } = {}) => ({
  socket: { remoteAddress: address },
  hostname: host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0],
  protocol: 'http',
  headers: { host, ...headers },
});
const local = () => request({ address: '127.0.0.1', host: 'localhost:3000' });

const runMiddleware = (middleware, req) => {
  const result = { next: false, status: undefined, body: undefined };
  const res = {
    status(status) { result.status = status; return res; },
    json(body) { result.body = body; return res; },
  };
  middleware(req, res, () => { result.next = true; });
  return result;
};

describe('independent trusted-LAN feature management', () => {
  it('preserves localhost management with both switches absent or off', () => {
    for (const value of [undefined, '0']) {
      if (value === undefined) {
        delete process.env.ALLOW_LAN_AI;
        delete process.env.ALLOW_LAN_TTS;
      } else {
        process.env.ALLOW_LAN_AI = value;
        process.env.ALLOW_LAN_TTS = value;
      }
      for (const [address, host] of [
        ['127.0.0.1', 'localhost:3000'],
        ['::1', '[::1]:3000'],
        ['::ffff:127.0.0.1', '127.0.0.1:3000'],
      ]) {
        const req = request({ address, host });
        assert.equal(isFeatureManagementRequest(req, 'ai'), true);
        assert.equal(isFeatureManagementRequest(req, 'tts'), true);
      }
    }
  });

  it('defaults to refusing non-loopback management even with a localhost Host', () => {
    for (const address of ['192.168.1.23', '10.20.30.40', '::ffff:192.168.1.23', 'fd00::5', '203.0.113.5']) {
      for (const host of ['archive.home.arpa:3000', 'localhost:3000']) {
        const req = request({ address, host });
        assert.equal(isFeatureManagementRequest(req, 'ai'), false);
        assert.equal(isFeatureManagementRequest(req, 'tts'), false);
      }
    }
    assert.equal(isFeatureManagementRequest(request({ address: '127.0.0.1' }), 'ai'), false);
    assert.equal(isFeatureManagementRequest(request({ address: '127.0.0.1' }), 'tts'), false);
  });

  it('enables only the selected feature and immediately respects a disabled switch', () => {
    const req = request();
    for (const [ai, tts, expectedAi, expectedTts] of [
      ['1', '0', true, false],
      ['0', '1', false, true],
      ['1', '1', true, true],
      ['0', '0', false, false],
    ]) {
      process.env.ALLOW_LAN_AI = ai;
      process.env.ALLOW_LAN_TTS = tts;
      assert.equal(isFeatureManagementRequest(req, 'ai'), expectedAi);
      assert.equal(isFeatureManagementRequest(req, 'tts'), expectedTts);
      assert.equal(isFeatureManagementRequest(local(), 'ai'), true);
      assert.equal(isFeatureManagementRequest(local(), 'tts'), true);
    }
  });

  it('requires an explicit 1 rather than a truthy or malformed environment value', () => {
    const req = request();
    for (const [feature, key] of [['ai', 'ALLOW_LAN_AI'], ['tts', 'ALLOW_LAN_TTS']]) {
      for (const value of ['', '0', 'false', 'true', 'yes', 'on', '01', '+1', '1.0', '1abc', '2', '-1']) {
        process.env[key] = value;
        assert.equal(isFeatureManagementRequest(req, feature), false, `${key}=${JSON.stringify(value)}`);
      }
      for (const value of ['1', ' 1 ', '\t1\n']) {
        process.env[key] = value;
        assert.equal(isFeatureManagementRequest(req, feature), true, `${key}=${JSON.stringify(value)}`);
      }
      delete process.env[key];
    }
  });

  it('does not turn forwarded, spoofed, or unknown proxy clients into localhost administrators', () => {
    for (const headers of [
      { 'x-forwarded-for': '192.168.1.23' },
      { 'x-forwarded-for': '127.0.0.1, 192.168.1.23' },
      { 'x-real-ip': '192.168.1.23' },
      { forwarded: 'for=192.168.1.23;proto=http' },
      { forwarded: 'for=unknown' },
      { forwarded: 'proto=https;host=localhost' },
    ]) {
      const req = request({ address: '127.0.0.1', host: 'localhost:3000', headers });
      assert.equal(isFeatureManagementRequest(req, 'ai'), false);
      assert.equal(isFeatureManagementRequest(req, 'tts'), false);
    }
  });

  it('does not redefine loopback for the separate /v1 API access policy', () => {
    process.env.ALLOW_LAN_AI = '1';
    process.env.ALLOW_LAN_TTS = '1';
    for (const req of [request(), request({ address: '127.0.0.1' })]) {
      assert.equal(isFeatureManagementRequest(req, 'ai'), true);
      assert.equal(isFeatureManagementRequest(req, 'tts'), true);
      assert.equal(isLoopbackHttpRequest(req), false);
    }
  });

  it('uses the corresponding switch in each management middleware', () => {
    for (const [middleware, key, otherKey] of [
      [requireAiManagement, 'ALLOW_LAN_AI', 'ALLOW_LAN_TTS'],
      [requireTtsManagement, 'ALLOW_LAN_TTS', 'ALLOW_LAN_AI'],
    ]) {
      delete process.env[key];
      process.env[otherKey] = '1';
      const denied = runMiddleware(middleware, request());
      assert.equal(denied.next, false);
      assert.equal(denied.status, 403);
      assert.equal(typeof denied.body.error, 'string');
      assert.ok(denied.body.error.length > 0);
      assert.equal(runMiddleware(middleware, local()).next, true);
      process.env[key] = '1';
      const permitted = runMiddleware(middleware, request());
      assert.equal(permitted.next, true);
      assert.equal(permitted.status, undefined);
    }
  });

  it('keeps host and exact browser-origin protections active when both flags are on', () => {
    process.env.ALLOW_LAN_AI = '1';
    process.env.ALLOW_LAN_TTS = '1';
    const allowed = request({ headers: { origin: 'http://archive.home.arpa:3000' } });
    assert.equal(runMiddleware(requireLocalOrigin, allowed).next, true);
    // Native GUI clients omit Origin; the existing trusted-host contract stays valid.
    assert.equal(runMiddleware(requireLocalOrigin, request()).next, true);
    for (const origin of [
      'https://attacker.example',
      'http://archive.home.arpa:4000',
      'https://archive.home.arpa:3000',
      'null',
      'http://archive.home.arpa:3000/path',
    ]) {
      const denied = runMiddleware(requireLocalOrigin, request({ headers: { origin } }));
      assert.equal(denied.next, false, origin);
      assert.equal(denied.status, 403, origin);
    }
    const rebinding = runMiddleware(requireLocalOrigin, request({ host: 'attacker.example:3000' }));
    assert.equal(rebinding.next, false);
    assert.equal(rebinding.status, 403);
  });
});
