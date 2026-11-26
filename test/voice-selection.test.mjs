import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceSelection} from '../src/voice-selection.mjs';
import {defaultPlatformVoice} from '../src/speech.mjs';
import {resolvePlatformVoice} from '../src/voice-catalog.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'whalenest-voice-selection-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const file=join(root,'config.json');writeFileSync(file,JSON.stringify({voice:{platformVoice:defaultPlatformVoice},unrelated:'retain'}));
  const calls=[],options={instanceId:'fixture',dataDir:root,speech:{enabled:true,ttsModel:'qwen-audio-3.0-tts-flash'}};
  const deps={getConfig:()=>JSON.parse(readFileSync(file,'utf8')),setConfig:value=>writeFileSync(file,JSON.stringify(value)),
    speech:{async synthesize(_text,id,{voice}){calls.push({id,voice});if(voice==='bad')throw Error('uncertain synthesis');return {voice};}}};
  return {root,file,options,deps,calls,selection:createVoiceSelection(options,deps)};
}

test('approved names are selectable, defaults remain intact and legacy voices are retained',async t=>{
  const f=fixture(t),initial=f.selection.status();assert.equal(initial.voice,defaultPlatformVoice);
  assert.deepEqual(initial.choices.map(v=>v.name),['鲸鱼娘','小鲸娘1','小鲸娘2','小鲸娘3','小鲸娘4','大鲸娘1']);
  assert.deepEqual(initial.choices.slice(1).map(v=>v.style),['搞怪逗趣','娇嗲甜腻','呆萌软糯','元气活力','呆萌软糯']);
  assert.doesNotMatch(JSON.stringify(initial.choices),/龙翼雀菊|龙晖泉晴|龙薇梅翼|龙萱桃烁|龙晖杉朔|aliases/);
  assert.equal(f.calls.length,0);
  for(const [name,id]of [['小鲸娘1','longyiqueju'],['小鲸娘2','longhuiquanqing'],['小鲸娘3','longweimeiyi'],['小鲸娘4','longxuantaoshuo'],['大鲸娘1','longhuishanshuo']]){
    const r=await f.selection.change(name,{requestId:name});assert.equal(r.voice,'qwen-audio-3.0-tts-flash-'+id);assert.equal(r.voiceName,name);
    assert.equal(f.calls.at(-1).voice,r.voice);assert.equal(f.deps.getConfig().unrelated,'retain');
  }
  await f.selection.change('默认',{requestId:'default'});assert.equal(f.selection.current(),defaultPlatformVoice);
  for(const [oldName,name]of [['龙翼雀菊','小鲸娘1'],['龙晖泉晴','小鲸娘2'],['龙薇梅翼','小鲸娘3'],['龙萱桃烁','小鲸娘4'],['龙晖杉朔','大鲸娘1']])
    assert.equal(resolvePlatformVoice(oldName,f.options.speech.ttsModel),resolvePlatformVoice(name,f.options.speech.ttsModel),'Old names stay compatible without appearing in the public catalogue');
  await f.selection.change('my-custom-speaker',{requestId:'custom'});
  const restarted=createVoiceSelection(f.options,f.deps);assert.equal(restarted.current(),'my-custom-speaker');
  assert.ok(restarted.status().choices.some(v=>v.voice==='my-custom-speaker'&&v.selected));
});

test('failed or replayed requests never reapply an older choice or repeat the paid check',async t=>{
  const f=fixture(t);await assert.rejects(f.selection.change('bad',{requestId:'bad'}),/uncertain/);
  assert.equal(f.selection.current(),defaultPlatformVoice);
  await assert.rejects(createVoiceSelection(f.options,f.deps).change('bad',{requestId:'bad'}),/uncertain/);assert.equal(f.calls.length,1);
  await f.selection.change('小鲸娘1',{requestId:'first'});await f.selection.change('小鲸娘2',{requestId:'second'});
  const count=f.calls.length,r=await createVoiceSelection(f.options,f.deps).change('龙翼雀菊',{requestId:'first'});
  assert.equal(r.replayed,true);assert.equal(r.voiceName,'小鲸娘2');assert.equal(f.calls.length,count);
  await assert.rejects(f.selection.change('小鲸娘4',{requestId:'first'}),/编号/);assert.equal(f.calls.length,count);
});

test('unknown names and unsupported models are rejected before billing; current selection needs no new check',async t=>{
  const f=fixture(t);
  await assert.rejects(f.selection.change('不存在的音色',{requestId:'unknown'}),/没有找到/);
  const result=await f.selection.change('默认',{requestId:'current'});
  assert.equal(result.voice,defaultPlatformVoice);assert.equal(f.calls.length,0);
  const wrong=createVoiceSelection({...f.options,speech:{...f.options.speech,ttsModel:'other-model'}},f.deps);
  await assert.rejects(wrong.change('小鲸娘1',{requestId:'wrong-model'}),/不支持/);assert.equal(f.calls.length,0);
});

test('concurrent selections are serialized, preserve unrelated edits and detect external voice changes during synthesis',async t=>{
  const f=fixture(t);let finish,entered;
  const gate=new Promise(r=>{finish=r;}),started=new Promise(r=>{entered=r;});
  f.deps.speech.synthesize=async(_text,id,{voice})=>{f.calls.push({id,voice});entered();await gate;return {voice};};
  const first=f.selection.change('小鲸娘1',{requestId:'first'});await started;
  const second=f.selection.change('小鲸娘2',{requestId:'second'});
  assert.equal(f.calls.length,1,'A queued chat selection must wait for the previous check');
  f.deps.setConfig({...f.deps.getConfig(),unrelated:'later edit'});finish();await first;await second;
  assert.equal(f.selection.status().voiceName,'小鲸娘2');assert.equal(f.calls.length,2);assert.equal(f.deps.getConfig().unrelated,'later edit');
  f.deps.speech.synthesize=async(_text,_id,{voice})=>{f.deps.setConfig({...f.deps.getConfig(),voice:{platformVoice:'external-choice'}});return {voice};};
  await assert.rejects(f.selection.change('小鲸娘4',{requestId:'external'}),e=>e.code==='VOICE_SELECTION_CONFLICT');
  assert.equal(f.selection.current(),'external-choice');
});

test('restart resumes a verified selection after a failed config save without synthesizing again',async t=>{
  const f=fixture(t),save=f.deps.setConfig;let fail=true;
  f.deps.setConfig=value=>{if(fail){fail=false;throw Error('config save interrupted');}return save(value);};
  const selection=createVoiceSelection(f.options,f.deps),request={requestId:'interrupted'};
  await assert.rejects(selection.change('小鲸娘3',request),/interrupted/);
  assert.equal(f.selection.current(),defaultPlatformVoice);assert.equal(f.calls.length,1);
  const restarted=createVoiceSelection(f.options,f.deps),result=await restarted.change('小鲸娘3',request);
  assert.equal(result.voiceName,'小鲸娘3');assert.equal(f.calls.length,1);assert.equal(f.deps.getConfig().unrelated,'retain');
});
