'use strict';
// Bundled, offline CPU engines. No shell, system Python, model download, or GPU.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { wav } = require('./providers.cjs');

const POCKET_VOICES = Object.freeze(['alba','marius','javert','anna','charles','vera']);
const KOKORO_VOICES = Object.freeze(['af_heart','af_alloy','af_aoede','af_bella','af_jessica','af_kore','af_nicole','af_nova','af_river','af_sarah','af_sky','am_adam','am_echo','am_eric','am_fenrir','am_liam','am_michael','am_onyx','am_puck','am_santa','bf_alice','bf_emma','bf_isabella','bf_lily','bm_daniel','bm_fable','bm_george','bm_lewis']);
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const ENGINE_REVISIONS = Object.freeze({pocket:'pocket-v4.0.1-native3.3.0-english2026-10-a7056f5',kokoro:'kokoro-82m-v1.0-fp32-onnx1.31.1'});

function aborted() { const error = new Error('Speech generation cancelled.'); error.name = 'AbortError'; return error; }
async function regularFile(file, label) {
  let stat;
  try { stat = await fs.stat(file); } catch { throw new Error(`The local ${label} is missing. Open Text-to-Speech settings and download or repair the local voices.`); }
  if (!stat.isFile() || !stat.size) throw new Error(`The local ${label} is incomplete. Open Text-to-Speech settings and download or repair the local voices.`);
}

function workerEnvironment(assetsDir, workDir, threads) {
  const env = { ...process.env };
  // Do not inherit Python/ONNX configuration from unrelated user installations.
  for (const key of Object.keys(env)) if (/^(PYTHON|HF_|TRANSFORMERS_|ORT_|ONNX_|CUDA_|ROCM_|PHONEMIZER_)/i.test(key)) delete env[key];
  const pythonDir = path.join(assetsDir, 'runtime', 'python');
  Object.assign(env, {
    PYTHONPATH:path.join(assetsDir,'runtime','packages'), PYTHONNOUSERSITE:'1',
    PYTHONDONTWRITEBYTECODE:'1', PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8',
    HF_HOME:path.join(workDir,'cache','huggingface'), HF_HUB_OFFLINE:'1',
    HF_HUB_DISABLE_TELEMETRY:'1', ORT_DISABLE_TELEMETRY:'1', DO_NOT_TRACK:'1', TRANSFORMERS_OFFLINE:'1', CUDA_VISIBLE_DEVICES:'',
    ONNX_PROVIDER:'CPUExecutionProvider', OMP_NUM_THREADS:String(threads),
    OPENBLAS_NUM_THREADS:String(threads), MKL_NUM_THREADS:String(threads), RAYON_NUM_THREADS:String(threads),
    XDG_CACHE_HOME:path.join(workDir,'cache'), TMPDIR:workDir, TMP:workDir, TEMP:workDir,
  });
  if (process.platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    env.PATH = [pythonDir,path.join(assetsDir,'engines','pocket'),path.join(systemRoot,'System32'),systemRoot].join(path.delimiter);
  } else {
    env.LD_LIBRARY_PATH = path.join(pythonDir,'lib');
    env.PATH = [path.join(pythonDir,'bin'),'/usr/bin','/bin'].join(path.delimiter);
  }
  return env;
}

