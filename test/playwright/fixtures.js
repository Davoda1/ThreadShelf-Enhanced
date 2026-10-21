/**
 * Playwright fixtures that boot the ThreadShelf server in isolation per
 * test worker. Each worker gets its own port, its own LanceDB directory, and
 * its own uploads folder so tests don't smash into each other.
 */
import { test as base, expect } from '@playwright/test';
import { spawn } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMixedFixtureFolder,
  getAvailablePort,
  ingestViaNdjson,
  repoRoot,
  stopChildProcess,
  waitForHealth,
} from '../shared/helpers.js';

const maxServerLogBytes = 64 * 1024;

export const test = base.extend({
  serverLogs: [
    async ({}, use, workerInfo) => {
      const logBuffer = [];
      let logBytes = 0;
      let truncated = false;
      const logs = {
        started: false,
        logBuffer,
        capture: (chunk) => {
          const text = String(chunk);
          logBuffer.push(text);
          logBytes += Buffer.byteLength(text);
          while (logBytes > maxServerLogBytes && logBuffer.length > 1) {
            logBytes -= Buffer.byteLength(logBuffer.shift());
            truncated = true;
          }
          if (logBytes > maxServerLogBytes) {
            const bytes = Buffer.from(logBuffer[0]);
            let start = bytes.length - maxServerLogBytes;
            // Avoid cutting a UTF-8 character in the middle of a large chunk.
            while ((bytes[start] & 0xc0) === 0x80) start += 1;
            logBuffer[0] = bytes.subarray(start).toString();
            logBytes = Buffer.byteLength(logBuffer[0]);
            truncated = true;
          }
        },
        report: async (reason) => {
          const text = `${truncated ? '[Older server output omitted.]\n' : ''}${logBuffer.join('') || '(Server produced no output.)\n'}`;
          console.error(`[ThreadShelf worker ${workerInfo.workerIndex}] ${reason}\n${text}`);
          try {
            const outputDir = process.env.THREADSHELF_TEST_LOG_DIR || workerInfo.project.outputDir;
            await mkdir(outputDir, { recursive: true });
            await writeFile(join(outputDir, `server-worker-${workerInfo.workerIndex}.log`), text);
          } catch (error) {
            // A diagnostic write must not obscure the original test failure.
            console.error(`Could not save server diagnostics (${error.code || 'write failed'}).`);
          }
          return text;
        },
      };
      await use(logs);
    },
    { scope: 'worker' },
  ],

  _serverFailureLogs: [
    async ({ serverLogs }, use, testInfo) => {
      try {
        await use();
      } finally {
        if (serverLogs.started && testInfo.status !== testInfo.expectedStatus) {
          const text = await serverLogs.report(`Test failed: ${testInfo.title}`);
          await testInfo
            .attach('server-output', { body: text, contentType: 'text/plain' })
            .catch(() => console.error('Could not attach server diagnostics to the test result.'));
        }
      }
    },
    { auto: true },
  ],

  serverContext: [
    async ({ serverLogs }, use) => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'threadshelf-pw-'));
      const port = String(await getAvailablePort());
      const baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: port,
          HOST: '127.0.0.1',
          ALLOWED_HOSTS: '',
          LANCEDB_PATH: join(tempRoot, '.lancedb'),
          UPLOADS_DIR: join(tempRoot, '.uploads'),
          COLLECTIONS_PATH: join(tempRoot, '.collections.json'),
          GENERATION_CONFIG_PATH: join(tempRoot, 'generation.json'),
          MASTER_PROMPTS_PATH: join(tempRoot, 'master-prompts.json'),
          THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS: '1',
          THREADSHELF_TOOLS_PATH: join(tempRoot, 'tools'),
          // Model downloads must never reach the developer's real model folder.
          THREADSHELF_MODELS_PATH: join(tempRoot, 'models'),
          // Never let a developer's private .env key affect isolated tests.
          OPENROUTER_API_KEY: '',
          // A developer's local API key would lock /v1 in every test.
          THREADSHELF_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      serverLogs.started = true;
      child.stdout.on('data', serverLogs.capture);
      child.stderr.on('data', serverLogs.capture);

      let failure;
      try {
        await waitForHealth(baseUrl);
        const exportsDir = await createMixedFixtureFolder(tempRoot);
        const ingest = await ingestViaNdjson(baseUrl, exportsDir, 'pw_fixture');
        await use({ baseUrl, exportsDir, ingest, tempRoot, logBuffer: serverLogs.logBuffer });
      } catch (error) {
        failure = error;
      }
      try {
        await stopChildProcess(child);
      } catch (error) {
        failure ??= error;
      }
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        failure ??= error;
      }
      if (failure) {
        await serverLogs.report('Server fixture setup or cleanup failed.');
        throw failure;
      }
    },
    { scope: 'worker' },
  ],

  appPage: async ({ page, serverContext }, use) => {
    await page.goto(`${serverContext.baseUrl}/`);
    await page.waitForSelector('#searchInput');
    await expect(page.locator('#collection-pw_fixture')).toBeVisible({ timeout: 15_000 });
    await use(page);
  },
});

export { expect };
