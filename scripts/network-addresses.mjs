import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Keep the allow-list interpretation aligned with src/routes/local-origin.ts.
const requestHost = (value) => {
  const host = String(value || '')
    .trim()
    .toLowerCase();
  if (isIP(host)) return host;
  return host.startsWith('[')
    ? host.replace(/]:\d+$/, ']').replace(/^\[(.*)]$/, '$1')
    : host.replace(/:\d+$/, '');
};
const validHost = (host) =>
  isIP(host) !== 0 || (host.length <= 253 && /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/.test(host));
const loopback = (host) =>
  host === 'localhost' || host === '::1' || (isIP(host) === 4 && /^127\./.test(host));
const url = (host, port) => `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`;

/** Display candidates, not a firewall/DNS reachability probe. Never expand access rules. */
export function accessAddresses(env, interfaces = {}) {
  const host = String(env.HOST || '127.0.0.1')
    .trim()
    .toLowerCase();
  const port = Number(env.PORT) || 3000;
  const wildcard4 = host === '0.0.0.0';
  const wildcard6 = host === '::';
  const wildcard = wildcard4 || wildcard6;
  const localOnly = loopback(host);
  const configured = String(env.ALLOWED_HOSTS || '')
    .split(',')
    .map(requestHost)
    .filter(
      (name) =>
        validHost(name) &&
        name !== '0.0.0.0' &&
        name !== '::' &&
        !(isIP(name) === 6 && /^fe[89ab]/i.test(name)),
    );
  const allowed = new Set(['localhost', '127.0.0.1', '::1', requestHost(host), ...configured]);
  const local = new Set();
  const remote = new Set();
  const names = new Set();
  const detected = new Set();

  if (wildcard || localOnly) {
    if (wildcard || ['localhost', '127.0.0.1', '::1'].includes(host)) local.add('localhost');
    if (wildcard || host === '127.0.0.1') local.add('127.0.0.1');
    if (wildcard6 || host === '::1') local.add('::1');
    if (localOnly && isIP(host)) local.add(host);
  } else if (validHost(host)) {
    (isIP(host) ? remote : names).add(host);
  }

  if (wildcard) {
    for (const entry of Object.values(interfaces || {}).flatMap((entries) => entries || [])) {
      const address = String(entry.address || '').toLowerCase();
      const family = isIP(address);
      if (entry.internal || loopback(address) || !family || (wildcard4 && family !== 4)) continue;
      // Scoped IPv6 link-local URLs cannot be opened reliably in web browsers.
      if (/^fe[89ab]/i.test(address) && family === 6) continue;
      detected.add(address);
      if (allowed.has(address)) remote.add(address);
    }
  }
  if (!localOnly) {
    for (const name of configured) {
      if (loopback(name)) continue;
      if (!isIP(name)) names.add(name);
      // Distinguish an observed interface from an unverified configured address.
      else if (wildcard && detected.has(name)) remote.add(name);
      else if (wildcard && (wildcard6 || isIP(name) === 4)) names.add(name);
    }
  }

  return {
    local: [...local].map((name) => url(name, port)),
    remote: [...remote].map((name) => url(name, port)),
    configured: [...names].map((name) => url(name, port)),
    localOnly,
    filtered: wildcard && [...detected].some((address) => !allowed.has(address)),
  };
}

export function showAccessAddresses(
  env = process.env,
  getInterfaces = networkInterfaces,
  log = console.log,
) {
  let interfaces;
  try {
    interfaces = getInterfaces();
  } catch {
    interfaces = {};
  }
  const addresses = accessAddresses(env, interfaces);
  for (const address of addresses.local) log(`ThreadShelf local access: ${address}`);
  for (const address of addresses.remote) log(`ThreadShelf remote access: ${address}`);
  for (const address of addresses.configured) log(`ThreadShelf configured address: ${address}`);
  if (addresses.localOnly) log('ThreadShelf access is local only, as configured by HOST.');
  else if (addresses.filtered)
    log('Only network addresses permitted by HOST and ALLOWED_HOSTS are listed.');
  return addresses;
}

// The launcher preloads this module after Node has read .env, in the server process.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(new URL('../dist/src/server.js', import.meta.url))
) {
  showAccessAddresses();
}
