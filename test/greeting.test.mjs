import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncGreeting,currentGreetingPersona} from '../src/greeting.mjs';
import {writeState} from '../src/state.mjs';

test('official first greeting receives the entire selected persona and preserves custom input',t=>{
  const root=mkdtempSync(join(tmpdir(),'whalenest-greeting-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const options={instanceId:'greeting-test',dataDir:root,cwd:root};
  const persona={id:'current',body:'我是鲸鱼娘。主人与我的关系保持原样。\nPERSONA_LAST_PARAGRAPH'};
  const path=join(root,'clawchat/greeting.md');
  mkdirSync(join(root,'clawchat'),{recursive:true});
  writeFileSync(join(root,'greeting.md'),'用户自己保存在根目录的同名文件');
  writeFileSync(path,readFileSync(new URL('../deploy/clawchat/greeting.md',import.meta.url)));
  assert.equal(syncGreeting(options,persona).state,'updated');
  assert.equal(readFileSync(join(root,'greeting.md'),'utf8'),'用户自己保存在根目录的同名文件',
    'Only the official workspace/clawchat/greeting.md input is managed');
  assert.ok(readFileSync(path,'utf8').includes(persona.body));
  assert.match(readFileSync(path,'utf8'),/只输出问候和这个问题/);
  assert.equal(syncGreeting(options,persona).state,'current');
  const next={...persona,body:'我换了人格。\nCOMPLETE_NEW_PERSONA'};
  assert.equal(syncGreeting(options,next).state,'updated');
  assert.doesNotMatch(readFileSync(path,'utf8'),/PERSONA_LAST_PARAGRAPH/);
  writeFileSync(path,'用户自己写的开场要求');
  assert.equal(syncGreeting(options,persona).state,'conflict');
  assert.equal(readFileSync(path,'utf8'),'用户自己写的开场要求');
});

test('startup reads native persona selection and adopts an interrupted exact managed replacement',t=>{
  const root=mkdtempSync(join(tmpdir(),'whalenest-greeting-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const options={instanceId:'selection',dataDir:root,cwd:root};
  mkdirSync(join(root,'aurabot/personas'),{recursive:true});
  writeState(join(root,'aurabot/config.json'),{persona:{current:'blue'}});
  writeFileSync(join(root,'aurabot/personas/blue.md'),'---\nname: 蓝鲸\n---\n\n我就是蓝鲸。完整人格尾句。\n');
  const persona=currentGreetingPersona(options);assert.equal(persona.id,'blue');
  assert.equal(persona.body,'我就是蓝鲸。完整人格尾句。');
  const result=syncGreeting(options,persona);
  writeState(join(root,'greeting-input.json'),{schema:1,instanceId:'selection',sha256:'old',pendingSha256:result.sha256});
  assert.equal(syncGreeting(options,persona).state,'current');
  assert.equal(syncGreeting(options,{...persona,body:'新内容'}).state,'updated');
});

test('a held official input stays empty across restarts and restores complete persona or custom input',t=>{
 const root=mkdtempSync(join(tmpdir(),'whalenest-greeting-gate-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const o={instanceId:'gate',cwd:root,dataDir:root},persona={body:'完整人格尾句'};
 const path=join(root,'clawchat/greeting.md');
 syncGreeting(o,persona,{hold:true});assert.equal(readFileSync(path,'utf8'),'');
 syncGreeting(o,persona,{hold:true});assert.equal(readFileSync(path,'utf8'),'');
 syncGreeting(o,persona,{hold:false});assert.match(readFileSync(path,'utf8'),/完整人格尾句/);
 writeFileSync(path,'主人自定开场');syncGreeting(o,persona,{hold:true});assert.equal(readFileSync(path,'utf8'),'');
 syncGreeting(o,persona,{hold:true});syncGreeting(o,persona,{hold:false});assert.equal(readFileSync(path,'utf8'),'主人自定开场');
 syncGreeting(o,persona,{hold:true});writeFileSync(path,'暂停期间用户编辑');
 assert.equal(syncGreeting(o,persona,{hold:false}).state,'conflict');assert.equal(readFileSync(path,'utf8'),'暂停期间用户编辑');
});

test('Core becoming ready just after holding the greeting does not cancel the required release tick',async t=>{
 const {refreshFirstGreeting}=await import('../src/greeting.mjs');
 const root=mkdtempSync(join(tmpdir(),'whalenest-greeting-race-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const options={instanceId:'race',dataDir:root,cwd:root},persona={body:'完整的人格仍在这里'};
 let ready=false;
 const first=await refreshFirstGreeting(options,null,{sync:o=>{
  const result=syncGreeting(o,persona,{hold:!ready});
  ready=true; // Core preparation completed between writing and scheduling.
  return result;
 }});
 assert.equal(ready,true);assert.equal(readFileSync(join(root,'clawchat/greeting.md'),'utf8'),'');
 assert.equal(first.pending,true,'The actual held input still needs a release tick');
 const second=await refreshFirstGreeting(options,null,{sync:o=>syncGreeting(o,persona,{hold:!ready})});
 assert.equal(second.pending,false);assert.match(readFileSync(join(root,'clawchat/greeting.md'),'utf8'),/完整的人格仍在这里/);
});
