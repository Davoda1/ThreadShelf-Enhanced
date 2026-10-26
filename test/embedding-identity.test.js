import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-model-identity-'));
const model = join(root, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
await mkdir(join(model, 'onnx'), { recursive: true });
after(() => rm(root, { recursive: true, force: true }));
const files = [
  'config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'onnx/model_quantized.onnx',
];
for (const file of files) await writeFile(join(model, file), 'synthetic model input');
const run = promisify(execFile);
const identity = async (mutateWhileLoading = false, downloadMissing = false) => {
  const { stdout } = await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--experimental-test-module-mocks',
      '--input-type=module',
      '-e',
      `
      import { mock } from 'node:test';
      import { writeFile } from 'node:fs/promises';
      const exports = {
        env: {},
        pipeline: async () => {
          if (${mutateWhileLoading}) await writeFile(${JSON.stringify(join(model, 'tokenizer.json'))}, 'changed during load');
          if (${downloadMissing}) await writeFile(${JSON.stringify(join(model, 'onnx/model_quantized.onnx'))}, 'synthetic newly downloaded weights');
          return async () => ({data: new Float32Array(384), dims:[1,384]});
        },
      };
      mock.module('@huggingface/transformers', { exports });
      const {getEmbeddingIdentity, embedOne} = await import('./src/embedding.ts');
      const first = await getEmbeddingIdentity();
      await embedOne('synthetic input');
      console.log(JSON.stringify({first,second:await getEmbeddingIdentity()}));
    `,
    ],
    { cwd: process.cwd(), env: { ...process.env, THREADSHELF_MODEL_CACHE: root }, timeout: 15000 },
  );
  return JSON.parse(stdout.trim());
};

it('certifies actual model bytes and refuses files changed while the pipeline loads', async () => {
  const first = await identity();
  assert.match(first.first, /^[a-f0-9]{64}$/);
  assert.equal(first.first, first.second);
  await writeFile(join(model, 'onnx/model_quantized.onnx'), 'different synthetic model weights');
  const changed = await identity();
  assert.notEqual(changed.first, first.first);
  assert.equal(changed.first, changed.second);
  const uncertain = await identity(true);
  assert.equal(uncertain.first, '');
  assert.equal(uncertain.second, '');
  await rm(join(model, 'onnx/model_quantized.onnx'));
  const downloaded = await identity(false, true);
  assert.equal(downloaded.first, '');
  assert.equal(downloaded.second, '');
});
