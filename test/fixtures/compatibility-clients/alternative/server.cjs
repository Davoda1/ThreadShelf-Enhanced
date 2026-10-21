'use strict';

// Read-only adapter for ThreadShelf 1.3.0 and its optional Reader v1 pagination
// extension. All archive identity fields are preserved: one JSON source file
// can contain many conversations and can appear in more than one collection.
const { createHash } = require('node:crypto');
const MAX_BYTES = 128 * 1024 * 1024;
const SNAPSHOT_TTL = 15 * 60 * 1000;
const READ_ENDPOINTS = new Set(['api/health', 'api/collections', 'api/files',
  'api/insights', 'api/thread', 'api/search', 'api/reader/capabilities', 'api/reader/search']);

class ServerError extends Error {
  constructor(message, { code = 'SERVER_ERROR', status = 0, field, retryable = false } = {}) {
    super(message); this.name = 'ServerError'; this.code = code; this.status = status;
    this.retryable = retryable; if (field) this.field = field;
  }
  toJSON() { return { message: this.message, code: this.code, status: this.status,
    retryable: this.retryable, ...(this.field ? { field: this.field } : {}) }; }
}
const invalid = (message, field) => new ServerError(message, { code: 'INVALID_INPUT', field });
const protocolError = message => new ServerError(message, { code: 'INVALID_RESPONSE' });
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' ? value : '';
function normalizeBaseUrl(value = 'http://localhost:3000') {
  if (typeof value !== 'string' || value.length > 8192) throw invalid('Enter a valid HTTP or HTTPS server address.', 'serverUrl');
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid('Enter a complete server address, for example http://localhost:3000.', 'serverUrl'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('The server address must use HTTP or HTTPS.', 'serverUrl');
  if (url.username || url.password) throw invalid('Credentials in the server URL are not supported.', 'serverUrl');
  if (url.search || url.hash) throw invalid('Use the server address and optional path prefix without a query or fragment.', 'serverUrl');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}
function collectionName(value = 'all') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value))
    throw invalid('Select a valid ThreadShelf collection.', 'collection');
  return value;
}
function integer(value, fallback, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < (field === 'offset' ? 0 : 1) || value > max)
    throw invalid(`Invalid ${field}.`, field);
  return value;
}
function identity(value, fallbackCollection) {
  if (!isObject(value)) throw invalid('A conversation identity is required.', 'thread');
  const collection = collectionName(value.collection || fallbackCollection);
  const sourceFile = value.sourceFile ?? value.file;
  const conversationKey = value.conversationKey ?? value.threadId ?? '';
  if (typeof sourceFile !== 'string' || !sourceFile || sourceFile.length > 4096 || sourceFile.includes('\0'))
    throw invalid('The conversation source file is missing or invalid.', 'sourceFile');
  if (typeof conversationKey !== 'string' || conversationKey.length > 4096 || conversationKey.includes('\0'))
    throw invalid('The conversation key is invalid.', 'conversationKey');
  return { collection, sourceFile, conversationKey };
}
function excerpt(value, query = '') {
  const position = query ? value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
  const start = Math.max(0, position - 120), end = Math.min(value.length, start + 760);
  return (start ? '…' : '') + value.slice(start, end) + (end < value.length ? '…' : '');
}
function normalizeRole(value) {
  if (value === undefined || value === '' || value === 'all') return undefined;
  const result = value === 'assistant' ? 'ai' : value;
  if (!['user', 'ai', 'thinking'].includes(result)) throw invalid('Search roles are User, Assistant, or Thinking.', 'role');
  return result;
}
function normalizeMessages(turns) {
  const result = [];
  turns.forEach((turn, turnIndex) => {
    if (!isObject(turn)) throw protocolError('The server returned an invalid conversation turn.');
    let found = false;
    for (const [key, role] of [['user', 'user'], ['thinking', 'thinking'], ['ai', 'assistant'], ['assistant', 'assistant'], ['system', 'system'], ['tool', 'tool']]) {
      if (typeof turn[key] === 'string') {
        found = true;
        result.push({ id: `${turnIndex}:${role}`, turnIndex, role, content: turn[key], text: turn[key],
          model: text(turn.model), date: text(turn.createdAt) });
      }
    }
    if (!found && (typeof turn.content === 'string' || typeof turn.text === 'string'))
      result.push({ id: `${turnIndex}:${turn.role || 'unknown'}`, turnIndex,
        role: turn.role === 'ai' ? 'assistant' : text(turn.role) || 'unknown',
        content: turn.content ?? turn.text, text: turn.content ?? turn.text,
        model: text(turn.model), date: text(turn.createdAt) });
  });
  return result;
}

