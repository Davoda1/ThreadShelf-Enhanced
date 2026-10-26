import { dataPath } from './paths.js';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

interface PipelineOutput {
  readonly data: Float32Array;
  readonly dims?: number[];
}

type Pipeline = (
  text: string | string[],
  options: Record<string, unknown>,
) => Promise<PipelineOutput>;

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const DIMENSION = 384;
const MODEL_FILES = [
  'config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'onnx/model_quantized.onnx',
];
const modelRoot = () => join(process.env.THREADSHELF_MODEL_CACHE || dataPath('modelCache'), MODEL);
const fileSignatures = async () =>
  Promise.all(
    MODEL_FILES.map(async (name) => {
      try {
        const info = await stat(join(modelRoot(), name));
        return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch {
        return undefined;
      }
    }),
  );

const packageVersion = async (name: string): Promise<string | undefined> => {
  try {
    let directory = dirname(createRequire(import.meta.url).resolve(name));
    for (let depth = 0; depth < 5; depth++) {
      try {
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === name && manifest.version) return manifest.version;
      } catch {
        /* Entry point may live below its package root. */
      }
      directory = dirname(directory);
    }
  } catch {
    /* No proof means embedding reuse is disabled. */
  }
  return undefined;
};

/** Fingerprint actual loaded model inputs; never certify a changing cache. */
const fingerprintModel = async (beforeLoad: readonly (string | undefined)[]): Promise<string> => {
  // A first download has no pre-load byte provenance. The loaded pipeline still
  // works, but only a later load from complete stable files can certify reuse.
  if (beforeLoad.some((entry) => !entry)) return '';
  const beforeHash = await fileSignatures();
  if (
    beforeHash.some((entry, index) => !entry || (beforeLoad[index] && beforeLoad[index] !== entry))
  )
    return '';
  const versions = await Promise.all(
    ['@huggingface/transformers', 'onnxruntime-node'].map(packageVersion),
  );
  if (versions.some((version) => !version)) return '';
  const hash = createHash('sha256').update(
    JSON.stringify({
      model: MODEL,
      dimension: DIMENSION,
      dtype: 'q8',
      pooling: 'mean',
      normalize: true,
      versions,
    }),
  );
  try {
    for (const file of MODEL_FILES) {
      hash.update(`\0${file}\0`);
      for await (const bytes of createReadStream(join(modelRoot(), file))) hash.update(bytes);
    }
  } catch {
    return '';
  }
  const afterHash = await fileSignatures();
  if (afterHash.some((entry, index) => entry !== beforeHash[index])) return '';
  return hash.digest('hex');
};

export const getDimension = (): number => {
  return DIMENSION;
};

const loadPipeline = async (): Promise<{ pipeline: Pipeline; identity: string }> => {
  const { env, pipeline } = await import('@huggingface/transformers');
  // Transformers.js caches model weights inside its own node_modules folder by
  // default. For an `npx threadshelf` install that directory is disposable, so
  // the ~50 MB model would be re-downloaded on every run. Keep it with the
  // user's data instead.
  env.cacheDir = process.env.THREADSHELF_MODEL_CACHE || dataPath('modelCache');
  const beforeLoad = await fileSignatures();
  const lastPercent = new Map<string, number>();
  const loaded = (await pipeline('feature-extraction', MODEL, {
    dtype: 'q8',
    progress_callback: (p: unknown) => {
      const info = p as { status?: string; file?: string; progress?: number };
      if (info.status === 'progress' && typeof info.progress === 'number') {
        const bucket = Math.floor(info.progress / 10) * 10;
        const file = info.file ?? 'model';
        if (lastPercent.get(file) !== bucket) {
          lastPercent.set(file, bucket);
          console.error('[embedding]', file, bucket);
        }
      }
    },
  })) as Pipeline;
  return { pipeline: loaded, identity: await fingerprintModel(beforeLoad) };
};

let sharedPipeline: ReturnType<typeof loadPipeline> | undefined;
const loadedPipeline = () =>
  (sharedPipeline ??= loadPipeline().catch((error) => {
    sharedPipeline = undefined;
    throw error;
  }));
export const getEmbeddingIdentity = async (): Promise<string> => (await loadedPipeline()).identity;

export const createEmbedder = (load: () => Promise<Pipeline>) => {
  let pipeline: Promise<Pipeline> | undefined;
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    pipeline ??= load().catch((error) => {
      pipeline = undefined;
      throw error;
    });
    const pipe = await pipeline;
    const options = { pooling: 'mean', normalize: true };

    try {
      const out = await pipe(texts, options);
      const data = Array.from(out.data);
      const batchSize = out.dims?.[0] === texts.length ? texts.length : texts.length === 1 ? 1 : 0;
      if (batchSize > 0 && data.length % batchSize === 0) {
        const stride = data.length / batchSize;
        return texts.map((_, index) => data.slice(index * stride, (index + 1) * stride));
      }
    } catch (e) {
      if (texts.length === 1) throw e;
    }

    const results: number[][] = [];
    for (const text of texts) {
      const out = await pipe(text, options);
      results.push(Array.from(out.data));
    }
    return results;
  };
};

export const embed = createEmbedder(async () => (await loadedPipeline()).pipeline);

export const embedOne = async (text: string): Promise<number[]> => {
  const [v] = await embed([text]);
  return v!;
};
