'use strict';
const fs=require('node:fs/promises');const fileConstants=require('node:fs').constants;const path=require('node:path');const crypto=require('node:crypto');const {atomicJSON,PROVIDERS}=require('./settings.cjs');
const KEY=/^[a-f0-9]{64}$/;
const OWN_FILE=/^([a-f0-9]{64})\.audio(?:\.([a-f0-9]{16})\.tmp)?$/;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sameFile=(a,b)=>a.exists===b.exists&&(!a.exists||a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.regular===b.regular);
const statIdentity=st=>({exists:true,regular:st.isFile()&&!st.isSymbolicLink(),dev:st.dev,ino:st.ino,size:st.isFile()?st.size:0,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs});
const MAX_RECORDING_BYTES=64*1024**2;
const MAX_SESSION_BYTES=256*1024**2;
const CACHE_AUDIO_TYPES=new Set(['audio/wav','audio/mpeg','audio/ogg','audio/mp4','application/vnd.threadshelf.tts-clips-v1']);
function matchesFilter(e,filter={}){const scope=filter.scope||'all';return scope==='all'||scope==='conversation'&&e.sourceId===filter.sourceId||scope==='provider'&&e.provider===filter.provider||scope==='older'&&Date.now()-Date.parse(e.createdAt)>filter.olderThanDays*86400000||scope==='selected'&&filter.keys.includes(e.key)||scope==='incomplete'&&!e.complete;}
class SessionAudioCache{
 constructor({maxEntries=3,maxBytes=MAX_RECORDING_BYTES}={}){if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>3||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_SESSION_BYTES)throw Error('Invalid speech session cache limit.');this.maxEntries=maxEntries;this.maxBytes=maxBytes;this.entries=new Map();this.totalBytes=0;}
 resize(maxBytes){if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_SESSION_BYTES)throw Error('Invalid speech session cache limit.');this.maxBytes=maxBytes;while(this.totalBytes>this.maxBytes)this.delete(this.entries.keys().next().value);return this.summary();}
 peek(key){return this.entries.get(key)||null;}
 get(key){const entry=this.peek(key);if(!entry)return null;this.entries.delete(key);entry.lastUsedAt=new Date().toISOString();this.entries.set(key,entry);return entry;}
 put(key,bytes,meta){if(!KEY.test(key)||!Buffer.isBuffer(bytes)||!bytes.length||meta?.complete!==true)throw Error('Only completed speech can be retained for this session.');if(bytes.length>MAX_RECORDING_BYTES||bytes.length>this.maxBytes)return false;const copy=Buffer.from(bytes);this.delete(key);while(this.entries.size>=this.maxEntries||this.totalBytes+copy.length>this.maxBytes)this.delete(this.entries.keys().next().value);const now=new Date().toISOString();this.entries.set(key,{...meta,key,nonce:crypto.randomBytes(16).toString('hex'),bytes:copy,byteLength:copy.length,createdAt:meta.createdAt||now,lastUsedAt:now,complete:true});this.totalBytes+=copy.length;return true;}
 delete(key){const entry=this.entries.get(key);if(!entry)return false;this.entries.delete(key);this.totalBytes-=entry.byteLength;entry.bytes.fill(0);return true;}
 clear(){for(const key of this.entries.keys())this.delete(key);}
 summary(){return {count:this.entries.size,totalBytes:this.totalBytes,maxEntries:this.maxEntries,maxBytes:this.maxBytes};}
}
class AudioCache{
 constructor(profileDir,{sessionCache=null}={}){this.dir=path.join(profileDir,'tts-cache');this.indexFile=path.join(this.dir,'index-v1.json');this.entries=new Map();this.previews=new Map();this.active=new Set();this.validationMemo=new Map();this.sessionCache=sessionCache;this.queue=Promise.resolve();this.ready=this.load();}
 async load(){try{const raw=await fs.readFile(this.indexFile,'utf8');if(raw.length>16*1024**2)throw Error('Large cache index');const data=JSON.parse(raw);if(data.schemaVersion!==1||!Array.isArray(data.entries))return;for(const e of data.entries){if(!e||!KEY.test(e.key)||!KEY.test(e.digest)||!Number.isSafeInteger(e.bytes)||e.bytes<1||e.bytes>64*1024**2||!PROVIDERS.includes(e.provider)||typeof e.sourceId!=='string'||typeof e.messageId!=='string'||typeof e.pinned!=='boolean'||e.complete!==undefined&&typeof e.complete!=='boolean'||!Number.isFinite(Date.parse(e.createdAt))||!Number.isFinite(Date.parse(e.lastUsedAt)))continue;this.entries.set(e.key,{...e,complete:e.complete!==false});}}catch{} }
 async serial(fn){const run=this.queue.then(async()=>{await this.ready;return fn();});this.queue=run.catch(()=>{});return run;}
 async persist(){await atomicJSON(this.indexFile,{schemaVersion:1,entries:[...this.entries.values()]});}
 file(key){if(!KEY.test(key))throw new Error('Invalid TTS cache key.');return path.join(this.dir,key+'.audio');}
 async identify(fileName){if(!OWN_FILE.test(fileName))throw Error('Invalid internal cache filename.');try{return statIdentity(await fs.lstat(path.join(this.dir,fileName)));}catch(error){if(error.code==='ENOENT')return {exists:false,regular:false,size:0};throw error;}}
 async available(key,maxAgeDays){return this.serial(async()=>{
  const entry=this.entries.get(key);if(!entry||entry.complete!==true||!CACHE_AUDIO_TYPES.has(entry.mime)||maxAgeDays&&!entry.pinned&&Date.now()-Date.parse(entry.createdAt)>=maxAgeDays*86400000)return false;
  let identity;try{identity=await this.identify(key+'.audio');}catch{return false;}
  const prior=this.validationMemo.get(key);if(prior&&prior.digest===entry.digest&&prior.bytes===entry.bytes&&sameFile(prior.identity,identity))return prior.valid;
  const remember=valid=>{this.validationMemo.delete(key);this.validationMemo.set(key,{identity,digest:entry.digest,bytes:entry.bytes,valid});while(this.validationMemo.size>1024)this.validationMemo.delete(this.validationMemo.keys().next().value);return valid;};
  if(!identity.regular||identity.size!==entry.bytes)return remember(false);
  // Hash through a small stream rather than materializing or retaining audio.
  // Stat identity (including ctime) safely reuses this result on later checks.
  let handle;try{
   handle=await fs.open(this.file(key),fileConstants.O_RDONLY|(fileConstants.O_NOFOLLOW||0));if(!sameFile(identity,statIdentity(await handle.stat())))return remember(false);
   const hash=crypto.createHash('sha256');let bytes=0;for await(const chunk of handle.createReadStream({highWaterMark:64*1024,autoClose:false})){bytes+=chunk.length;if(bytes>entry.bytes)return remember(false);hash.update(chunk);}
   const unchanged=sameFile(identity,statIdentity(await handle.stat()))&&sameFile(identity,await this.identify(key+'.audio'));
   return remember(unchanged&&bytes===entry.bytes&&hash.digest('hex')===entry.digest);
  }catch{return false;}finally{await handle?.close().catch(()=>{});}
 });}
 async scan(){
  const rows=[],known=new Set();
  for(const e of this.entries.values()){const fileName=e.key+'.audio',identity=await this.identify(fileName);known.add(fileName);rows.push({...e,fileName,identity,cacheKey:e.key,recordedBytes:e.bytes,bytes:identity.regular?identity.size:0,diskBytes:identity.regular?identity.size:0,complete:e.complete===true&&identity.regular&&identity.size===e.bytes,deletable:!identity.exists||identity.regular,orphan:false});}
  let names=[];try{names=await fs.readdir(this.dir);}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const fileName of names){const match=OWN_FILE.exec(fileName);if(!match||known.has(fileName))continue;const identity=await this.identify(fileName);if(!identity.regular)continue;const stamp=new Date(identity.mtimeMs).toISOString();rows.push({key:match[2]?digest('orphan\0'+fileName):match[1],cacheKey:match[1],fileName,identity,provider:'unknown',model:'',voice:'',sourceId:'',messageId:'',mime:'',bytes:identity.size,diskBytes:identity.size,recordedBytes:0,createdAt:stamp,lastUsedAt:stamp,pinned:false,complete:false,deletable:true,orphan:true});}
  return rows;
 }
 async list(){return this.serial(async()=>{const entries=(await this.scan()).map(({fileName,identity,cacheKey,...e})=>e);return {entries:entries.sort((a,b)=>b.lastUsedAt.localeCompare(a.lastUsedAt)),totalBytes:entries.reduce((n,e)=>n+e.bytes,0),...(this.sessionCache?{session:this.sessionCache.summary()}:{})};});}
 async get(key,maxAgeDays){return this.serial(async()=>{const e=this.entries.get(key);if(!e||e.complete!==true)return null;if(maxAgeDays&&!e.pinned&&Date.now()-Date.parse(e.createdAt)>maxAgeDays*86400000)return null;try{const st=await fs.lstat(this.file(key));if(!st.isFile()||st.isSymbolicLink()||st.size!==e.bytes)return null;const bytes=await fs.readFile(this.file(key));if(digest(bytes)!==e.digest)return null;e.lastUsedAt=new Date().toISOString();await this.persist();return {bytes,mime:e.mime,entry:{...e}};}catch{return null;}});}
 async put(key,bytes,meta,maxBytes,maxAgeDays,{signal}={}){return this.serial(async()=>{
  signal?.throwIfAborted();if(meta.complete!==undefined&&meta.complete!==true)throw Error('Only completed speech can be saved to the TTS cache.');
  if(bytes.length>maxBytes||bytes.length>64*1024**2)return false;
  // A pin protects the original recording's bytes and metadata even when a
  // caller regenerates the same synthesis identity. The service uses a new key.
  if(this.entries.get(key)?.pinned)return false;
  const current=this.entries.get(key),rows=await this.scan(),existing=rows.find(e=>e.fileName===key+'.audio');let total=rows.reduce((n,e)=>n+e.bytes,0)-(existing?.bytes||0);
  const candidates=rows.filter(e=>e.key!==key&&e.deletable&&!e.pinned&&!this.active.has(e.cacheKey)).sort((a,b)=>Number(b.orphan)-Number(a.orphan)||a.lastUsedAt.localeCompare(b.lastUsedAt));
  for(const e of candidates){const expired=maxAgeDays&&Date.now()-Date.parse(e.createdAt)>maxAgeDays*86400000;if(total+bytes.length<=maxBytes&&!expired&&!e.orphan)continue;const now=await this.identify(e.fileName);if(!sameFile(now,e.identity)||now.exists&&!now.regular)continue;await fs.rm(path.join(this.dir,e.fileName),{force:true});if(!e.orphan)this.entries.delete(e.key);total-=e.bytes;}
  if(total+bytes.length>maxBytes){await this.persist();return false;}
  await fs.mkdir(this.dir,{recursive:true,mode:0o700});const target=this.file(key),temp=target+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{await fs.writeFile(temp,bytes,{mode:0o600,flag:'wx'});signal?.throwIfAborted();await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
  const now=new Date().toISOString();this.entries.set(key,{key,...meta,bytes:bytes.length,digest:digest(bytes),createdAt:Number.isFinite(Date.parse(meta.createdAt))?meta.createdAt:now,lastUsedAt:now,pinned:current?current.pinned:meta.pinned===true,complete:true});this.validationMemo.delete(key);await this.persist();return true;
 });}
 async pin(key,pinned){if(typeof pinned!=='boolean')throw Error('Invalid cache pin state.');return this.serial(async()=>{const e=this.entries.get(key);if(!e)throw Error('This cached clip no longer exists.');e.pinned=pinned;const memory=this.sessionCache?.peek(key);if(memory)memory.pinned=pinned;await this.persist();return {key,pinned};});}
 async preview(filter={}){
  if(!filter||typeof filter!=='object'||Array.isArray(filter))throw Error('Invalid cache filter.');const scope=filter.scope||'all';if(!['all','conversation','provider','older','selected','incomplete'].includes(scope))throw Error('Unknown cache filter.');
  if(scope==='conversation'&&(typeof filter.sourceId!=='string'||!filter.sourceId))throw Error('Choose a conversation.');if(scope==='provider'&&!PROVIDERS.includes(filter.provider))throw Error('Choose a provider.');if(scope==='older'&&(!Number.isFinite(filter.olderThanDays)||filter.olderThanDays<1||filter.olderThanDays>3650))throw Error('Choose a valid cache age.');if(scope==='selected'&&(!Array.isArray(filter.keys)||filter.keys.length>10000||filter.keys.some(k=>!KEY.test(k))))throw Error('Choose valid cached clips.');
  return this.serial(async()=>{const entries=await this.scan();const matches=entries.filter(e=>matchesFilter(e,filter));const selected=matches.filter(e=>e.deletable&&!this.active.has(e.cacheKey)&&(!e.pinned||filter.includePinned===true));
   const matchingKeys=new Set(matches.map(e=>e.cacheKey));const sessionMatches=[...(this.sessionCache?.entries.values()||[])].filter(e=>matchesFilter(e,filter)||matchingKeys.has(e.key));const sessionEntries=sessionMatches.filter(e=>!this.active.has(e.key)&&(!this.entries.get(e.key)?.pinned||filter.includePinned===true));
   const token=crypto.randomBytes(24).toString('hex');this.previews.set(token,{expires:Date.now()+120000,entries:selected.map(e=>({key:e.key,cacheKey:e.cacheKey,fileName:e.fileName,identity:e.identity,digest:e.digest,orphan:e.orphan})),sessionEntries:sessionEntries.map(e=>({key:e.key,nonce:e.nonce,byteLength:e.byteLength})),includePinned:filter.includePinned===true});for(const [key,p]of this.previews)if(p.expires<Date.now())this.previews.delete(key);while(this.previews.size>256)this.previews.delete(this.previews.keys().next().value);
   return {token,count:selected.length,bytes:selected.reduce((n,e)=>n+e.bytes,0),protectedCount:matches.length-selected.length,sessionCount:sessionEntries.length,sessionBytes:sessionEntries.reduce((n,e)=>n+e.byteLength,0),sessionProtectedCount:sessionMatches.length-sessionEntries.length};
  });
 }
 async remove(token){return this.serial(async()=>{const plan=this.previews.get(token);this.previews.delete(token);if(!plan||plan.expires<Date.now())throw Error('The cache deletion preview expired. Preview the selection again.');let count=0,bytes=0,protectedCount=0,indexChanged=false;
  for(const expected of plan.entries){const e=this.entries.get(expected.key);if(this.active.has(expected.cacheKey)||!expected.orphan&&(!e||e.digest!==expected.digest||e.pinned&&!plan.includePinned)){protectedCount++;continue;}if(expected.orphan&&e){protectedCount++;continue;}const identity=await this.identify(expected.fileName);if(!sameFile(identity,expected.identity)||identity.exists&&!identity.regular){protectedCount++;continue;}await fs.rm(path.join(this.dir,expected.fileName),{force:true});if(!expected.orphan){this.entries.delete(expected.key);indexChanged=true;}count++;bytes+=identity.regular?identity.size:0;}
  let sessionCount=0,sessionBytes=0,sessionProtectedCount=0;for(const expected of plan.sessionEntries||[]){if(this.active.has(expected.key)||this.sessionCache?.peek(expected.key)?.nonce!==expected.nonce||this.entries.get(expected.key)?.pinned&&!plan.includePinned){sessionProtectedCount++;continue;}sessionBytes+=expected.byteLength;this.sessionCache.delete(expected.key);sessionCount++;}
  if(indexChanged){this.validationMemo.clear();await this.persist();}return {count,bytes,protectedCount,sessionCount,sessionBytes,sessionProtectedCount};
 });}
}
module.exports={AudioCache,SessionAudioCache,digest};
