import { spawn } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import {
  createMixedFixtureFolder,
  getAvailablePort,
  ingestViaNdjson,
  repoRoot,
  stopChildProcess,
  waitForHealth,
} from '../shared/helpers.js';

export { createMixedFixtureFolder, ingestViaNdjson, repoRoot, stopChildProcess, waitForHealth };

export const startApiServer = async ({ prefix = 'threadshelf-e2e-', env = {} } = {}) => {
  // Low random ranges included Fetch-blocked ports such as 4045, and could
  // collide with a parallel fixture. Ask the OS for an available ephemeral port.
  const port = String(await getAvailablePort());
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      // Deployment host settings must not restrict isolated HTTP fixtures.
      ALLOWED_HOSTS: '',
      LANCEDB_PATH: join(tempRoot, '.lancedb'),
      UPLOADS_DIR: join(tempRoot, '.uploads'),
      COLLECTIONS_PATH: join(tempRoot, '.collections.json'),
      GENERATION_CONFIG_PATH: join(tempRoot, 'generation.json'),
      MASTER_PROMPTS_PATH: join(tempRoot, 'master-prompts.json'),
      THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS: '1',
      THREADSHELF_TOOLS_PATH: join(tempRoot, 'tools'),
      // The download directory is always scanned, so a developer's models would leak in.
      THREADSHELF_MODELS_PATH: join(tempRoot, 'models'),
      // Never let a developer's private .env key affect isolated tests.
      OPENROUTER_API_KEY: '',
      // A developer's local API key would lock /v1 in every test.
      THREADSHELF_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let outputCharacters = 0;
  const capture = (chunk) => {
    const text = String(chunk).slice(-65536);
    output.push(text);
    outputCharacters += text.length;
    while (outputCharacters > 65536 && output.length > 1) {
      outputCharacters -= output.shift().length;
    }
  };
  const saveDiagnosticLog = async () => {
    const directory = process.env.THREADSHELF_TEST_LOG_DIR;
    if (!directory) return;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${basename(tempRoot)}.log`), output.join(''), 'utf8');
    } catch (error) {
      console.error(`Could not save isolated test-server diagnostics: ${error.message}`);
    }
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    try {
      await stopChildProcess(server);
    } finally {
      await saveDiagnosticLog();
      await rm(tempRoot, { recursive: true, force: true });
    }
    const detail = output.join('');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail ? `\nServer output:\n${detail}` : ''}`,
    );
  }

  const stop = async () => {
    try {
      await stopChildProcess(server);
    } finally {
      await saveDiagnosticLog();
      await rm(tempRoot, { recursive: true, force: true });
    }
  };

  return { baseUrl, output, server, stop, tempRoot };
};