function runWorker(executable, script, request, options) {
  return new Promise((resolve,reject) => {
    if (options.signal?.aborted) { reject(aborted()); return; }
    let child, settled = false, failure = null, logBytes = 0, stdout = '', pending = '', audioBytes = 0, nextAudioIndex = 0, escalation;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearTimeout(escalation);
      options.signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(stdout);
    };
    const stop = (error) => {
      failure ||= error;
      if (!child?.pid || settled) return;
      if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
        const killer = spawn(path.join(systemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',() => { try { child.kill(); } catch {} });
      } else {
        try { process.kill(-child.pid,'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
        escalation ||= setTimeout(() => { try { process.kill(-child.pid,'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } },1000);
        escalation.unref?.();
      }
    };
    const onAbort = () => stop(aborted());
    const timeout = setTimeout(() => stop(new Error('CPU speech generation timed out. Try a shorter passage.')),10 * 60 * 1000);
    timeout.unref?.();
    try {
      child = spawn(executable,['-s','-B',script],{cwd:options.cwd,env:options.env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform !== 'win32'});
    } catch (error) { finish(error); return; }
    options.signal?.addEventListener('abort',onAbort,{once:true});
    if (options.signal?.aborted) onAbort();
    child.on('error',() => finish(failure || new Error('The local speech runtime could not start. Open Text-to-Speech settings and download or repair the local voices.')));
    const line = value => {
      if (failure || !value.trim()) return;
      let event; try { event = JSON.parse(value); } catch { /* Bounded diagnostic output is allowed. */ }
      if (event?.type === 'audio') {
        if (!request.stream || event.index !== nextAudioIndex || event.sample_rate !== 24000 || event.channels !== 1 || event.sample_width !== 2 || typeof event.pcmBase64 !== 'string' || !event.pcmBase64.length || event.pcmBase64.length > 699052 || event.pcmBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.pcmBase64)) throw new Error('The speech runtime returned an invalid streaming audio chunk.');
        const pcm = Buffer.from(event.pcmBase64, 'base64');
        audioBytes += pcm.length;
        if (!pcm.length || pcm.length % 2 || pcm.length > 512 * 1024 || audioBytes > MAX_AUDIO_BYTES - 44) throw new Error('The speech runtime exceeded its audio size limit.');
        nextAudioIndex++;
        options.onAudio?.({bytes:wav(pcm,24000,1),mime:'audio/wav',...(Number.isInteger(event.section)&&event.section>0?{section:event.section}:{}),...(Number.isInteger(event.sections)&&event.sections>0?{sections:event.sections}:{})});
        return;
      }
      logBytes += Buffer.byteLength(value,'utf8') + 1;
      if(logBytes > MAX_LOG_BYTES) throw new Error('The speech runtime returned too much diagnostic output.');
      stdout += value + '\n';
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',data => {
      if(failure) return;
      try {
        pending += data;
        let newline;
        while((newline=pending.indexOf('\n'))>=0){const value=pending.slice(0,newline);pending=pending.slice(newline+1);if(value.length>1024*1024)throw new Error('The speech runtime returned an oversized event.');line(value);if(failure)return;}
        if(pending.length>1024*1024)throw new Error('The speech runtime returned an oversized event.');
      } catch(error) { stop(error); }
    });
    child.stderr.on('data',data => { logBytes += data.length; if(logBytes > MAX_LOG_BYTES) stop(new Error('The speech runtime returned too much diagnostic output.')); });
    child.on('close',code => {try{if(pending&&!failure)line(pending);}catch(error){failure=error;}finish(failure || (code === 0 ? null : new Error('The local speech engine could not generate audio. Check the selected voice and try a shorter passage.')));});
    child.stdin.on('error',() => {}); // A cancelled process may close stdin early.
    child.stdin.end(JSON.stringify(request));
  });
}

async function synthesizeCPU({provider,voice,text,assetsDir,workDir,signal,streamingEnabled=false,onAudio}) {
  if (!['pocket','kokoro'].includes(provider)) throw new Error('Unknown bundled speech engine.');
  if (!(provider === 'pocket' ? POCKET_VOICES : KOKORO_VOICES).includes(voice)) throw new Error('Unknown bundled speech voice.');
  if (typeof text !== 'string' || !text.trim() || text.length > 100000 || Buffer.byteLength(text,'utf8') > 256 * 1024) throw new Error('Speech text is empty or too long.');
  if (!path.isAbsolute(assetsDir || '') || !path.isAbsolute(workDir || '')) throw new Error('Speech asset and work paths must be absolute.');
  if (signal?.aborted) throw aborted();
  if (!['linux','win32'].includes(process.platform) || process.arch !== 'x64') throw new Error('Bundled CPU speech requires Windows or Linux x64.');
  const executable = path.join(assetsDir,'runtime','python',process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  const script = path.join(__dirname,'cpu','voice_light.py');
  await regularFile(executable,'Python runtime');
  await regularFile(script,'speech adapter');
  const required = provider === 'pocket' ? ['models/pocket/model.safetensors','models/pocket/tokenizer.json','models/pocket/english_2026-10.upstream.yaml',`models/pocket/voices/${voice}.safetensors`,`engines/pocket/pocket-tts${process.platform === 'win32' ? '.exe' : ''}`] : ['models/kokoro/kokoro-v1.0.onnx','models/kokoro/voices-v1.0.bin'];
  await Promise.all(required.map(file => regularFile(path.join(assetsDir,file),'speech model asset')));
  await fs.mkdir(workDir,{recursive:true});
  const temporary = await fs.mkdtemp(path.join(workDir,'cpu-'));
  const output = path.join(temporary,'speech.wav');
  const threads = Math.max(1,Math.min(4,os.availableParallelism?.() || os.cpus().length || 1));
  try {
    const result = await runWorker(executable,script,{engine:provider,voice,text,threads,stream:!!streamingEnabled,output_path:output,model_root:path.join(assetsDir,'models'),engine_root:path.join(assetsDir,'engines'),cache_root:path.join(temporary,'cache')},{cwd:temporary,env:workerEnvironment(assetsDir,temporary,threads),signal,onAudio});
    if (signal?.aborted) throw aborted();
    let completed = false;
    for (const line of result.split(/\r?\n/)) { try { const event = JSON.parse(line); if (event.type === 'result' && event.ok === true && event.output_path === output) completed = true; } catch {} }
    if (!completed) throw new Error('The speech engine did not complete its audio output.');
    const stat = await fs.stat(output);
    if (!stat.isFile() || stat.size <= 44 || stat.size > MAX_AUDIO_BYTES) throw new Error('The speech engine returned invalid or oversized audio.');
    const audio = await fs.readFile(output);
    if (audio.toString('ascii',0,4) !== 'RIFF' || audio.toString('ascii',8,12) !== 'WAVE') throw new Error('The speech engine returned invalid WAV audio.');
    return audio;
  } finally { await fs.rm(temporary,{recursive:true,force:true}).catch(() => {}); }
}

module.exports = {synthesizeCPU,POCKET_VOICES,KOKORO_VOICES,ENGINE_REVISIONS,workerEnvironment};
