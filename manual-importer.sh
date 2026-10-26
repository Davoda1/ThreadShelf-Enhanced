#!/usr/bin/env bash
# ThreadShelf Enhanced manual folder importer. Place this file in the repo root.
# SPDX-License-Identifier: MIT
# No server patch, package update, personal launcher, or extra JS file is needed.
set -euo pipefail

show_help() {
  cat <<'HELP'
ThreadShelf Enhanced — manual folder importer (Linux, Bash, Node 24+)
Usage: bash manual-importer.sh                       # interactive importer
       bash manual-importer.sh --interactive [options]
       bash manual-importer.sh --import-dir DIR [options]   # combined on a TTY
       bash manual-importer.sh --non-interactive --import-dir DIR --yes [options]

Input and destination:
  --import-dir DIR       Required existing folder; scanned recursively by server.
  --collection NAME     Exact lowercase collection slug (default: chatgpt).
  --no-clear            Update/import without clearing the collection (default).
  --clear               Replace the selected collection using server semantics.
  --source-json FILE    Optionally copy FILE to DIR/conversations.json first.
  --no-source-json      Explicitly disable source copying (skip its setup prompt).
  --replace-source      Allow replacement of conversations.json and its checksum.
                        Required if either exists; --yes alone does not allow it.
  --no-replace-source   Explicitly refuse source replacement.
  --env-file FILE       Read configuration from FILE (default: repo/.env).
  --data-dir DIR        Set THREADSHELF_DATA_DIR for this run. Existing explicit
                        LANCEDB_PATH/COLLECTIONS_PATH still take precedence.

Runtime and resource checks:
  --node FILE           Explicit Node executable, or command name on PATH.
                        Otherwise use THREADSHELF_NODE_VERSION if set, one
                        installed .local Node runtime, then Node on PATH.
                        Multiple local runtimes require an explicit selection.
  --heap-mb N           V8 old-space allowance in MiB (default: 4096).
  --reserve-mb N        Required available memory beyond startup work in MiB
                        (default: greater of 2048 and 25% of heap).
  --min-free-disk-mb N  Minimum free space on the database filesystem (1024).
  --max-age-days N      Reject older/future-dated selected files; 0 disables
                        age checks (default). Source copy keeps timestamps.
  --require-session    Require tmux or GNU Screen; otherwise only warn.
  --no-require-session  Explicitly make tmux/Screen optional.

Control and inspection:
  --interactive        Guided setup; ask only for settings not supplied by flags.
                       Automatic on a TTY unless a noninteractive mode is chosen.
  --non-interactive    Never prompt. Actual imports also require --yes; omitted
                       optional flags use documented defaults. Missing input fails.
  --health             Read-only readiness report. No import, copy, or prompts.
  --dry-run            Read-only report plus exact planned command and actions.
  --yes                Confirm the flag-based plan and disable all prompts.
                       Use with --non-interactive for explicit unattended jobs.
                       Cannot be combined with --interactive.
  --color MODE         auto (default), always, or never; respects NO_COLOR.
  -h, --help           Show this help without needing an installed runtime.

Modes:
  No arguments: interactive setup and review menu.
  Partial flags on a TTY: keep supplied values and ask for missing settings.
  --interactive plus flags: explicitly request that combined behavior.
  --non-interactive --yes (or --yes): flags/defaults only, no questions.
  --health / --dry-run: flags/defaults only; inspect without any changes.
Core questions cover folder, collection, update/replacement and heap. An optional
advanced setup covers the other settings. Declining it accepts displayed defaults.
Supplied flags skip setup questions; explicit review-menu edits can change them.
No terminal: interactive mode fails promptly; nothing reads answers from a pipe.

Examples (run from the repository root):
  bash manual-importer.sh
  bash manual-importer.sh --interactive --collection archive
  bash manual-importer.sh --import-dir /data/exports --health
  bash manual-importer.sh --import-dir '/data/Chat exports' --dry-run
  bash manual-importer.sh --import-dir /data/exports  # ask for the other settings
  bash manual-importer.sh --non-interactive --import-dir /data/exports \
    --collection archive --no-clear --heap-mb 8192 --yes
  bash manual-importer.sh --import-dir /data/exports --clear --heap-mb 12288
  bash manual-importer.sh --import-dir /data/exports \
    --source-json /data/latest/conversations.json --replace-source --clear

All user-supplied relative paths are relative to the invoking shell directory.
The script itself must be in the server root; symlinked invocation is supported.
No configuration is sourced as shell code. Environment variables override .env.
Existing NODE_OPTIONS are preserved for ingestion; --heap-mb overrides absolute
old-space settings. Percentage-based heap settings are rejected. Health helpers
never execute NODE_OPTIONS preloads. Only the real importer executes them.

Health checks inspect metadata, not export contents/provider validity. Supported
candidates match this server's folder rules: JSON, HTML, ZIP and extensionless
exports, with known metadata excluded. Symlinks/special files are refused.
Avoid duplicate representations (e.g. conversations.json and chat.html). Media
companions stay in the folder. Optional source copying copies JSON only.

--no-clear is the server's normal reimport/upsert behavior, not append-only;
matching imported files can be refreshed. --clear uses the server's replacement
logic; invalid/empty input can prevent replacement. A failed/cancelled run is
not a rollback guarantee. Review the server's result and rerun as appropriate.

Memory checks are snapshots, not reservations. The heap is not a total-process
RAM cap; native allocations, embedding models and clear-mode staging need extra
RAM. Disk estimates cannot predict index growth. No network health request is
made; first use may download the configured embedding model. Stop other imports
into the same collection. Wrapper locks prevent overlapping wrapper runs, not
all server/UI writers. Server interprocess locks remain authoritative.

No files are changed by --health/--dry-run. An actual run may create persistent
advisory lock files in the per-user temporary directory, a source checksum when
copying, and normal server data/cache files. No dependencies are auto-installed.
Ctrl+C forwards shutdown to the importer process group, then escalates after
10 seconds if necessary. Cancellation exits 130 (TERM: 143, HUP: 129).
Exit: 0 successful child/healthy checks; 1 preflight/runtime failure; 2 usage or
server partial-import errors; otherwise preserve the importer's exit status.
HELP
}

