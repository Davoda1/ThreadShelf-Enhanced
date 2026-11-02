'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {synthesizeCPU,POCKET_VOICES,KOKORO_VOICES}=require('../cpu.cjs');
const args=process.argv.slice(2), index=args.indexOf('--assets');
if(index<0 || !args[index+1]) throw new Error('Usage: node test_cpu.cjs --assets /absolute/asset/root');
const assetsDir=path.resolve(args[index+1]);
async function main(){
  const workDir=await fs.mkdtemp(path.join(os.tmpdir(),'threadshelf-cpu-test-'));
  const results=[];
  try {
    assert.equal(POCKET_VOICES.length,6); assert.equal(KOKORO_VOICES.length,28);
    const base={assetsDir,workDir,text:'ThreadShelf reads this sentence entirely offline.'};
    await assert.rejects(synthesizeCPU({...base,provider:'pocket',voice:'../alba'}),/Unknown bundled speech voice/);
    await assert.rejects(synthesizeCPU({...base,provider:'pocket',voice:'alba',signal:AbortSignal.abort()}),{name:'AbortError'});
    const examples=[...POCKET_VOICES.map(voice=>['pocket',voice]),['kokoro','am_michael'],['kokoro','af_heart'],['kokoro','bf_emma']];
    for(const [provider,voice] of examples){
      const started=Date.now(); const wav=await synthesizeCPU({...base,provider,voice});
      assert.equal(wav.toString('ascii',0,4),'RIFF'); assert.equal(wav.toString('ascii',8,12),'WAVE');
      assert.ok(wav.length>44); assert.deepEqual(await fs.readdir(workDir),[]);
      results.push({provider,voice,bytes:wav.length,milliseconds:Date.now()-started});
    }
    let longPathRelocation = null;
    if(process.platform === 'linux') {
      // A symlink-only asset alias does not cover eSpeak's native path limit:
      // phonemizer resolves data paths. Physically relocate its data/library
      // while sharing the immutable larger model files through test symlinks.
      const relocated=path.join(workDir,"relocated-"+'0123456789'.repeat(12)+" Árvíz path's");
      const packages=path.join(relocated,'runtime','packages');
      await fs.mkdir(packages,{recursive:true});
      await fs.symlink(path.join(assetsDir,'runtime','python'),path.join(relocated,'runtime','python'),'dir');
      for(const entry of await fs.readdir(path.join(assetsDir,'runtime','packages'),{withFileTypes:true})) {
        const source=path.join(assetsDir,'runtime','packages',entry.name), target=path.join(packages,entry.name);
        if(entry.name === 'espeakng_loader') await fs.cp(source,target,{recursive:true});
        else await fs.symlink(source,target,entry.isDirectory()?'dir':'file');
      }
      for(const name of ['models','engines']) await fs.symlink(path.join(assetsDir,name),path.join(relocated,name),'dir');
      const dataPathBytes=Buffer.byteLength(path.join(packages,'espeakng_loader','espeak-ng-data'),'utf8');
      assert.ok(dataPathBytes>160);
      let streamedChunks=0;
      const wav=await synthesizeCPU({...base,assetsDir:relocated,provider:'kokoro',voice:'am_michael',streamingEnabled:true,onAudio:()=>streamedChunks++});
      assert.ok(wav.length>44);
      assert.ok(streamedChunks>0);
      longPathRelocation={dataPathBytes,bytes:wav.length,unicodeSpacesAndApostrophes:true,streamedChunks};
      await fs.rm(relocated,{recursive:true,force:true});
      assert.deepEqual(await fs.readdir(workDir),[]);
    }
    const controller=new AbortController();
    const pending=synthesizeCPU({...base,provider:'pocket',voice:'alba',text:base.text.repeat(100),signal:controller.signal});
    setTimeout(()=>controller.abort(),150);
    await assert.rejects(pending,{name:'AbortError'});
    assert.deepEqual(await fs.readdir(workDir),[]);
    console.log(JSON.stringify({ok:true,platform:process.platform,arch:process.arch,onnxruntime:'1.31.1',results,longPathRelocation,cancellation:true,temporaryFilesRemoved:true},null,2));
  } finally {await fs.rm(workDir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
