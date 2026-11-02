import type { Request, RequestHandler } from 'express';
import { isIP } from 'net';
import { hostname } from 'os';

const normalizeRequestHost = (value: string | undefined): string => {
  const host = String(value || '')
    .trim()
    .toLowerCase();
  if (!host) return '';
  if (isIP(host)) return host;
  if (host.startsWith('[')) return host.replace(/]:\d+$/, ']').replace(/^\[(.*)]$/, '$1');
  return host.replace(/:\d+$/, '');
};

const localHosts = (): Set<string> => {
  const configuredHost = normalizeRequestHost(process.env.HOST || '127.0.0.1');
  const configuredAllowedHosts = (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => normalizeRequestHost(host))
    .filter(Boolean);
  return new Set(
    ['localhost', '127.0.0.1', '::1', configuredHost, ...configuredAllowedHosts].filter(
      (host) => host && host !== '0.0.0.0' && host !== '::',
    ),
  );
};

/** Browser origins include the scheme and port. A trusted host alone is not
 * enough: a different local web app must not drive this server's management API.
 * Native desktop clients omit Origin and keep their existing access contract. */
const browserOriginRejection = (req: Request): string | undefined => {
  const origin = req.headers.origin;
  if (!origin) return undefined;
  try {
    const parsed = new URL(origin);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      origin !== parsed.origin
    )
      return 'Invalid origin';
    // Express does not trust forwarded headers; do not infer HTTPS from one.
    const protocol = req.protocol || 'http';
    const expected = new URL(`${protocol}://${req.headers.host}`).origin;
    if (parsed.origin === expected) return undefined;
    const explicit = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim());
    return explicit.includes(parsed.origin) ? undefined : 'Forbidden origin';
  } catch {
    return 'Invalid origin';
  }
};

/**
 * Why a request must be refused as not addressed to this local server, or
 * undefined when it is acceptable. Checking `Host` and `Origin` defeats DNS
 * rebinding and cross-site pages driving the API from a user's browser.
 */
export const localOriginRejection = (req: Request): string | undefined => {
  const allowedHosts = localHosts();
  if (!allowedHosts.has(normalizeRequestHost(req.headers.host))) return 'Forbidden host';

  return browserOriginRejection(req);
};

/**
 * The network listener's counterpart to {@link localOriginRejection}: other
 * machines reach it by IP address or by this computer's name, so those are
 * accepted along with `ALLOWED_HOSTS`. Any other name can only come from DNS
 * rebinding, and a browser Origin naming another site from a cross-site page.
 */
export const networkOriginRejection = (req: Request): string | undefined => {
  const machine = hostname().toLowerCase();
  const allowed = (host: string): boolean =>
    isIP(host) !== 0 ||
    localHosts().has(host) ||
    host === machine ||
    host === `${machine}.local` ||
    host === `${machine}.lan`;
  if (!allowed(normalizeRequestHost(req.headers.host))) return 'Forbidden host';
  return browserOriginRejection(req);
};

export const requireLocalOrigin: RequestHandler = (req, res, next) => {
  const rejection = localOriginRejection(req);
  if (rejection) {
    res.status(403).json({ error: rejection });
    return;
  }
  next();
};