class ServerClient {
  constructor(baseUrl = 'http://localhost:3000', { fetchImpl = globalThis.fetch,
    timeoutMs = 60000, maxResponseBytes = MAX_BYTES, cacheTtlMs = 30000, signal,
    now = Date.now } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl); this.url = this.baseUrl;
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.maxResponseBytes = maxResponseBytes;
    this.cacheTtlMs = cacheTtlMs; this.signal = signal; this.now = now;
    this.requests = new Set(); this.fileCache = new Map(); this.sessions = new Map(); this.capabilityCache = null;
  }
  cancel() { for (const controller of this.requests) controller.abort(); }
  clearCache() { this.fileCache.clear(); this.sessions.clear(); this.capabilityCache = null; }
  dispose() { this.cancel(); this.clearCache(); }
  idFor(value) { const ref = identity(value); return 'server:' + createHash('sha256')
    .update(JSON.stringify([this.baseUrl, ref.collection, ref.sourceFile, ref.conversationKey])).digest('hex'); }
  async _get(endpoint, params = {}, signal = this.signal) {
    if (!READ_ENDPOINTS.has(endpoint)) throw invalid('Unsupported read-only server endpoint.', 'endpoint');
    if (signal?.aborted || this.signal?.aborted) throw new ServerError('Request cancelled.', { code: 'CANCELLED' });
    const controller = new AbortController(); this.requests.add(controller);
    const onAbort = () => controller.abort(); signal?.addEventListener('abort', onAbort, { once: true });
    if (this.signal !== signal) this.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const url = new URL(endpoint, this.baseUrl);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    try {
      const response = await this.fetch(url, { method: 'GET', headers: { Accept: 'application/json' },
        redirect: 'manual', credentials: 'omit', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ServerError('The server redirected the request. Enter its final address directly.', { code: 'REDIRECT_BLOCKED', status: response.status });
      }
      if (Number(response.headers.get('content-length')) > this.maxResponseBytes) {
        await response.body?.cancel(); throw new ServerError('The server response exceeds the 128 MiB safety limit.', { code: 'RESPONSE_TOO_LARGE', status: response.status });
      }
      const reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > this.maxResponseBytes) { await reader.cancel(); throw new ServerError('The server response is too large.', { code: 'RESPONSE_TOO_LARGE', status: response.status }); }
          chunks.push(Buffer.from(part.value));
        }
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ServerError(`The address returned invalid JSON (HTTP ${response.status}). Check that it points to ThreadShelf.`, { code: 'INVALID_RESPONSE', status: response.status }); }
      if (!response.ok) {
        const reason = typeof body?.error === 'string' ? body.error : text(body?.error?.message);
        throw new ServerError(reason.slice(0, 1000) || `ThreadShelf request failed (HTTP ${response.status}).`, {
          code: response.status === 410 ? 'SNAPSHOT_EXPIRED' : response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'HTTP_ERROR',
          status: response.status, field: text(body?.field), retryable: response.status >= 500 || response.status === 429 });
      }
      if (!isObject(body)) throw protocolError('ThreadShelf returned an invalid API response.');
      return body;
    } catch (error) {
      if (timedOut) throw new ServerError('ThreadShelf did not respond before the request timed out. Retry or check the server.', { code: 'TIMEOUT', retryable: true });
      if (controller.signal.aborted) throw new ServerError('Request cancelled.', { code: 'CANCELLED' });
      if (error instanceof ServerError) throw error;
      throw new ServerError('Cannot reach ThreadShelf. Check the server address, network connection, and server Host settings.', { code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timer); this.requests.delete(controller); signal?.removeEventListener('abort', onAbort);
      if (this.signal !== signal) this.signal?.removeEventListener('abort', onAbort);
    }
  }
  async health(options = {}) {
    const body = await this._get('api/health', {}, options.signal);
    if (body.ok !== true) throw protocolError('The address did not return a healthy ThreadShelf API.');
    return body;
  }
  async capabilities({ refresh = false, signal } = {}) {
    if (!refresh && this.capabilityCache && this.now() - this.capabilityCache.at < 60000) return this.capabilityCache.value;
    let value;
    try {
      const body = await this._get('api/reader/capabilities', {}, signal), c = body.readerSearch;
      if (!isObject(c) || c.version !== 1 || c.path !== '/api/reader/search' || c.cursor !== true ||
          !Array.isArray(c.modes) || !c.modes.includes('keyword') || !c.modes.includes('semantic') || !count(c.maxPageSize) || c.maxPageSize < 1)
        throw new ServerError('The Reader search extension is incompatible with this client.', { code: 'INCOMPATIBLE_EXTENSION' });
      value = { pagination: true, exactTotal: c.exactTotal === true, maxPageSize: Math.min(50, c.maxPageSize),
        modes: ['keyword', 'semantic'], engine: 'reader-extension', readerSearch: c };
    } catch (error) {
      if (error.status !== 404) throw error;
      value = { pagination: false, exactTotal: false, maxPageSize: 50, modes: ['keyword', 'semantic'], engine: 'stock-ranked',
        notice: 'This server has no Reader pagination extension. Search is limited to its best 50 passages.' };
    }
    this.capabilityCache = { at: this.now(), value }; return value;
  }
  _summary(row, scope = 'all') {
    if (!isObject(row)) throw protocolError('The server returned an invalid conversation summary.');
    let ref;
    try { ref = identity(row); } catch { throw protocolError('The server returned a conversation without its complete source identity.'); }
    if (scope !== 'all' && ref.collection !== scope) throw protocolError('The server returned a conversation from the wrong collection.');
    return { ...ref, id: this.idFor(ref), title: text(row.title) || ref.conversationKey || ref.sourceFile.split(/[\\/]/).pop(),
      turnCount: count(row.turnCount) ? row.turnCount : 0, provider: text(row.provider),
      date: text(row.lastTurnAt || row.date), lastTurnAt: text(row.lastTurnAt || row.date), excerpt: text(row.excerpt),
      createdInThreadShelf: row.createdInThreadShelf === true };
  }
  async _files(collection = 'all', { refresh = false, signal } = {}) {
    if (signal?.aborted || this.signal?.aborted) throw new ServerError('Request cancelled.', { code: 'CANCELLED' });
    collection = collectionName(collection);
    const cached = this.fileCache.get(collection), all = this.fileCache.get('all');
    if (!refresh && cached && this.now() - cached.at < this.cacheTtlMs) return cached.files;
    if (!refresh && collection !== 'all' && all && this.now() - all.at < this.cacheTtlMs) return all.files.filter(row => row.collection === collection);
    const body = await this._get('api/files', { collection }, signal);
    if (!Array.isArray(body.files)) throw protocolError('ThreadShelf returned an invalid conversation list.');
    const seen = new Set(), files = body.files.map(row => this._summary(row, collection)).filter(row => {
      if (seen.has(row.id)) return false; seen.add(row.id); return true;
    });
    this.fileCache.set(collection, { at: this.now(), files });
    while (this.fileCache.size > 8) this.fileCache.delete(this.fileCache.keys().next().value);
    return files;
  }
  async collections(options = {}) {
    const [body, files] = await Promise.all([this._get('api/collections', {}, options.signal), this._files('all', options)]);
    if (!Array.isArray(body.collections) || body.collections.some(name => typeof name !== 'string')) throw protocolError('ThreadShelf returned an invalid collection list.');
    const counts = new Map(); files.forEach(row => counts.set(row.collection, (counts.get(row.collection) || 0) + 1));
    const names = [...new Set([...body.collections, ...counts.keys()])];
    const collections = names.map(name => ({ name: collectionName(name), count: counts.get(name) || 0 })).sort((a, b) => a.name.localeCompare(b.name));
    return { collections, total: files.length, serverUrl: this.baseUrl };
  }
  async browse({ collection = 'all', limit = 30, offset = 0, sort = 'updated', query = '', q, provider = '', refresh = false, signal } = {}) {
    collection = collectionName(collection); limit = integer(limit, 30, 500, 'limit'); offset = integer(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
    query = q ?? query;
    if (typeof query !== 'string' || query.length > 4000) throw invalid('Title filters must contain at most 4000 characters.', 'query');
    if (!['updated', 'oldest', 'title', 'length'].includes(sort)) throw invalid('Unknown conversation sort order.', 'sort');
    const needle = query.trim().toLocaleLowerCase();
    const rows = (await this._files(collection, { refresh, signal })).filter(row =>
      (!needle || row.title.toLocaleLowerCase().includes(needle)) && (!provider || provider === 'all' || row.provider === provider));
    const titleCompare = (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    rows.sort((a, b) => sort === 'title' ? titleCompare(a, b) : sort === 'length' ? b.turnCount - a.turnCount || titleCompare(a, b) :
      ((Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)) * (sort === 'oldest' ? 1 : -1) || titleCompare(a, b));
    const items = rows.slice(offset, offset + limit), hasMore = offset + items.length < rows.length;
    return { items, files: items, total: rows.length, totalKnown: true, hasMore, offset, limit,
      nextOffset: hasMore ? offset + items.length : null, engine: 'conversation-titles', resultUnit: 'conversations', notice: '' };
  }
  async stats(value = 'all', options = {}) {
    const collection = collectionName(isObject(value) ? value.collection || 'all' : value);
    const signal = isObject(value) ? value.signal : options.signal;
    const body = await this._get('api/insights', { collection }, signal);
    if (body.collection !== collection || !isObject(body.totals) ||
        ['collections', 'files', 'chunks', 'conversations', 'turns'].some(key => !count(body.totals[key])) ||
        ['activity', 'providers', 'topModels', 'longestThreads'].some(key => !Array.isArray(body[key]) || body[key].length > 10000))
      throw protocolError('ThreadShelf returned invalid archive Insights.');
    if (body.roles != null && (!isObject(body.roles) || ['user', 'ai', 'thinking'].some(key => !count(body.roles[key]))))
      throw protocolError('ThreadShelf returned invalid role counts.');
    if (body.activity.some(row => !isObject(row) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) || !count(row.count)) ||
        body.topModels.some(row => !isObject(row) || !text(row.model) || !count(row.count)) ||
        body.providers.some(row => !isObject(row) || !text(row.provider) || !count(row.conversations) || !count(row.turns)) ||
        body.longestThreads.some(row => !isObject(row) || !count(row.turnCount)))
      throw protocolError('ThreadShelf returned invalid Insights aggregates.');
    // Preserve server units: activity, model and role counts describe passages;
    // provider totals describe conversations and turns, not individual messages.
    return { ...body, source: 'server-insights', units: { activity: 'passages', roles: 'passages', topModels: 'passages', providers: 'conversations-and-turns' },
      longestThreads: body.longestThreads.map(row => this._summary(row, collection)) };
  }
  async thread(value = {}) {
    const ref = identity(value), body = await this._get('api/thread', ref, value.signal);
    if (!Array.isArray(body.turns)) throw protocolError('ThreadShelf returned an invalid conversation.');
    if (body.sourceFile !== undefined && body.sourceFile !== ref.sourceFile || body.conversationKey !== undefined && body.conversationKey !== ref.conversationKey)
      throw protocolError('ThreadShelf returned a different conversation identity. Refresh the archive and try again.');
    return { ...value, ...body, ...ref, id: this.idFor(ref), title: text(body.title) || text(value.title) || ref.conversationKey || ref.sourceFile.split(/[\\/]/).pop(),
      provider: text(body.provider) || text(value.provider), turnCount: body.turns.length, messages: normalizeMessages(body.turns), serverUrl: this.baseUrl };
  }
  _hit(hit, collection, byId, query) {
    if (!isObject(hit) || !isObject(hit.metadata) || typeof hit.document !== 'string') throw protocolError('ThreadShelf returned an invalid search passage.');
    let ref;
    try { ref = identity(hit.metadata, collection !== 'all' ? collection : undefined); }
    catch { throw protocolError('A search passage is missing its complete conversation identity.'); }
    if (collection !== 'all' && collection !== ref.collection) throw protocolError('A search passage belongs to the wrong collection.');
    const id = this.idFor(ref), m = hit.metadata, summary = byId.get(id) || this._summary({ ...m, ...ref });
    const index = typeof m.turnIndex === 'string' && /^\d+$/.test(m.turnIndex) ? Number(m.turnIndex) : m.turnIndex;
    return { ...summary, ...ref, id, conversationId: id, passageId: `${id}:${String(hit.id ?? `${index}:${m.role}`)}`,
      turnIndex: count(index) ? index : undefined, role: m.role === 'ai' ? 'assistant' : text(m.role),
      excerpt: excerpt(hit.document, query), text: hit.document, date: text(m.createdAt) || summary.date,
      provider: summary.provider || text(m.provider), model: text(m.model),
      ...(Number.isFinite(hit.distance) ? { distance: hit.distance } : {}),
      ...(Number.isFinite(hit.score) ? { score: hit.score } : {}), metadata: m };
  }
  async search({ collection = 'all', q, query, mode = 'keyword', searchMode, role, provider = '', limit = 30, offset = 0, refresh = false, signal } = {}) {
    collection = collectionName(collection); q = q ?? query; mode = searchMode ?? mode;
    if (typeof q !== 'string' || !q.trim() || q.trim().length > 4000) throw invalid('Enter between 1 and 4000 characters to search.', 'q');
    q = q.trim(); if (!['keyword', 'semantic'].includes(mode)) throw invalid('Choose keyword or semantic search.', 'mode');
    role = normalizeRole(role); limit = integer(limit, 30, 50, 'limit'); offset = integer(offset, 0, Number.MAX_SAFE_INTEGER, 'offset');
    if (typeof provider !== 'string' || provider.length > 200) throw invalid('Invalid provider filter.', 'provider');
    provider = provider && provider !== 'all' ? provider : undefined;
    const key = JSON.stringify([q, collection, mode, role || '', provider || '']);
    if (refresh) this.sessions.delete(key);
    let session = this.sessions.get(key);
    if (session && this.now() - session.created >= SNAPSHOT_TTL) { this.sessions.delete(key); session = null; }
    if (!session) {
      if (offset > 0) throw new ServerError('Search session expired. Start again from the first page.', { code: 'SNAPSHOT_EXPIRED', status: 410 });
      const caps = await this.capabilities({ signal });
      // Another request may have discovered capabilities while this one waited.
      session = this.sessions.get(key);
      if (!session) {
        session = { created: this.now(), caps, cursors: new Map([[0, undefined]]), pages: new Map(), cacheBytes: 0, total: null, queue: Promise.resolve() };
        this.sessions.set(key, session);
      }
      while (this.sessions.size > 4) this.sessions.delete(this.sessions.keys().next().value);
    }
    // Cursor state is shared by a query. Serialize advancing it so two quick
    // navigation actions cannot combine pages from different snapshots.
    const previous = session.queue; let release; session.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted || this.signal?.aborted) throw new ServerError('Request cancelled.', { code: 'CANCELLED' });
      const pageKey = `${offset}:${limit}`;
      if (session.pages.has(pageKey)) return session.pages.get(pageKey);
      const files = await this._files(collection, { signal }), byId = new Map(files.map(row => [row.id, row]));
      const params = { q, collection, mode, roles: role, provider };
      let body, items, total, totalKnown, hasMore, notice = '';
      if (session.caps.pagination) {
        if (limit > session.caps.maxPageSize) throw invalid(`This server allows at most ${session.caps.maxPageSize} passages per page.`, 'limit');
        let cursorOffset = Math.max(...[...session.cursors.keys()].filter(value => value <= offset));
        while (!session.completeResults && cursorOffset < offset) {
          body = await this._get('api/reader/search', { ...params, n: Math.min(session.caps.maxPageSize, offset - cursorOffset), cursor: session.cursors.get(cursorOffset) }, signal);
          this._validatePage(body); session.total = body.total;
          const next = cursorOffset + body.results.length;
          if (!body.hasMore || next <= cursorOffset) { cursorOffset = next; break; }
          session.cursors.set(next, body.nextCursor); cursorOffset = next;
        }
        if (session.completeResults) body = { results: session.completeResults.slice(offset, offset + limit), total: session.total,
          hasMore: offset + limit < session.total, nextCursor: null };
        else if (session.total !== null && offset >= session.total) body = { results: [], total: session.total, hasMore: false, nextCursor: null };
        else {
          if (!session.cursors.has(offset)) throw protocolError('The server could not advance to the requested search page.');
          body = await this._get('api/reader/search', { ...params, n: limit, cursor: session.cursors.get(offset) }, signal);
          this._validatePage(body); session.total = body.total;
        }
        if (body.hasMore && !session.completeResults) {
          session.cursors.set(offset + body.results.length, body.nextCursor);
          // Reader extension v1 cursor grammar is <48-hex snapshot id>.<offset>.
          // Retain an offset-zero cursor so revisiting page one cannot silently
          // create a different snapshot while later pages use the old snapshot.
          if (/^[a-f0-9]{48}\.\d+$/.test(body.nextCursor)) session.cursors.set(0, body.nextCursor.replace(/\.\d+$/, '.0'));
        } else if (offset === 0 && !session.completeResults) session.completeResults = body.results;
        items = body.results.map(hit => this._hit(hit, collection, byId, mode === 'keyword' ? q : ''));
        total = body.total; totalKnown = session.caps.exactTotal; hasMore = body.hasMore;
      } else {
        if (!session.stock) {
          body = await this._get('api/search', { ...params, n: 50 }, signal);
          if (!Array.isArray(body.results) || body.results.length > 50) throw protocolError('ThreadShelf returned invalid ranked search results.');
          session.stock = body.results.map(hit => this._hit(hit, collection, byId, mode === 'keyword' ? q : ''))
            .filter(row => (!provider || row.provider === provider) && (!role || (row.role === 'assistant' ? 'ai' : row.role) === role));
        }
        items = session.stock.slice(offset, offset + limit); total = session.stock.length; totalKnown = false; hasMore = offset + items.length < total;
        notice = 'This server exposes only its best 50 matching passages. The displayed count is a returned set, not the complete number of matches.';
        if (provider) notice += ' The provider filter is applied to that returned set.';
      }
      const result = { items, results: items, total, totalKnown, exhaustive: session.caps.pagination && totalKnown,
        hasMore, offset, limit, nextOffset: hasMore ? offset + items.length : null, engine: session.caps.engine, mode,
        resultUnit: 'passages', notice };
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes <= 8 * 1024 * 1024) {
        session.pages.set(pageKey, result); session.cacheBytes += bytes;
        while (session.pages.size > 12 || session.cacheBytes > 16 * 1024 * 1024) {
          const first = session.pages.keys().next().value;
          session.cacheBytes -= Buffer.byteLength(JSON.stringify(session.pages.get(first))); session.pages.delete(first);
        }
      }
      return result;
    } catch (error) {
      if (error.status === 410) this.sessions.delete(key);
      throw error;
    } finally { release(); }
  }
  _validatePage(body) {
    if (!Array.isArray(body.results) || body.results.length > 50 || !count(body.total) || typeof body.hasMore !== 'boolean' ||
      (body.hasMore && (typeof body.nextCursor !== 'string' || !body.nextCursor || body.results.length === 0)) ||
      (!body.hasMore && body.nextCursor !== null && body.nextCursor !== undefined)) throw protocolError('ThreadShelf returned invalid search pagination.');
  }
}

module.exports = { ServerClient, ServerError, normalizeBaseUrl, normalizeMessages };
