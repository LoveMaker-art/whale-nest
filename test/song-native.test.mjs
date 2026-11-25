import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {readBridgeHistory} from '../src/bridge-history.mjs';
import {songGuide} from '../src/song-guidance.mjs';

test('native ClawChat model requests contain the complete shared song guide and return saved melody facts',{timeout:60000},async t=>{
 const directory=await bridgeDirectory();let bridge;
 t.after(async()=>{await bridge?.close();await rm(directory.root,{recursive:true,force:true});});
 const provider=join(directory.root,'provider.json');
 await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:'https://must-not-call.invalid/v1',apiKey:'fixture'}}}}));
 directory.options.singing={enabled:true,providerConfigPath:provider};directory.options.clawchat.delivery.mediaEnabled=true;
 await writeFile(directory.configPath,JSON.stringify(directory.options));
 const id='hum-'+'a'.repeat(32);
 const abc='X:1\nT:\nM:4/4\nL:1/16\nQ:1/4=96\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nC4E4G4c4|\nV: Ins\nZ|\n% chorus\nV: Vocal\nC4E4G4c4|\nV: Ins\nZ|\n';
 await mkdir(join(directory.options.dataDir,'media/song-melodies'),{recursive:true});
 await writeFile(join(directory.options.dataDir,'media/song-melodies',id+'.json'),JSON.stringify({id,abc}));
 bridge=await bootBridge(directory);const sessionId='song-native';
 await bridge.request('create',{sessionId,cwd:directory.root,whalenestChatId:'dm-alice',model:directory.options.model});
 await bridge.turn(sessionId,'song-draft-read','运维自测，仅检查保存的旋律，不生成歌曲。\n〔旋律:'+id+':whole〕\nFOUNDATION_TOOL '+JSON.stringify({name:'companion_songs',args:{action:'draft'}}));
 const traces=(await readFile(join(directory.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 const needles=songGuide.split('\n').filter(Boolean);
 assert.ok(traces.every(trace=>needles.every(line=>JSON.stringify(trace).includes(line))),
  'The guide must reach the real DSH model request, not just a disconnected module rule: '+JSON.stringify(traces.map(trace=>({systemType:typeof trace.system,matched:needles.map(line=>JSON.stringify(trace).includes(line))}))));
 const history=await readBridgeHistory(bridge,sessionId);
 const result=history.events.filter(e=>e.type==='tool/result').map(e=>e.data.message).flatMap(m=>m.content).find(b=>b.type==='text'&&b.text.includes('"readOnly":true'));
 assert.ok(result);const reply=JSON.parse(result.text);assert.equal(reply.melody.id,id);assert.deepEqual(reply.melody.sections.map(s=>s.phrases[0].notes),[4,4]);
 assert.equal(reply.generated,false);
});
