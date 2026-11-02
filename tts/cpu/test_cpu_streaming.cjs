'use strict';
// Real local-engine test: no API provider, key, model download or speech cache.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {synthesizeCPU}=require('../cpu.cjs');
const args=process.argv.slice(2),at=args.indexOf('--assets');
if(at<0||!args[at+1])throw new Error('Usage: node test_cpu_streaming.cjs --assets /absolute/asset/root');
const assetsDir=path.resolve(args[at+1]);
const passage='This is the first sentence, ready to play while the rest is generated. '+
  'ThreadShelf reads a conversation using the selected local voice. '+
  'The model stays loaded as the next sentence becomes available. '+
  'A short pause belongs between complete sentences, without losing any words. '+
  'You can stop playback at any time, and the remaining generation is cancelled. '+
  'These voices work entirely offline with the files already included in the application.';
function pcm(wav){
  assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
  let audio,format;
  for(let offset=12;offset+8<=wav.length;){const name=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),start=offset+8;assert.ok(start+size<=wav.length);if(name==='fmt ')format=wav.subarray(start,start+size);if(name==='data')audio=wav.subarray(start,start+size);offset=start+size+(size%2);}
  assert.ok(format&&audio);assert.equal(format.readUInt16LE(0),1);assert.equal(format.readUInt16LE(2),1);assert.equal(format.readUInt32LE(4),24000);assert.equal(format.readUInt16LE(14),16);return audio;
}
async function main(){
  const workDir=await fs.mkdtemp(path.join(os.tmpdir(),'threadshelf-cpu-stream-'));
  const results=[];
  try{
    for(const [provider,voice] of [['pocket','alba'],['pocket','vera'],['kokoro','am_michael'],['kokoro','bf_emma']]){
      const started=performance.now(),chunks=[],times=[];
      const audio=await synthesizeCPU({provider,voice,text:passage,assetsDir,workDir,streamingEnabled:true,onAudio:chunk=>{times.push(performance.now()-started);const data=pcm(chunk.bytes);assert.ok(data.length>0&&data.length<=512*1024);chunks.push(Buffer.from(data));}});
      const complete=performance.now()-started,fullPCM=pcm(audio);
      assert.ok(chunks.length>=4,'Speech must arrive in several playable chunks');
      assert.ok(times[0]<complete-100,'The first audio must precede whole-utterance completion');
      assert.deepEqual(Buffer.concat(chunks),fullPCM,'Streaming audio must match the completed cache candidate exactly');
      assert.deepEqual(await fs.readdir(workDir),[],'Session files must be removed after completion');
      results.push({provider,voice,firstAudioMs:Math.round(times[0]),completionMs:Math.round(complete),audioSeconds:fullPCM.length/48000,chunks:chunks.length,streamMatchesFinal:true});
    }
    for(const provider of ['pocket','kokoro']){
      const controller=new AbortController();let received=0;
      const pending=synthesizeCPU({provider,voice:provider==='pocket'?'alba':'am_michael',text:passage.repeat(3),assetsDir,workDir,streamingEnabled:true,signal:controller.signal,onAudio:()=>{if(++received===1)controller.abort();}});
      await assert.rejects(pending,{name:'AbortError'});assert.ok(received>=1);assert.deepEqual(await fs.readdir(workDir),[]);
    }
    // The buffered path remains usable when streaming is disabled.
    for(const provider of ['pocket','kokoro']){
      let unexpectedChunks=0;
      const buffered=await synthesizeCPU({provider,voice:provider==='pocket'?'alba':'am_michael',text:'Buffered speech remains available.',assetsDir,workDir,streamingEnabled:false,onAudio:()=>unexpectedChunks++});
      assert.ok(pcm(buffered).length>0);assert.equal(unexpectedChunks,0);assert.deepEqual(await fs.readdir(workDir),[]);
    }
    console.log(JSON.stringify({ok:true,platform:process.platform,onnxruntime:'1.31.1',results,cancelAfterFirstChunk:true,bufferedPath:true,temporaryFilesRemoved:true},null,2));
  }finally{await fs.rm(workDir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
