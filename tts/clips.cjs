'use strict';
const {MAX_AUDIO}=require('./network.cjs');
const MAGIC=Buffer.from('TTSCLIP1');
const CLIP_MIME='application/vnd.threadshelf.tts-clips-v1';
const TYPES=new Set(['audio/wav','audio/mpeg','audio/ogg','audio/mp4']);
function encodeClips(clips){
 if(!Array.isArray(clips)||clips.length<2||clips.length>1024)throw Error('Invalid speech section count.');
 const head=Buffer.alloc(12);MAGIC.copy(head);head.writeUInt32LE(clips.length,8);const parts=[head];let total=head.length;
 for(const clip of clips){if(!TYPES.has(clip.mime)||!Buffer.isBuffer(clip.bytes)||!clip.bytes.length)throw Error('Invalid speech section.');const mime=Buffer.from(clip.mime),header=Buffer.alloc(6);header.writeUInt16LE(mime.length);header.writeUInt32LE(clip.bytes.length,2);total+=header.length+mime.length+clip.bytes.length;if(total>MAX_AUDIO)throw Error('The combined speech audio exceeds the 64 MiB limit.');parts.push(header,mime,clip.bytes);}
 return Buffer.concat(parts,total);
}
function decodeClips(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>MAX_AUDIO||!bytes.subarray(0,8).equals(MAGIC))throw Error('Invalid cached speech sections.');const count=bytes.readUInt32LE(8);if(count<2||count>1024)throw Error('Invalid cached speech section count.');let offset=12;const clips=[];
 for(let i=0;i<count;i++){if(offset+6>bytes.length)throw Error('Truncated cached speech sections.');const mimeLength=bytes.readUInt16LE(offset),length=bytes.readUInt32LE(offset+2);offset+=6;if(mimeLength>64||!length||length>MAX_AUDIO||offset+mimeLength+length>bytes.length)throw Error('Invalid cached speech section length.');const mime=bytes.toString('utf8',offset,offset+mimeLength);offset+=mimeLength;if(!TYPES.has(mime))throw Error('Invalid cached speech audio type.');clips.push({mime,bytes:bytes.subarray(offset,offset+length)});offset+=length;}
 if(offset!==bytes.length)throw Error('Unexpected data after cached speech sections.');return clips;
}
function responseAudio(bytes,mime){if(mime===CLIP_MIME)return {audioClips:decodeClips(bytes).map(c=>({mime:c.mime,audioBase64:c.bytes.toString('base64')}))};if(!TYPES.has(mime))throw Error('Invalid speech audio type.');return {audioBase64:bytes.toString('base64'),mime};}
module.exports={CLIP_MIME,encodeClips,decodeClips,responseAudio};
