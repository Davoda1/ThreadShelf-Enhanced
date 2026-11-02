'use strict';
const {MAX_AUDIO}=require('./network.cjs');
function pcmFormat(contentType,defaults={rate:24000,channels:1}){
 const type=String(contentType||'').toLowerCase();
 const rateMatch=/(?:^|;)\s*(?:rate|samplerate|sample_rate)\s*=\s*"?(\d+)"?(?:;|$)/.exec(type);
 const channelsMatch=/(?:^|;)\s*channels\s*=\s*"?(\d+)"?(?:;|$)/.exec(type);
 const rate=rateMatch?Number(rateMatch[1]):defaults.rate,channels=channelsMatch?Number(channelsMatch[1]):defaults.channels;
 if(!Number.isInteger(rate)||rate<8000||rate>192000||![1,2].includes(channels))throw Error('The speech service returned an unsupported PCM sample rate or channel count.');
 return {rate,channels};
}
function createPCMStream({onAudio,wrapWav}){
 let format=null,pending=Buffer.alloc(0),total=0,emitted=0;
 function push(chunk){if(!format)return;total+=chunk.length;if(total>MAX_AUDIO-44)throw Error('The speech stream exceeded the 64 MiB audio limit.');pending=Buffer.concat([pending,chunk]);const target=Math.max(2*format.channels,Math.floor(format.rate*format.channels/2)*2);while(pending.length>=target){const pcm=pending.subarray(0,target);pending=pending.subarray(target);onAudio({bytes:wrapWav(pcm,format.rate,format.channels),mime:'audio/wav'});emitted++;}}
 return {
  configure(contentType,requestedFormat){const type=String(contentType||'').split(';')[0].trim().toLowerCase();if(type==='audio/pcm'||type==='audio/x-pcm'||requestedFormat==='pcm'&&['application/octet-stream',''].includes(type))format=pcmFormat(contentType);},
  push,
  finish(){if(!format)return;if(pending.length%(format.channels*2))throw Error('The speech service returned an incomplete PCM frame.');if(pending.length){onAudio({bytes:wrapWav(pending,format.rate,format.channels),mime:'audio/wav'});pending=Buffer.alloc(0);emitted++;}},
  get format(){return format;},get emitted(){return emitted;}
 };
}
module.exports={pcmFormat,createPCMStream};
