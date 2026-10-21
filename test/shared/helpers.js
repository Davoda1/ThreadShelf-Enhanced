import { copyFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..');
const fixturesDir = join(repoRoot, 'test', 'fixtures');

// Ask the OS for an unused ephemeral port instead of sampling a fixed range
// that can include ports forbidden by fetch (for example, the X11 port range).
export const getAvailablePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      // Release the probe socket before the test server attempts to bind it.
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const requireTimeout = (value, name) => {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive, finite number of milliseconds`);
};

export const waitForHealth = async (baseUrl, timeoutMs = 120_000) => {
  requireTimeout(timeoutMs, 'Health timeout');
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const remaining = timeoutMs - (Date.now() - startedAt);
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timeout);
      // Health only needs the status; release any unread response body/socket.
      controller.abort();
    }
    const delay = Math.min(500, timeoutMs - (Date.now() - startedAt));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error(
    `Server did not become healthy within ${timeoutMs} ms: ${lastError?.message || 'timeout'}`,
  );
};

export const stopChildProcess = async (
  child,
  { termTimeoutMs = 5_000, killTimeoutMs = 5_000 } = {},
) => {
  requireTimeout(termTimeoutMs, 'SIGTERM timeout');
  requireTimeout(killTimeoutMs, 'SIGKILL timeout');
  const hasExited = child.exitCode !== null || child.signalCode !== null;
  const pipesClosed = (child.stdio || []).every((stream) => !stream || stream.destroyed);
  if (hasExited && pipesClosed) return;
  let onClose;
  const closed = new Promise((resolve) => {
    onClose = () => resolve(true);
    child.once('close', onClose);
  });
  const waitForClose = async (timeoutMs) => {
    let timeout;
    try {
      return await Promise.race([
        closed,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    // Windows also supports these names; SIGTERM terminates the child there.
    child.kill('SIGTERM');
    if (await waitForClose(termTimeoutMs)) return;
    child.kill('SIGKILL');
    if (await waitForClose(killTimeoutMs)) return;
    // Inherited pipes can stay open after a child exits. Do not let those handles
    // keep the test runner alive after both bounded shutdown attempts failed.
    for (const stream of child.stdio || []) stream?.destroy();
    child.unref();
    throw new Error(
      `Test child process ${child.pid ?? '(unknown PID)'} did not close after SIGTERM ` +
        `(${termTimeoutMs} ms) and SIGKILL (${killTimeoutMs} ms)`,
    );
  } finally {
    child.off('close', onClose);
  }
};

export const ingestViaNdjson = async (
  baseUrl,
  folderPath,
  collection,
  clearFirst = true,
  { timeoutMs = 180_000 } = {},
) => {
  requireTimeout(timeoutMs, 'Ingest timeout');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(new URL('/api/ingest-progress', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath, collection, clearFirst }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ingest failed: ${res.status}`);

    // The same signal bounds both response headers and the entire NDJSON body.
    const text = await res.text();
    const events = text
      .split('\n')
      .map((block) => block.trim())
      .filter(Boolean)
      .map((block) => JSON.parse(block));
    const completed = events.find((event) => event.status === 'completed');
    if (!completed) throw new Error(`No completed event in: ${text}`);
    return completed.result;
  } catch (error) {
    if (timedOut)
      throw new Error(
        `Ingest timed out after ${timeoutMs} ms while waiting for /api/ingest-progress ` +
          `(collection: ${collection})`,
        { cause: error },
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
};

export const createMixedFixtureFolder = async (root) => {
  const exportsDir = join(root, 'exports');
  const providers = [
    ['gemini', 'gemini-polish.json'],
    ['claude', 'anthropic-polish.json'],
    ['chatgpt', 'openai-polish.json'],
    ['openrouter', 'openrouter-polish.json'],
    ['lmstudio', 'lmstudio-polish.json'],
    ['grok', 'grok-polish.json'],
  ];

  for (const [folder, fixture] of providers) {
    await mkdir(join(exportsDir, folder), { recursive: true });
    await copyFile(join(fixturesDir, fixture), join(exportsDir, folder, 'conversation.json'));
  }

  return exportsDir;
};
