'use strict';
const {digest}=require('./cache.cjs');
const {PROFILE_DEFAULTS}=require('./settings.cjs');
const LOCAL=new Set(['pocket','kokoro']);
const API=new Set(['selfhosted','elevenlabs','openrouter','openai-realtime']);
const HASH=/^[a-f0-9]{64}$/;

function messageFingerprint(value){
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||typeof value.sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(value.sha256)||Object.keys(value).some(key=>!['version','sha256'].includes(key)))throw Error('Invalid message fingerprint.');
 return {version:1,sha256:value.sha256.toLowerCase()};
}
function validFingerprint(value){try{return messageFingerprint(value);}catch{return undefined;}}
function contentFingerprint({sourceId,messageId,text}){return digest(JSON.stringify({schema:1,normalizer:1,sourceId,messageId,text}));}
function synthesisKey(settings,{sourceId,messageId,text}){return digest(JSON.stringify({schema:2,normalizer:1,sectioning:1,sourceId,messageId,text,provider:settings.provider,model:settings.model,voice:settings.voice,endpoint:settings.endpoint,instructions:settings.instructions,format:settings.responseFormat,readCode:settings.readCode,readCitations:settings.readCitations,engine:LOCAL.has(settings.provider)?require('./cpu.cjs').ENGINE_REVISIONS[settings.provider]:'adapter-v1'}));}
const originalKey=entry=>HASH.test(entry.synthesisKey||'')?entry.synthesisKey:entry.key;

class RecordingResolver{
 constructor(){this.legacyProofs=new Map();}
 legacyMatches(entry,settings,identity,exactKey,budget){
  const key=originalKey(entry);if(key===exactKey)return true;
  if(!HASH.test(key)||typeof entry.model!=='string'||typeof entry.voice!=='string'||!PROFILE_DEFAULTS[entry.provider])return false;
  const profile=settings.providerProfiles[entry.provider]||PROFILE_DEFAULTS[entry.provider];
  const proofKey=digest(JSON.stringify([key,contentFingerprint(identity),profile.endpoint,profile.instructions]));
  if(this.legacyProofs.has(proofKey))return this.legacyProofs.get(proofKey);
  if(budget.remaining--<=0)return false;
  const endpoints=[...new Set([profile.endpoint,PROFILE_DEFAULTS[entry.provider].endpoint])];
  const instructions=[...new Set([profile.instructions,''])];
  const formats=LOCAL.has(entry.provider)||entry.provider==='openai-realtime'?['wav']:['wav','pcm','mp3'];
  let matched=false;
  outer:for(const endpoint of endpoints)for(const instruction of instructions)for(const responseFormat of formats)for(const readCode of [false,true])for(const readCitations of [false,true]){
   if(synthesisKey({provider:entry.provider,model:entry.model,voice:entry.voice,endpoint,instructions:instruction,responseFormat,readCode,readCitations},identity)===key){matched=true;break outer;}
  }
  this.legacyProofs.set(proofKey,matched);while(this.legacyProofs.size>1024)this.legacyProofs.delete(this.legacyProofs.keys().next().value);
  return matched;
 }
 sameMessage(entry,settings,identity,exactKey,budget){
  if(entry.sourceId!==identity.sourceId||entry.messageId!==identity.messageId)return false;
  const storedFull=validFingerprint(entry.messageFingerprint),requestedFull=identity.messageFingerprint;
  if(storedFull&&requestedFull)return storedFull.sha256===requestedFull.sha256;
  if(HASH.test(entry.contentFingerprint||''))return entry.contentFingerprint===contentFingerprint(identity);
  return this.legacyMatches(entry,settings,identity,exactKey,budget);
 }
 async select({settings,identity,cache,sessionCache,exclude=new Set()}){
  const exactKey=synthesisKey(settings,identity),all=new Map(),budget={remaining:64};
  if(settings.cacheEnabled)for(const entry of cache.entries.values())all.set(entry.key,{entry,source:'disk'});
  for(const entry of sessionCache.entries.values()){
   const disk=cache.entries.get(entry.key),{bytes,...metadata}=entry;all.set(entry.key,{entry:{...metadata,pinned:disk?disk.pinned:entry.pinned===true},source:'session',nonce:entry.nonce});
  }
  const sorted=[...all.values()].filter(({entry})=>entry.complete===true&&entry.sourceId===identity.sourceId&&entry.messageId===identity.messageId&&!exclude.has(entry.key))
   .sort((a,b)=>Date.parse(b.entry.createdAt)-Date.parse(a.entry.createdAt)||a.entry.key.localeCompare(b.entry.key));
  // Validate only source/message candidates, lazily in preference order. Full
  // fingerprint mismatch blocks cross-settings priority, not identical speech.
  const eligible=(entry,selection)=>selection==='pinned'?entry.pinned===true:selection==='saved-api'?settings.preferSavedApiAudio&&!entry.pinned&&API.has(entry.provider):originalKey(entry)===exactKey;
  for(const selection of ['pinned','saved-api','exact'])for(const candidate of sorted){const {entry}=candidate;
   if(!eligible(entry,selection))continue;
   if(selection!=='exact'&&!this.sameMessage(entry,settings,identity,exactKey,budget))continue;
   if(candidate.source==='session'){const current=sessionCache.peek(entry.key);if(current?.nonce===candidate.nonce&&current.complete===true&&current.bytes.length===current.byteLength)return {...candidate,selection};}
   if(settings.cacheEnabled&&await cache.available(entry.key,settings.cacheMaxAgeDays)){
    const latest=cache.entries.get(entry.key);if(latest?.complete===true&&latest.sourceId===identity.sourceId&&latest.messageId===identity.messageId&&eligible(latest,selection)&&(selection==='exact'||this.sameMessage(latest,settings,identity,exactKey,budget)))return {...candidate,entry:{...latest},source:'disk',selection};
   }
  }
  return null;
 }
 clear(){this.legacyProofs.clear();}
}
module.exports={RecordingResolver,messageFingerprint,contentFingerprint,synthesisKey,originalKey,API};