# Parse just enough to select Node. The embedded coordinator validates every flag.
NODE_REQUEST=
ARGS=("$@")
VALUE_FLAGS=' --import-dir --collection --source-json --env-file --data-dir --heap-mb --reserve-mb --min-free-disk-mb --max-age-days --color --node '
for ((i=0; i<${#ARGS[@]}; i++)); do
  arg=${ARGS[i]}
  if [[ "$VALUE_FLAGS" == *" $arg "* ]]; then
    ((i+1 < ${#ARGS[@]})) || { printf 'FAIL: %s needs a value.\n' "$arg" >&2; exit 2; }
    [[ "$arg" != --node ]] || NODE_REQUEST=${ARGS[i+1]}
    ((i+=1))
  elif [[ "$arg" == --help || "$arg" == -h ]]; then
    show_help; exit 0
  elif [[ "$arg" != --non-interactive && "$arg" != --no-source-json && "$arg" != --no-replace-source && "$arg" != --no-require-session && "$arg" != --interactive && "$arg" != --clear && "$arg" != --no-clear && "$arg" != --replace-source && "$arg" != --require-session && "$arg" != --health && "$arg" != --dry-run && "$arg" != --yes ]]; then
    printf 'FAIL: unknown option %q. Use --help.\n' "$arg" >&2; exit 2
  fi
done
[[ "$(uname -s)" == Linux ]] || { echo 'FAIL: this Bash importer supports Linux (including WSL with a Linux installation).' >&2; exit 1; }
SOURCE=${BASH_SOURCE[0]}
LINKS=0
while [[ -L "$SOURCE" ]]; do
  ((LINKS+=1)); ((LINKS<=40)) || { echo 'FAIL: too many script symlinks.' >&2; exit 1; }
  BASE=$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)
  SOURCE=$(readlink -- "$SOURCE")
  [[ "$SOURCE" == /* ]] || SOURCE="$BASE/$SOURCE"
done
ROOT=$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)
if [[ -n "$NODE_REQUEST" ]]; then
  if [[ "$NODE_REQUEST" == */* ]]; then NODE=$NODE_REQUEST
  else NODE=$(command -v -- "$NODE_REQUEST" || true); fi
elif [[ -n "${THREADSHELF_NODE_VERSION:-}" ]]; then
  VERSION=${THREADSHELF_NODE_VERSION#v}
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'FAIL: invalid THREADSHELF_NODE_VERSION.' >&2; exit 2; }
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) ARCH=$(uname -m);; esac
  NODE="$ROOT/.local/node-v$VERSION-linux-$ARCH/bin/node"
else
  shopt -s nullglob
  CANDIDATES=("$ROOT"/.local/node-v*-linux-*/bin/node)
  shopt -u nullglob
  if ((${#CANDIDATES[@]} > 1)); then
    echo 'FAIL: multiple project-local Node runtimes; select --node or THREADSHELF_NODE_VERSION.' >&2; exit 1
  elif ((${#CANDIDATES[@]} == 1)); then NODE=${CANDIDATES[0]}
  else NODE=$(command -v node || true); fi
fi
[[ -n "$NODE" && -f "$NODE" && -x "$NODE" ]] || { echo 'FAIL: Node executable unavailable. Run setup-threadshelf.sh or select --node.' >&2; exit 1; }
# -e preserves stdin for interactive confirmation. Clearing NODE_OPTIONS prevents
# preloads from running while inspecting configuration and checking readiness.
exec env MANUAL_IMPORTER_NODE_OPTIONS="${NODE_OPTIONS-}" \
  MANUAL_IMPORTER_OPTIONS_SET="${NODE_OPTIONS+x}" NODE_OPTIONS= \
  "$NODE" --input-type=commonjs -e "$(cat <<'NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseEnv } = require('node:util');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const readline = require('node:readline/promises');
const MIB = 1048576;
const root = fs.realpathSync(process.argv[1]);
const cwd = process.cwd();
const opt = { collection:'chatgpt', clear:false, heap:4096, reserve:null, disk:1024,
  age:0, yes:false, health:false, dry:false, replace:false, session:false, color:'auto', interactive:false, nonInteractive:false };
const flags = new Map([
  ['--import-dir','input'], ['--collection','collection'], ['--source-json','source'],
  ['--env-file','envFile'], ['--data-dir','dataDir'], ['--node','node'],
  ['--heap-mb','heap'], ['--reserve-mb','reserve'], ['--min-free-disk-mb','disk'],
  ['--max-age-days','age'], ['--color','color']
]);
const seen = new Set();
let failures=0, warnings=0, child=null, stopCode=0, killTimer=null, tempDir=null;
let childGroup=null, stopAt=0, reserveAuto=true, attemptedWrite=false;
const lockFds=[];
let runtime=process.execPath, runtimeVersion=process.version, runtimeArch=process.arch;
let runtimeAllowedFlags=process.allowedNodeEnvironmentFlags;
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const safe = value => String(value).replace(/[\x00-\x1f\x7f\x80-\x9f]/g, c => '\\x'+c.charCodeAt(0).toString(16).padStart(2,'0'));
const size = n => `${(Number(n)/MIB).toFixed(1)} MiB`;
function out(kind, title, detail='') {
  if(kind==='FAIL') failures++;
  if(kind==='WARN') warnings++;
  const color = !('NO_COLOR' in process.env) && (opt.color==='always' || (opt.color==='auto' && process.stderr.isTTY));
  const codes={PASS:32,WARN:33,FAIL:31,INFO:36};
  const tag=color ? `\x1b[${codes[kind]}m${kind.padEnd(4)}\x1b[0m` : kind.padEnd(4);
  process.stderr.write(`${tag}  ${safe(title)}${detail ? ': '+safe(detail) : ''}\n`);
}
function usage(message) { const e=new Error(message+' Use --help.'); e.exitCode=2; throw e; }
function number(key,min,max) {
  const value=String(opt[key]);
  if(!/^(0|[1-9][0-9]{0,9})$/.test(value) || Number(value)<min || Number(value)>max)
    usage(`${key} must be an integer from ${min} to ${max}.`);
  opt[key]=Number(value);
}
function parse() {
  const args=process.argv.slice(2);
  opt.interactive=false;
  for(let i=0;i<args.length;i++) {
    const a=args[i];
    if(seen.has(a)) usage(`Repeated option ${a}.`);
    seen.add(a);
    if(flags.has(a)) {
      if(i+1>=args.length || !args[i+1] || args[i+1].startsWith('--')) usage(`Missing value for ${a}.`);
      opt[flags.get(a)]=args[++i]; continue;
    }
    const booleans={'--clear':['clear',true],'--no-clear':['clear',false],'--yes':['yes',true],
      '--health':['health',true],'--dry-run':['dry',true],'--replace-source':['replace',true],
      '--require-session':['session',true],'--no-require-session':['session',false],
      '--no-source-json':['source',null],'--no-replace-source':['replace',false],
      '--interactive':['interactive',true],'--non-interactive':['nonInteractive',true]};
    if(!booleans[a]) usage(`Unknown option ${a}.`);
    const [k,v]=booleans[a]; opt[k]=v;
  }
  if(opt.interactive && (opt.nonInteractive || opt.yes || opt.health || opt.dry))
    usage('--interactive conflicts with --non-interactive, --yes, --health and --dry-run.');
  for(const [a,b] of [['--source-json','--no-source-json'],['--replace-source','--no-replace-source'],['--require-session','--no-require-session']])
    if(seen.has(a) && seen.has(b)) usage(`${a} and ${b} conflict.`);
  if(!opt.interactive && !opt.nonInteractive && !opt.yes && !opt.health && !opt.dry)
    opt.interactive=!!process.stdin.isTTY || args.length===0;
  if(opt.nonInteractive && !opt.yes && !opt.health && !opt.dry)
    usage('--non-interactive imports require --yes; no prompts or changes were made.');
  if(opt.replace && seen.has('--no-source-json')) usage('--replace-source conflicts with --no-source-json.');
  reserveAuto=!seen.has('--reserve-mb');
  if(seen.has('--clear') && seen.has('--no-clear')) usage('--clear and --no-clear conflict.');
  if(opt.health && opt.dry) usage('Choose either --health or --dry-run.');
  if(opt.replace && !opt.source && !opt.interactive) usage('--replace-source requires --source-json.');
  validateOptions(!opt.interactive);
}
function validateOptions(requireInput=true) {
  if(requireInput && !opt.input) usage('--import-dir is required.');
  if(requireInput && opt.replace && !opt.source) usage('--replace-source requires --source-json.');
  if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(opt.collection) || /[_-]$/.test(opt.collection) || /__/.test(opt.collection) || ['all','threadshelf_conversations'].includes(opt.collection))
    usage('Use an exact lowercase collection slug (1-63 characters), not a reserved collection; avoid trailing separators and repeated underscores.');
  if(!['auto','always','never'].includes(opt.color)) usage('--color must be auto, always or never.');
  number('heap',512,1048576); number('disk',0,1073741824); number('age',0,365000);
  if(reserveAuto) opt.reserve=Math.max(2048,Math.ceil(opt.heap/4));
  number('reserve',256,1048576);
  for(const key of ['input','source','envFile','dataDir']) if(opt[key]) opt[key]=path.resolve(cwd,opt[key]);
}
function regular(file) {
  const s=fs.lstatSync(file);
  if(!s.isFile() || s.isSymbolicLink()) throw new Error(`Not a regular non-symlink file: ${file}`);
  fs.accessSync(file,fs.constants.R_OK); return s;
}
function nearestDir(file) {
  let p=file;
  while(!fs.existsSync(p)) { const parent=path.dirname(p); if(parent===p) throw new Error(`No existing parent for ${file}`); p=parent; }
  if(!fs.statSync(p).isDirectory()) throw new Error(`Not a directory: ${p}`);
  return p;
}
function canonicalFuture(file) {
  const parent=nearestDir(file);
  return path.join(fs.realpathSync(parent),path.relative(parent,file));
}
function inside(a,b) { const r=path.relative(a,b); return r==='' || (!r.startsWith('..'+path.sep) && r!=='..' && !path.isAbsolute(r)); }
function freeDisk(dir) { const s=fs.statfsSync(nearestDir(dir),{bigint:true}); return Number(s.bavail*s.bsize); }
function availableMemoryMiB() {
  const monitor=path.join(root,'dist/src/memory-governor.js');
  // Reuse the server's effective host/container and reclaimable-cache probe.
  // Older installations without this module retain the Node fallback.
  const bytes=fs.existsSync(monitor)
    ? require(monitor).systemMemory().availableBytes
    : process.availableMemory();
  return Math.floor(bytes/MIB);
}
function checkMemory() {
  const available=availableMemoryMiB();
  const startup=fs.existsSync(path.join(root,'dist/src/memory-governor.js')) ? Math.min(opt.heap,1024) : opt.heap;
  const needed=startup+opt.reserve;
  if(!Number.isFinite(available) || available<=0) throw new Error('Cannot determine available RAM.');
  if(available<needed) throw new Error(`${available} MiB available; startup ${startup} + reserve ${opt.reserve} requires ${needed} MiB. Free RAM or review --reserve-mb.`);
  return `${available} MiB available; ${opt.heap} MiB old-space ceiling; ${startup} MiB startup + ${opt.reserve} MiB reserve`;
}
function runCheck(label,fn) { try { const detail=fn(); out('PASS',label,detail || ''); } catch(e) { out('FAIL',label,e.message); } }
let env, db, registry, entry, baseOptions;
// NODE_OPTIONS uses spaces and double quotes, not shell evaluation. Check its
// syntax without running user preloads, loaders, inspectors or profiler flags.
function validateNodeOptions(options) {
  const tokens=[]; let token='', quoted=false, started=false;
  for(let i=0;i<options.length;i++) {
    const c=options[i];
    if(c==='\\' && quoted) {
      if(++i>=options.length) throw new Error('NODE_OPTIONS ends in an incomplete quoted escape.');
      token+=options[i]; started=true;
    } else if(c==='"') {quoted=!quoted;started=true;}
    else if(c===' ' && !quoted) {if(started) tokens.push(token);token='';started=false;}
    else {token+=c;started=true;}
  }
  if(quoted) throw new Error('NODE_OPTIONS contains an unterminated double-quoted string.');
  if(started) tokens.push(token);
  // Node help provides the value-taking Node options for the selected runtime.
  // It runs with a minimal, clean environment; no user startup code can run.
  const help=spawnSync(runtime,['--help'],{encoding:'utf8',timeout:10000,
    env:{PATH:process.env.PATH || '',NODE_OPTIONS:'',NODE_DISABLE_COMPILE_CACHE:'1'}});
  if(help.error || help.status!==0) throw new Error('Could not inspect runtime option metadata.');
  const requires=new Set([...help.stdout.matchAll(/(--[a-z0-9-]+)=/g)].map(m=>m[1]));
  for(const n of ['--max-old-space-size','--max-semi-space-size','--stack-trace-limit','--heapsnapshot-near-heap-limit','--require','-r','-C','--import','--loader','--experimental-loader']) requires.add(n);
  const numeric=new Set(['--max-old-space-size','--max-semi-space-size','--stack-trace-limit','--heapsnapshot-near-heap-limit']);
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i], eq=token.indexOf('=');
    const flag=(eq<0?token:token.slice(0,eq)).replace(/_/g,'-');
    if(!runtimeAllowedFlags.has(flag)) throw new Error('NODE_OPTIONS contains an unsupported option or unexpected argument (value hidden).');
    let value=eq<0?undefined:token.slice(eq+1);
    if(requires.has(flag) && value===undefined) {
      if(i+1>=tokens.length || (tokens[i+1].startsWith('-') && !(flag==='--stack-trace-limit' && /^-[0-9]+$/.test(tokens[i+1])))) throw new Error(`NODE_OPTIONS option ${flag} needs a value.`);
      value=tokens[++i];
    }
    if(requires.has(flag) && value==='') throw new Error(`NODE_OPTIONS option ${flag} needs a nonempty value.`);
    const validInteger=flag==='--stack-trace-limit' ? /^-?[0-9]+$/ : /^[0-9]+$/;
    if(numeric.has(flag) && !validInteger.test(value || '')) throw new Error(`NODE_OPTIONS option ${flag} needs a valid integer.`);
  }
}

function selectRuntime(request) {
  if(!request) {runtime=process.execPath;runtimeVersion=process.version;runtimeArch=process.arch;runtimeAllowedFlags=process.allowedNodeEnvironmentFlags;return;}
  let chosen;
  if(request.includes('/')) chosen=path.resolve(cwd,request);
  else for(const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file=path.resolve(cwd,dir,request);
    try {fs.accessSync(file,fs.constants.X_OK);if(fs.statSync(file).isFile()){chosen=file;break;}} catch {}
  }
  if(!chosen) throw new Error('Node command was not found on PATH.');
  chosen=fs.realpathSync(chosen);fs.accessSync(chosen,fs.constants.X_OK);
  if(chosen===process.execPath) {runtime=chosen;runtimeVersion=process.version;runtimeArch=process.arch;runtimeAllowedFlags=process.allowedNodeEnvironmentFlags;return;}
  const probe=spawnSync(chosen,['--input-type=commonjs','-e',
    'console.log(JSON.stringify({version:process.version,arch:process.arch,flags:[...process.allowedNodeEnvironmentFlags]}))'],
    {cwd:root,env:{...process.env,NODE_OPTIONS:'',NODE_DISABLE_COMPILE_CACHE:'1'},encoding:'utf8',timeout:10000,maxBuffer:1048576});
  if(probe.error || probe.status!==0) throw new Error('Selected Node executable could not run (startup output hidden).');
  let info;try{info=JSON.parse(probe.stdout);}catch{throw new Error('Selected Node did not return runtime information.');}
  if(!/^v\d+\./.test(info.version) || Number(info.version.slice(1).split('.')[0])<24 || !Array.isArray(info.flags)) throw new Error('Selected runtime must be Node 24 or newer.');
  runtime=chosen;runtimeVersion=info.version;runtimeArch=info.arch;runtimeAllowedFlags=new Set(info.flags);
}

function configure() {
  env={...process.env};
  if(env.MANUAL_IMPORTER_OPTIONS_SET==='x') env.NODE_OPTIONS=env.MANUAL_IMPORTER_NODE_OPTIONS;
  else delete env.NODE_OPTIONS;
  delete env.MANUAL_IMPORTER_OPTIONS_SET; delete env.MANUAL_IMPORTER_NODE_OPTIONS;
  const config=opt.envFile || path.join(root,'.env');
  if(fs.existsSync(config) || opt.envFile) {
    regular(config);
    let parsed;
    try { parsed=parseEnv(fs.readFileSync(config,'utf8')); } catch { throw new Error('Cannot parse the selected environment file.'); }
    for(const [k,v] of Object.entries(parsed)) if(env[k]===undefined) env[k]=v;
    out('PASS','Configuration',config+' (values hidden; environment wins)');
  } else out('WARN','Configuration','No root .env; using environment and server defaults.');
  if(opt.dataDir) env.THREADSHELF_DATA_DIR=opt.dataDir;
  const data=env.THREADSHELF_DATA_DIR?.trim();
  // The server's load-env.ts also reads dataPath("env") without overriding
  // existing variables. Mirror that read so health and actual targets agree.
  const fallback=path.resolve(root,data ? path.join(data,'.env') : '.env');
  if(fallback!==config && fs.existsSync(fallback)) {
    regular(fallback);
    let parsed;
    try { parsed=parseEnv(fs.readFileSync(fallback,'utf8')); } catch { throw new Error('Cannot parse the server data-directory environment file.'); }
    for(const [k,v] of Object.entries(parsed)) if(env[k]===undefined) env[k]=v;
    out('INFO','Server data configuration',fallback+' (values hidden)');
  }
  const effectiveData=env.THREADSHELF_DATA_DIR?.trim();
  const base=path.resolve(root,effectiveData || '.');
  db=canonicalFuture(path.resolve(root,env.LANCEDB_PATH || path.join(base,effectiveData?'lancedb':'.lancedb')));
  registry=path.resolve(root,env.COLLECTIONS_PATH || path.join(base,effectiveData?'collections.json':'.collections.json'));
  env.PATH=path.dirname(runtime)+path.delimiter+(env.PATH || '');
  env.XDG_CACHE_HOME ||= path.join(root,'.local/cache');
  env.HF_HOME ||= path.join(root,'.local/huggingface');
  baseOptions=env.NODE_OPTIONS || '';
  if(/--max[-_]old[-_]space[-_]size[-_]percentage(?:[=\s"']|$)/.test(baseOptions))
    throw new Error('NODE_OPTIONS contains a percentage heap limit; remove it before using --heap-mb.');
  // Validate option syntax in a clean process without executing inherited preloads.
  if(baseOptions.includes('\0') || /[\r\n]/.test(baseOptions)) throw new Error('NODE_OPTIONS must be a single line.');
  validateNodeOptions(baseOptions);
  out('PASS','NODE_OPTIONS',baseOptions ? 'Preserved for importer only; values hidden; explicit heap overrides absolute limit.' : 'Explicit heap only.');
}
const skip=new Set(['users.json','projects.json','user.json','message_feedback.json','shared_conversations.json','sora.json','applet_access_history.json']);
function candidate(name) {
  const lower=name.toLowerCase();
  if(skip.has(lower)) return false;
  if(!/\.(?:json|html?|zip)$/.test(lower) && /^file[-_]/.test(lower)) return false;
  return /\.(?:json|html?|zip)$/.test(lower) || !name.includes('.');
}
function fresh(file,st) {
  if(opt.age && (st.mtimeMs>Date.now()+1000 || Date.now()-st.mtimeMs>opt.age*86400000))
    throw new Error(`File outside --max-age-days ${opt.age}: ${file}`);
}
function scan(plannedCopy) {
  const list=[]; let all=0;
  function walk(dir,depth) {
    if(depth>64) throw new Error('Folder nesting exceeds the server limit (64).');
    for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(++all>1000000) throw new Error('Import tree exceeds 1,000,000 entries; choose a narrower folder.');
      const file=path.join(dir,ent.name);
      if(ent.isSymbolicLink() || (!ent.isDirectory() && !ent.isFile())) throw new Error(`Symlink/special entry refused: ${file}`);
      if(ent.isDirectory()) walk(file,depth+1);
      else if(candidate(ent.name)) {
        if(plannedCopy && opt.source && file===path.join(opt.input,'conversations.json')) continue;
        const st=regular(file); fresh(file,st);
        if(st.size===0) throw new Error(`Empty export candidate: ${file}`);
        list.push({file,st});
        if(list.length>100000) throw new Error('Too many export candidates (server limit: 100000).');
      }
    }
  }
  walk(opt.input,0);
  if(plannedCopy && opt.source) {
    const st=regular(opt.source); fresh(opt.source,st);
    if(!st.size) throw new Error('Source JSON is empty.');
    list.push({file:path.join(opt.input,'conversations.json'),st});
  }
  if(list.length>100000) throw new Error('Too many export candidates (server limit: 100000).');
  const byKey=new Map();
  for(const item of list) {
    const key=path.relative(opt.input,item.file).replace(/\\/g,'/').toLowerCase().replace(/\.json$/,'');
    const existing=byKey.get(key);
    if(!existing || (item.file.toLowerCase().endsWith('.json') && !existing.file.toLowerCase().endsWith('.json'))) byKey.set(key,item);
  }
  const chosen=[...byKey.values()];
  if(!chosen.length) throw new Error('No export candidates found.');
  return { count:chosen.length, bytes:chosen.reduce((a,b)=>a+b.st.size,0),
    largest:Math.max(...chosen.map(x=>x.st.size)),
    snapshot:chosen.map(x=>[x.file,x.st.dev,x.st.ino,x.st.size,x.st.mtimeMs,x.st.ctimeMs]),
    mixed:chosen.some(x=>/\.(html?|zip)$/i.test(x.file)) && chosen.some(x=>/\.json$/i.test(x.file)) };
}
function checkSource(checkSpace=true) {
  if(!opt.source) return 'Direct folder import; no source copy.';
  const st=regular(opt.source); fresh(opt.source,st);
  const dest=path.join(opt.input,'conversations.json');
  if(fs.realpathSync(opt.source)===dest) throw new Error('Source already is conversations.json in import folder; omit --source-json.');
  if(inside(opt.input,fs.realpathSync(opt.source))) throw new Error('Copy source must be outside the import folder to avoid importing it twice.');
  for(const target of [dest,dest+'.sha256']) {
    if(fs.existsSync(target) || (()=>{try{fs.lstatSync(target);return true;}catch{return false;}})()) {
      const dst=regular(target);
      if(dst.dev===st.dev && dst.ino===st.ino) throw new Error('Source and destination refer to the same file.');
      if(!opt.replace) throw new Error('Destination exists; explicitly select --replace-source.');
    }
  }
  fs.accessSync(opt.input,fs.constants.W_OK|fs.constants.X_OK);
  const free=freeDisk(opt.input);
  if(checkSpace && free<st.size+16*MIB) throw new Error(`Source staging requires ${size(st.size+16*MIB)} free; ${size(free)} available.`);
  return `${opt.source} -> ${dest}; ${size(st.size)}; SHA-256 verification planned; other files kept`;
}
function diskCheck() {
  fs.accessSync(nearestDir(db),fs.constants.W_OK|fs.constants.X_OK);
  fs.accessSync(nearestDir(path.dirname(registry)),fs.constants.W_OK|fs.constants.X_OK);
  const free=freeDisk(db);
  if(free<opt.disk*MIB) throw new Error(`${size(free)} free; minimum ${opt.disk} MiB required.`);
  return `${size(free)} free on database filesystem; minimum ${opt.disk} MiB`;
}
function lock(key) {
  const dir=path.join(os.tmpdir(),`threadshelf-manual-importer-${process.getuid()}`);
  try { fs.mkdirSync(dir,{mode:0o700}); } catch(e) { if(e.code!=='EEXIST') throw e; }
  const ds=fs.lstatSync(dir);
  if(!ds.isDirectory() || ds.isSymbolicLink() || ds.uid!==process.getuid() || (ds.mode&0o077)) throw new Error('Unsafe wrapper lock directory.');
  const file=path.join(dir,crypto.createHash('sha256').update(key).digest('hex')+'.lock');
  const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  lockFds.push(fd);
  const st=fs.fstatSync(fd);
  if(!st.isFile() || st.uid!==process.getuid() || st.nlink!==1) throw new Error('Unsafe wrapper lock file.');
  const result=spawnSync('flock',['--exclusive','--nonblock','3'],{stdio:['ignore','ignore','pipe',fd],env:{...process.env,NODE_OPTIONS:''}});
  if(result.error || result.status!==0) throw new Error('Another manual-importer run holds this folder/collection lock, or flock failed.');
}
function signature(file) { const s=regular(file); return JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]); }
async function hashFile(file) { const hash=crypto.createHash('sha256'); await pipeline(fs.createReadStream(file),hash); return hash.digest('hex'); }
async function copySource() {
  if(!opt.source) return;
  checkSource();
  const before=signature(opt.source), st=regular(opt.source);
  tempDir=fs.mkdtempSync(path.join(opt.input,'.manual-importer-'));
  fs.chmodSync(tempDir,0o700);
  const stage=path.join(tempDir,'copy.tmp'), sum=path.join(tempDir,'checksum.tmp');
  await pipeline(fs.createReadStream(opt.source),fs.createWriteStream(stage,{flags:'wx',mode:0o600}));
  fs.utimesSync(stage,st.atime,st.mtime);
  const copied=await hashFile(stage), original=await hashFile(opt.source);
  if(before!==signature(opt.source) || copied!==original) throw new Error('Source changed during copying or SHA-256 verification failed.');
  fs.writeFileSync(sum,`${copied}  conversations.json\n`,{flag:'wx',mode:0o600});
  const dest=path.join(opt.input,'conversations.json');
  checkSource(false);
  if(opt.replace) {
    // Each rename is atomic; a process/power failure between them can leave an
    // older checksum beside the new JSON. Ingestion has not started at that point.
    fs.renameSync(stage,dest); fs.renameSync(sum,dest+'.sha256');
  } else {
    // Link without clobbering files created since preflight.
    fs.linkSync(stage,dest);
    try { fs.linkSync(sum,dest+'.sha256'); }
    catch(e) { if(signature(dest)===signature(stage)) fs.unlinkSync(dest); throw e; }
  }
  fs.rmSync(tempDir,{recursive:true,force:true}); tempDir=null;
  out('PASS','Source copy','Timestamp preserved; SHA-256 verified; checksum written.');
}
async function confirm() {
  if(opt.yes) return;
  if(!process.stdin.isTTY) usage('Interactive confirmation requires a terminal; use --yes for unattended execution.');
  const rl=readline.createInterface({input:process.stdin,output:process.stderr});
  try {
    const prompt=opt.clear ? `Type ${opt.collection} to replace that collection (anything else cancels): ` : 'Start import'+(opt.source?' and the source copy shown above':'')+'? [y/N] ';
    let answer;
    try { answer=(await rl.question(prompt)).trim(); }
    catch { const e=new Error('Input closed; cancelled before any changes.'); e.exitCode=130; throw e; }
    if(opt.clear ? answer!==opt.collection : !/^y(es)?$/i.test(answer)) { const e=new Error('Cancelled before any changes.'); e.exitCode=130; throw e; }
  } finally { rl.close(); }
}
function command() { return [runtime,`--max-old-space-size=${opt.heap}`,entry,opt.input,opt.collection,...(opt.clear?['--clear']:[])]; }
async function runImporter() {
  const cmd=command(), started=Date.now();
  out('INFO','Import started',`collection=${opt.collection}; Ctrl+C cancels; server output follows`);
  const code=await new Promise((resolve,reject)=>{
    child=spawn(cmd[0],cmd.slice(1),{cwd:root,env,stdio:'inherit',detached:true});
    childGroup=child.pid;
    child.once('error',reject);
    child.once('exit',async (status,signal)=>{
      child=null;
      if(stopCode) {
        // A descendant may outlive the leader. Keep the original process group
        // and locks until shutdown completes, or the bounded escalation fires.
        while(groupAlive() && Date.now()-stopAt<10000)
          await new Promise(r=>setTimeout(r,100));
        if(groupAlive()) signalGroup('SIGKILL');
      }
      if(killTimer) clearTimeout(killTimer);
      childGroup=null;
      resolve(stopCode || (status===null ? 128+(os.constants.signals[signal] || 1) : status));
    });
  });
  out(code===0?'PASS':'FAIL','Import finished',`exit=${code}; elapsed=${((Date.now()-started)/1000).toFixed(1)} s`);
  if(code!==0) out('WARN','Import incomplete','Review server output. Completed writes/source copies are not rolled back.');
  return code;
}
function groupAlive() {
  if(!childGroup) return false;
  try {process.kill(-childGroup,0);return true;} catch(e) {return e.code==='EPERM';}
}
function signalGroup(signal) {
  if(!childGroup) return;
  try {process.kill(-childGroup,signal);} catch(e) {if(e.code!=='ESRCH') out('WARN','Signal delivery',e.message);}
}
function stop(signal) {
  if(stopCode) return;
  stopCode={SIGINT:130,SIGTERM:143,SIGHUP:129}[signal];
  if(childGroup) {
    stopAt=Date.now();
    out('WARN','Stopping importer','Forwarding SIGTERM to its process group.');
    signalGroup('SIGTERM');
    killTimer=setTimeout(()=>signalGroup('SIGKILL'),10000);
  } else process.exit(stopCode);
}
async function operation() {
  failures=0; warnings=0;
  validateOptions();
  if(Number(process.versions.node.split('.')[0])<24) throw new Error('Node 24+ required.');
  process.chdir(root);
  out('INFO','ThreadShelf Enhanced manual importer',opt.health?'read-only health':opt.dry?'read-only dry run':'preflight');
  out('PASS','Root',root);
  runCheck('Runtime',()=>{selectRuntime(opt.node); return `${runtime} (${runtimeVersion}; ${runtimeArch})`;});
  runCheck('Server build',()=>{
    const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    if(pkg.name!=='threadshelf-enhanced') throw new Error('Script must be in the ThreadShelf Enhanced repository root.');
    if(!fs.statSync(path.join(root,'src')).isDirectory()) throw new Error('Source repository layout required.');
    const version=String(pkg.version).split('.').map(Number);
    if(!(version[0]>1 || (version[0]===1 && version[1]>=2))) throw new Error('ThreadShelf Enhanced 1.2.0+ required.');
    entry=path.join(root,'dist/src/ingest-cli.js'); regular(entry);
    for(const file of ['ingest.js','store.js','paths.js','validation.js']) regular(path.join(root,'dist/src',file));
    return `version ${pkg.version}; compiled importer present`;
  });
  runCheck('Dependencies',()=>{
    const req=createRequire(path.join(root,'package.json'));
    for(const dep of ['@lancedb/lancedb','@huggingface/transformers','@zip.js/zip.js','parse5']) req.resolve(dep);
    return 'Required packages resolve (native/model execution checked by importer).';
  });
  runCheck('Lock utility',()=>{
    const r=spawnSync('flock',['--version'],{encoding:'utf8'});
    if(r.error || r.status!==0) throw new Error('Install util-linux (flock) first.');
    return 'flock available; locks acquired only for actual imports';
  });
  runCheck('Environment',()=>{configure(); return 'Loaded as data; no shell evaluation.';});
  out('INFO','Collection',opt.collection+'; '+(opt.clear?'REPLACE (--clear)':'UPDATE (--no-clear; default)'));
  if(db) out('INFO','Database',db);
  if(registry) out('INFO','Collection registry',registry);
  if(opt.clear) out('WARN','Replacement','Existing collection data may be replaced after staging.');
  runCheck('Import directory',()=>{
    const st=fs.lstatSync(opt.input);
    if(!st.isDirectory() || st.isSymbolicLink()) throw new Error('Import root must be a real directory, not a symlink.');
    opt.input=fs.realpathSync(opt.input);
    if(inside(opt.input,root) || inside(root,opt.input) && ['.local','node_modules','dist','src','client','.git'].some(n=>inside(path.join(root,n),opt.input)))
      throw new Error('Choose a dedicated export folder, not repository/runtime/source trees.');
    if(db && (inside(opt.input,db) || inside(db,opt.input))) throw new Error('Import and database directories overlap.');
    if(registry && inside(opt.input,registry)) throw new Error('Import folder contains the collection registry.');
    return opt.input;
  });
  runCheck('Source action',checkSource);
  let planned;
  runCheck('Export candidates',()=>{
    planned=scan(true);
    return `${planned.count} file(s); ${size(planned.bytes)} total; largest ${size(planned.largest)}; metadata checked, content not parsed`;
  });
  if(planned?.mixed) out('WARN','Mixed formats','JSON plus HTML/ZIP detected; check for duplicate conversations.');
  runCheck('Available memory',checkMemory);
  if(db && registry) runCheck('Available disk',diskCheck);
  const session=process.env.TMUX?'tmux':process.env.STY?'GNU Screen':null;
  out(session?'PASS':opt.session?'FAIL':'WARN','Terminal session',session || 'No tmux/Screen detected; keep the terminal/session alive.');
  out('INFO','Freshness',opt.age?`maximum ${opt.age} day(s)`:'disabled; archived exports allowed');
  out('WARN','Resource estimates','RAM/disk checks are snapshots; the server memory governor monitors imports. Native allocations and disk staging need headroom.');
  if(failures) { out('INFO','Readiness',`${failures} failed check(s), ${warnings} warning(s); no import or copy performed.`); return 1; }
  out('PASS','Readiness',`${warnings} warning(s); all required checks passed`);
  out('INFO','Command',`cd ${quote(root)} && ${command().map(quote).join(' ')}`);
  if(opt.health || opt.dry) { out('INFO','Inspection complete','No files changed; importer not started.'); return 0; }
  await confirm();
  attemptedWrite=true;
  lock('collection\0'+db+'\0'+opt.collection);
  lock('input\0'+opt.input);
  if(JSON.stringify(scan(true).snapshot)!==JSON.stringify(planned.snapshot)) throw new Error('Input changed since preflight; rerun to review it.');
  checkMemory(); diskCheck(); checkSource();
  await copySource();
  scan(false); checkMemory(); diskCheck();
  return await runImporter();
}

async function wizard() {
  if(!process.stdin.isTTY) usage('The interactive importer needs a terminal; use --non-interactive --import-dir DIR --yes for unattended use.');
  if(Number(process.versions.node.split('.')[0])<24) throw new Error('Node 24+ required.');
  process.stderr.write('\n  THREADSHELF ENHANCED\n  Interactive importer\n  Flags keep their values; setup asks only for missing settings.\n\n');
  let rl;
  const open=()=>{rl=readline.createInterface({input:process.stdin,output:process.stderr});};
  const close=()=>{if(rl)rl.close();};
  open();
  const supplied={input:['--import-dir'],collection:['--collection'],clear:['--clear','--no-clear'],heap:['--heap-mb'],
    reserve:['--reserve-mb'],disk:['--min-free-disk-mb'],age:['--max-age-days'],source:['--source-json','--no-source-json'],
    replace:['--replace-source','--no-replace-source'],session:['--require-session','--no-require-session'],
    envFile:['--env-file'],dataDir:['--data-dir'],node:['--node'],color:['--color']};
  const answered=new Set();
  const given=key=>supplied[key].some(f=>seen.has(f));
  const edited=key=>{answered.add(key);supplied[key].forEach(f=>seen.delete(f));};
  const rawPath=value=>path.resolve(cwd,value.startsWith('~/')?path.join(os.homedir(),value.slice(2)):value);
  async function ask(prompt,fallback='') {
    try {
      const answer=(await rl.question(`${prompt}${fallback!==''?' ['+safe(fallback)+']':''}: `)).trim();
      return answer || String(fallback);
    } catch {const e=new Error('Input closed; cancelled.');e.exitCode=130;throw e;}
  }
  async function yesNo(prompt,defaultValue=false) {
    while(true) {
      const a=(await ask(prompt,defaultValue?'Y':'N')).toLowerCase();
      if(['y','yes'].includes(a))return true;
      if(['n','no'].includes(a))return false;
      out('WARN','Answer not accepted','Enter Y or N.');
    }
  }
  async function editNumber(key,prompt,min,max) {
    while(true) {
      const old=opt[key];opt[key]=await ask(prompt,old);
      try {number(key,min,max);edited(key);return;}
      catch(e){opt[key]=old;out('WARN','Value not accepted',e.message);}
    }
  }
  async function inputPath() {
    while(true) {
      const value=await ask('Export folder path (q to cancel)',opt.input || '');
      if(value.toLowerCase()==='q')return false;
      if(!value){out('WARN','Folder required','Enter an existing directory containing your exports.');continue;}
      const next=rawPath(value);
      try {
        const st=fs.lstatSync(next);
        if(!st.isDirectory() || st.isSymbolicLink())throw new Error('Use a real directory, not a symlink.');
        opt.input=next;edited('input');return true;
      } catch(e){out('WARN','Folder not accepted',e.message);}
    }
  }
  async function collection() {
    while(true) {
      const old=opt.collection;opt.collection=await ask('Collection name',old);
      try{validateOptions(false);edited('collection');return;}
      catch(e){opt.collection=old;out('WARN','Collection not accepted',e.message);}
    }
  }
  async function action() {
    while(true) {
      const a=(await ask('Action: U = update, R = replace',opt.clear?'R':'U')).toLowerCase();
      if(!['u','r'].includes(a)){out('WARN','Action not accepted','Choose U or R.');continue;}
      opt.clear=a==='r';edited('clear');
      if(opt.clear)out('WARN','Replacement selected','You must type the collection name before import.');
      return;
    }
  }
  async function heap() {
    out('INFO','Current memory',`${availableMemoryMiB()} MiB available; startup work needs additional reserve; the heap ceiling is not reserved.`);
    await editNumber('heap','Heap allowance in MiB',512,1048576);
    if(reserveAuto)opt.reserve=Math.max(2048,Math.ceil(opt.heap/4));
  }
  async function replacement() {
    opt.replace=await yesNo('Allow replacing folder conversations.json and its checksum? y/N',opt.replace);
    edited('replace');
  }
  async function source(guided=false) {
    while(true) {
      const value=await ask('Optional source JSON path; enter - to disable',opt.source || '-');
      if(value==='-'){
        if(guided && given('replace') && opt.replace){out('WARN','Source required','--replace-source needs a source JSON; enter its path.');continue;}
        delete opt.source;opt.replace=false;edited('source');edited('replace');return;
      }
      try {const next=rawPath(value);regular(next);opt.source=next;edited('source');break;}
      catch(e){out('WARN','Source not accepted',e.message);}
    }
    if(!guided || !given('replace'))await replacement();
  }
  async function reserve() {
    while(true) {
      const value=await ask('Memory reserve MiB, or auto',reserveAuto?'auto':opt.reserve);
      if(value.toLowerCase()==='auto'){reserveAuto=true;opt.reserve=Math.max(2048,Math.ceil(opt.heap/4));edited('reserve');return;}
      const old=opt.reserve;opt.reserve=value;
      try{number('reserve',256,1048576);reserveAuto=false;edited('reserve');return;}
      catch(e){opt.reserve=old;out('WARN','Reserve not accepted',e.message);}
    }
  }
  async function pathSetting(key,prompt) {
    while(true) {
      const value=await ask(prompt,opt[key] || '-');
      if(value==='-'){delete opt[key];edited(key);return;}
      const next=rawPath(value);
      try {
        if(key==='envFile')regular(next);else nearestDir(next);
        opt[key]=next;edited(key);return;
      } catch(e){out('WARN','Path not accepted',e.message);}
    }
  }
  async function nodeSetting() {
    while(true) {
      const value=await ask('Node executable or command; - restores detected runtime',opt.node || '-');
      const next=value==='-'?undefined:value.startsWith('~/')?rawPath(value):value;
      try{selectRuntime(next);opt.node=next;edited('node');return;}
      catch(e){out('WARN','Runtime not accepted',e.message);}
    }
  }
  async function colorSetting() {
    while(true) {
      const value=(await ask('Color: auto, always or never',opt.color)).toLowerCase();
      if(['auto','always','never'].includes(value)){opt.color=value;edited('color');return;}
      out('WARN','Color not accepted','Choose auto, always or never.');
    }
  }
  const advanced=[
    ['source','Source copy',()=>source(true)],
    ['reserve','Memory reserve',reserve],
    ['disk','Free disk minimum',()=>editNumber('disk','Minimum free database disk space in MiB',0,1073741824)],
    ['age','Export age limit',()=>editNumber('age','Maximum age in days (0 disables)',0,365000)],
    ['session','Terminal session',async()=>{opt.session=await yesNo('Require tmux/Screen? y/N',opt.session);edited('session');}],
    ['envFile','Environment file',()=>pathSetting('envFile','Environment file; - uses root .env/defaults')],
    ['dataDir','Data directory',()=>pathSetting('dataDir','Data directory override; - uses configured defaults')],
    ['node','Node runtime',nodeSetting],
    ['color','Color output',colorSetting]
  ];
  async function advancedMenu() {
    while(true) {
      process.stderr.write('\n  ADVANCED SETTINGS\n');
      for(let i=0;i<advanced.length;i++)process.stderr.write(`  ${i+1}  ${advanced[i][1]}\n`);
      process.stderr.write('  B  Back to review\n');
      const a=(await ask('Advanced choice 1-9 or B','B')).toLowerCase();
      if(a==='b')return;
      if(/^[1-9]$/.test(a)){await advanced[Number(a)-1][2]();continue;}
      out('WARN','Unknown choice','Choose 1-9 or B.');
    }
  }
  try {
    if(!given('input') && !await inputPath())return 130;
    if(!given('collection'))await collection();
    if(!given('clear'))await action();
    if(!given('heap'))await heap();
    if(opt.replace && !opt.source)await source(true);
    else if(opt.source && !given('replace'))await replacement();
    if(advanced.some(([key])=>!given(key) && !answered.has(key)) && await yesNo('Configure optional settings? y/N')) {
      for(const [key,,edit] of advanced)if(!given(key) && !answered.has(key))await edit();
    }
    while(true) {
      process.stderr.write('\n  IMPORT SETTINGS\n');
      const tagged=(key,value)=>safe(value)+(given(key)?'  [flag]':'');
      const settings=[['1  Folder',tagged('input',opt.input)],['2  Collection',tagged('collection',opt.collection)],
        ['3  Action',tagged('clear',opt.clear?'Replace collection (--clear)':'Update collection (keep unrelated records)')],
        ['4  Heap',tagged('heap',`${opt.heap} MiB; reserve ${opt.reserve} MiB; available ${availableMemoryMiB()} MiB`)],
        ['5  Source copy',tagged('source',opt.source || 'None - import the folder as it is')],
        ['6  Advanced',`freshness ${opt.age?opt.age+' days':'off'}; disk minimum ${opt.disk} MiB; session ${opt.session?'required':'optional'}`],
        ['   Configuration',tagged('envFile',opt.envFile || 'root .env / defaults')],
        ['   Data directory',tagged('dataDir',opt.dataDir || 'configured server location')],
        ['   Node runtime',tagged('node',opt.node || runtime)]];
      for(const [name,value] of settings)process.stderr.write(`  ${name.padEnd(18)} ${value}\n`);
      process.stderr.write('\n  H  Health check     P  Preview plan\n  I  Start import     Q  Quit without importing\n');
      const choice=(await ask('Choose 1-6, H, P, I or Q','H')).toLowerCase();
      if(choice==='q'){out('INFO','Cancelled','No import started.');return 130;}
      if(choice==='1'){if(!await inputPath())return 130;}
      else if(choice==='2')await collection();
      else if(choice==='3')await action();
      else if(choice==='4')await heap();
      else if(choice==='5')await source();
      else if(choice==='6')await advancedMenu();
      else if(['h','p','i'].includes(choice)) {
        close();opt.health=choice==='h';opt.dry=choice==='p';
        let result;
        try{result=await operation();}finally{opt.health=false;opt.dry=false;}
        if(choice==='i' && attemptedWrite)return result;
        open();
        if(choice==='i' && result!==0)out('WARN','Import not started','Adjust settings, inspect health, then try again.');
      } else out('WARN','Unknown choice','Choose 1-6, H, P, I or Q.');
    }
  } finally{close();}
}
async function main() {
  parse();
  return opt.interactive ? wizard() : operation();
}

for(const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,()=>stop(signal));
process.on('exit',()=>{
  if(tempDir) { try { fs.rmSync(tempDir,{recursive:true,force:true}); } catch {} }
  for(const fd of lockFds) { try { fs.closeSync(fd); } catch {} }
});
main().then(code=>{process.exitCode=code;}).catch(e=>{out('FAIL','Stopped',e.message);process.exitCode=e.exitCode || 1;});
NODE
)" "$ROOT" "$@"
