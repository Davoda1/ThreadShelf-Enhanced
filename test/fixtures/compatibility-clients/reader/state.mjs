// URL normalization dependency extracted unchanged from the released Reader.
// Other state/profile functions are intentionally not imported by these API tests.
export function normalizeServerUrl(value) {
  const url=new URL(String(value).trim());
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error('Use an HTTP(S) server address without credentials, a query, or a fragment.');
  url.pathname=url.pathname.replace(/\/+$/,'')+'/'; return url.href;
}
