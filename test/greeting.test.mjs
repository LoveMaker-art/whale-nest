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
  const path=join(root,'greeting.md');
  writeFileSync(path,readFileSync(new URL('../deploy/clawchat/greeting.md',import.meta.url)));
  assert.equal(syncGreeting(options,persona).state,'updated');
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
