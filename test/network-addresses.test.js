import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessAddresses, showAccessAddresses } from '../scripts/network-addresses.mjs';
import { localOriginRejection } from '../src/routes/local-origin.ts';

const interfaces = {
  lo: [
    { address: '127.0.0.1', internal: true },
    { address: '::1', internal: true },
  ],
  eth0: [
    { address: '192.0.2.24', internal: false },
    { address: '192.0.2.25', internal: false },
    { address: '2001:db8::24', internal: false },
    { address: 'fe80::24', internal: false },
  ],
  duplicate: [{ address: '192.0.2.24', internal: false }],
};

test('launcher combines live interfaces and configured names without expanding allowed access', () => {
  const env = {
    HOST: '0.0.0.0',
    PORT: '3210',
    ALLOWED_HOSTS: '192.0.2.24,archive.example.test,ARCHIVE.example.test:3210',
  };
  const addresses = accessAddresses(env, interfaces);
  assert.deepEqual(addresses.local, ['http://localhost:3210/', 'http://127.0.0.1:3210/']);
  assert.deepEqual(addresses.remote, ['http://192.0.2.24:3210/']);
  assert.deepEqual(addresses.configured, ['http://archive.example.test:3210/']);
  assert.equal(addresses.filtered, true);
  const previous = {
    HOST: process.env.HOST,
    ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
    PORT: process.env.PORT,
  };
  Object.assign(process.env, env);
  try {
    for (const address of [...addresses.local, ...addresses.remote, ...addresses.configured]) {
      assert.equal(localOriginRejection({ headers: { host: new URL(address).host } }), undefined);
    }
    assert.equal(localOriginRejection({ headers: { host: '192.0.2.25:3210' } }), 'Forbidden host');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('localhost-only binding is normal and never announces remote URLs', () => {
  const output = [];
  const addresses = showAccessAddresses(
    { HOST: '127.0.0.1', ALLOWED_HOSTS: '192.0.2.24,archive.example.test' },
    () => interfaces,
    (line) => output.push(line),
  );
  assert.deepEqual(addresses.remote, []);
  assert.deepEqual(addresses.configured, []);
  assert.equal(addresses.filtered, false);
  assert.ok(output.includes('ThreadShelf access is local only, as configured by HOST.'));
  assert.ok(output.every((line) => !/warning|error|blocked|192\.0\.2/i.test(line)));
});

test('specific binding does not announce unrelated interfaces or loopback URLs', () => {
  const addresses = accessAddresses(
    { HOST: '192.0.2.24', ALLOWED_HOSTS: '192.0.2.25,archive.example.test', PORT: '3001' },
    interfaces,
  );
  assert.deepEqual(addresses.local, []);
  assert.deepEqual(addresses.remote, ['http://192.0.2.24:3001/']);
  assert.deepEqual(addresses.configured, ['http://archive.example.test:3001/']);
  assert.deepEqual(accessAddresses({ HOST: '127.0.0.2' }, interfaces).local, [
    'http://127.0.0.2:3000/',
  ]);
});

test('IPv6 URLs use brackets and the bind family filters live addresses', () => {
  const addresses = accessAddresses(
    { HOST: '::', ALLOWED_HOSTS: '[2001:db8::24]:3000,192.0.2.24,[fe80::24]', PORT: '3000' },
    interfaces,
  );
  assert.deepEqual(addresses.remote, ['http://192.0.2.24:3000/', 'http://[2001:db8::24]:3000/']);
  assert.ok(addresses.local.includes('http://[::1]:3000/'));
  const ipv4 = accessAddresses({ HOST: '0.0.0.0', ALLOWED_HOSTS: '[2001:db8::24]' }, interfaces);
  assert.deepEqual(ipv4.remote, []);
  assert.deepEqual(ipv4.configured, []);
});

test('configured addresses remain visible when interface enumeration is unavailable', () => {
  const output = [];
  const addresses = showAccessAddresses(
    { HOST: '0.0.0.0', ALLOWED_HOSTS: '192.0.2.24,archive.example.test' },
    () => {
      throw new Error('not available');
    },
    (line) => output.push(line),
  );
  assert.deepEqual(addresses.configured, [
    'http://192.0.2.24:3000/',
    'http://archive.example.test:3000/',
  ]);
  assert.ok(output.includes('ThreadShelf configured address: http://192.0.2.24:3000/'));
});

test('bare IPv6 configuration retains its final numeric segment in the actual Host guard', () => {
  const previous = { HOST: process.env.HOST, ALLOWED_HOSTS: process.env.ALLOWED_HOSTS };
  process.env.HOST = '2001:db8::24';
  process.env.ALLOWED_HOSTS = '2001:db8::25,[2001:db8::26]:3000';
  try {
    for (const host of ['[2001:db8::24]:3000', '[2001:db8::25]:3000', '[2001:db8::26]:3000']) {
      assert.equal(
        localOriginRejection({ headers: { host, origin: `http://${host}` } }),
        undefined,
      );
    }
    assert.equal(
      localOriginRejection({ headers: { host: '[2001:db8::27]:3000' } }),
      'Forbidden host',
    );
    const addresses = accessAddresses({ HOST: '::', ALLOWED_HOSTS: '2001:db8::24' }, interfaces);
    assert.deepEqual(addresses.remote, ['http://[2001:db8::24]:3000/']);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('malformed allow-list entries cannot inject console output or become URLs', () => {
  const addresses = accessAddresses(
    {
      HOST: '0.0.0.0',
      ALLOWED_HOSTS: 'https://other.example.test/path,*.example.test,bad\nname,0.0.0.0,::',
    },
    interfaces,
  );
  assert.deepEqual(addresses.remote, []);
  assert.deepEqual(addresses.configured, []);
});
