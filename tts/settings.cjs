'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const PROVIDERS=['pocket','kokoro','selfhosted','elevenlabs','openrouter','openai-realtime'];
const POCKET_VOICES=['alba','marius','javert','anna','charles','vera'];
const KOKORO_VOICES=['af_heart','af_alloy','af_aoede','af_bella','af_jessica','af_kore','af_nicole','af_nova','af_river','af_sarah','af_sky','am_adam','am_echo','am_eric','am_fenrir','am_liam','am_michael','am_onyx','am_puck','am_santa','bf_alice','bf_emma','bf_isabella','bf_lily','bm_daniel','bm_fable','bm_george','bm_lewis'];
const REALTIME_VOICES=['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'];
const SESSION_CACHE_LIMITS_MIB=Object.freeze([32,64,128,256]);
const PROFILE_DEFAULTS={
 pocket:{voice:'alba',model:'pocket-english-2026-10',endpoint:'',instructions:'',timeoutSeconds:180,responseFormat:'wav'},
 kokoro:{voice:'am_michael',model:'kokoro-v1.0-fp32',endpoint:'',instructions:'',timeoutSeconds:180,responseFormat:'wav'},
 selfhosted:{voice:'',model:'',endpoint:'http://127.0.0.1:8000/v1/audio/speech',instructions:'',timeoutSeconds:180,responseFormat:'wav'},
 elevenlabs:{voice:'',model:'eleven_multilingual_v2',endpoint:'https://api.elevenlabs.io',instructions:'',timeoutSeconds:180,responseFormat:'mp3'},
 openrouter:{voice:'',model:'',endpoint:'https://openrouter.ai/api/v1/audio/speech',instructions:'',timeoutSeconds:180,responseFormat:'mp3'},
 'openai-realtime':{voice:'marin',model:'gpt-realtime-2.1-mini',endpoint:'wss://api.openai.com/v1/realtime',instructions:'',timeoutSeconds:180,responseFormat:'wav'}
};
const DEFAULTS={schemaVersion:1,enabled:false,allowNetworkPlayback:false,includeThinking:false,showPillSettings:false,showPillSpeed:false,showPillVolume:false,streamingEnabled:true,volume:1,provider:'pocket',...PROFILE_DEFAULTS.pocket,cacheEnabled:false,cacheMaxBytes:2*1024**3,cacheMaxAgeDays:0,sessionCacheMaxMiB:64,preferSavedApiAudio:true,readCode:false,readCitations:false,playbackRate:1,providerProfiles:PROFILE_DEFAULTS};
const PROFILE_FIELDS=['voice','model','endpoint','instructions','timeoutSeconds','responseFormat'];
const BOOL_FIELDS=['enabled','allowNetworkPlayback','includeThinking','showPillSettings','showPillSpeed','showPillVolume','streamingEnabled','cacheEnabled','preferSavedApiAudio','readCode','readCitations'];
function clone(value){return JSON.parse(JSON.stringify(value));}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function string(value,name,max=1024){if(typeof value!=='string'||value.length>max||/[\0\r\n]/.test(value)&&name!=='instructions')throw new Error(`Invalid TTS ${name}.`);return value.trim();}
function number(value,name,min,max){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`Invalid TTS ${name}.`);return value;}
function validateEndpoint(value,provider){
 if(provider==='pocket'||provider==='kokoro')return '';
 let url;try{url=new URL(value);}catch{throw new Error('Enter a complete TTS endpoint URL.');}
 if(url.username||url.password||url.hash)throw new Error('TTS endpoint URLs cannot contain credentials or fragments.');
 if(provider==='openai-realtime'){if(url.origin!=='wss://api.openai.com'||url.pathname!=='/v1/realtime'||url.search)throw new Error('OpenAI uses wss://api.openai.com/v1/realtime.');}
 else if(provider==='openrouter'){if(url.origin!=='https://openrouter.ai'||url.pathname!=='/api/v1/audio/speech'||url.search)throw new Error('OpenRouter uses its HTTPS audio speech endpoint.');}
 else if(provider==='elevenlabs'){if(url.origin!=='https://api.elevenlabs.io'||!['','/'].includes(url.pathname)||url.search)throw new Error('ElevenLabs uses https://api.elevenlabs.io.');}
 else if(!['http:','https:'].includes(url.protocol))throw new Error('Self-hosted TTS requires an HTTP or HTTPS endpoint.');
 return url.href.replace(/\/$/,'');
}
function profile(value,provider){
 if(!object(value))throw new Error('Invalid TTS provider settings.');
 const out={...PROFILE_DEFAULTS[provider]};
 for(const [key,val] of Object.entries(value)){if(!PROFILE_FIELDS.includes(key))throw new Error(`Unknown TTS provider setting: ${key}`);if(key==='timeoutSeconds')out[key]=Math.round(number(val,key,1,1800));else out[key]=string(val,key,key==='instructions'?4000:2048);}
 out.endpoint=validateEndpoint(out.endpoint,provider);
 if(!['wav','mp3','pcm'].includes(out.responseFormat))throw new Error('Unsupported TTS audio format.');
 if(provider==='pocket'){if(!POCKET_VOICES.includes(out.voice))throw new Error('Choose a bundled Pocket TTS voice.');out.model=PROFILE_DEFAULTS.pocket.model;out.responseFormat='wav';}
 if(provider==='kokoro'){if(!KOKORO_VOICES.includes(out.voice))throw new Error('Choose a bundled Kokoro voice.');out.model=PROFILE_DEFAULTS.kokoro.model;out.responseFormat='wav';}
 if(provider==='openai-realtime'){if(!REALTIME_VOICES.includes(out.voice))throw new Error('Choose a supported Realtime voice.');if(!/^gpt-realtime-[a-z0-9.-]+$/.test(out.model))throw new Error('Enter a current OpenAI Realtime model ID.');out.responseFormat='wav';}
 return out;
}
function normalize(patch,current=DEFAULTS){
 if(!object(patch))throw new Error('Invalid TTS settings.');
 if('schemaVersion' in patch&&patch.schemaVersion!==1)throw Error('Unsupported TTS settings version.');
 const allowed=new Set([...Object.keys(DEFAULTS),'credentialStatus','warning']);
 for(const key of Object.keys(patch))if(!allowed.has(key))throw new Error(`Unknown TTS setting: ${key}`);
 const out=clone(current);out.sessionCacheMaxMiB??=DEFAULTS.sessionCacheMaxMiB;out.preferSavedApiAudio??=DEFAULTS.preferSavedApiAudio;delete out.credentialStatus;delete out.warning;
 for(const key of BOOL_FIELDS)if(key in patch){if(typeof patch[key]!=='boolean')throw new Error(`Invalid TTS ${key}.`);out[key]=patch[key];}
 if('provider' in patch){if(!PROVIDERS.includes(patch.provider))throw new Error('Choose a supported TTS provider.');out.provider=patch.provider;}
 if('cacheMaxBytes' in patch)out.cacheMaxBytes=Math.floor(number(patch.cacheMaxBytes,'cache size',16*1024**2,100*1024**3));
 if('cacheMaxAgeDays' in patch)out.cacheMaxAgeDays=Math.round(number(patch.cacheMaxAgeDays,'cache age',0,3650));
 if('sessionCacheMaxMiB' in patch){if(!SESSION_CACHE_LIMITS_MIB.includes(patch.sessionCacheMaxMiB))throw new Error('Choose a session RAM limit of 32, 64, 128 or 256 MB.');out.sessionCacheMaxMiB=patch.sessionCacheMaxMiB;}
 if('volume' in patch)out.volume=number(patch.volume,'volume',0,1);
 if('playbackRate' in patch)out.playbackRate=number(patch.playbackRate,'playback rate',0.5,2);
 out.providerProfiles=clone(current.providerProfiles||PROFILE_DEFAULTS);
 out.providerProfiles[current.provider]=profile(Object.fromEntries(PROFILE_FIELDS.map(k=>[k,current[k]])),current.provider);
 if('providerProfiles' in patch){if(!object(patch.providerProfiles))throw new Error('Invalid TTS provider profiles.');for(const [id,p]of Object.entries(patch.providerProfiles)){if(!PROVIDERS.includes(id))throw new Error('Unknown TTS provider profile.');out.providerProfiles[id]=profile({...out.providerProfiles[id],...p},id);}}
 const changed=out.provider!==current.provider;
 const active={...out.providerProfiles[out.provider]};
 for(const key of PROFILE_FIELDS)if(key in patch){
  // A full old form may change only the provider. Carry over explicit edits,
  // but do not accidentally assign the previous provider's voice or address.
  if(!changed||patch[key]!==current[key])active[key]=patch[key];
 }
 out.providerProfiles[out.provider]=profile(active,out.provider);
 Object.assign(out,out.providerProfiles[out.provider]);out.schemaVersion=1;
 return out;
}
async function atomicJSON(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}}
class SettingsStore{
 constructor(profileDir){this.file=path.join(profileDir,'tts-settings-v1.json');this.value=clone(DEFAULTS);this.warning='';this.queue=Promise.resolve();this.ready=this.load();}
 async load(){try{const data=await fs.readFile(this.file,'utf8');if(data.length>128*1024)throw new Error('Settings file is too large.');this.value=normalize(JSON.parse(data));}catch(error){if(error.code!=='ENOENT')this.warning='The TTS settings could not be loaded; safe defaults are active. The original file has been kept.';}}
 async get(){await this.ready;return {...clone(this.value),...(this.warning?{warning:this.warning}:{})};}
 async save(patch){const op=this.queue.then(async()=>{await this.ready;const value=normalize(patch,this.value);await atomicJSON(this.file,value);this.value=value;this.warning='';return clone(value);});this.queue=op.catch(()=>{});return op;}
}
module.exports={SettingsStore,DEFAULTS,PROVIDERS,PROFILE_DEFAULTS,POCKET_VOICES,KOKORO_VOICES,REALTIME_VOICES,SESSION_CACHE_LIMITS_MIB,normalize,validateEndpoint,atomicJSON};
