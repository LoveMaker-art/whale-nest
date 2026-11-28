import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,rmSync,statSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {readState,writeState} from './state.mjs';
import {startupStatus} from './startup-state.mjs';
import {parsePersona} from '../vendor/aurabot/src/persona/personas.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const instruction=readFileSync(new URL('./assets/greeting.md',import.meta.url),'utf8');
const legacy='882f454b40f5571d948108090c66a0f5c9a74376e930b29d89f91d43e6b24467';

export function currentGreetingPersona(options){
  const config=readState(join(options.dataDir,'aurabot/config.json'),null);
  const id=config?.persona?.current??readState(join(options.dataDir,'persona-state.json'),null)?.currentId??'dafeiyu-original';
  assert.match(id,/^[a-zA-Z0-9_-]{1,40}$/);
  const path=join(options.dataDir,'aurabot/personas',id+'.md');
  if(existsSync(path))return parsePersona(id,readFileSync(path,'utf8'));
  assert.equal(id,'dafeiyu-original','Selected greeting persona is missing');
  const lock=JSON.parse(readFileSync(new URL('../upstream.lock.json',import.meta.url)));
  const raw=readFileSync(new URL('../'+lock.personaReference.localFile,import.meta.url),'utf8');
  assert.equal(sha(raw),lock.personaReference.sha256);
  return parsePersona(id,raw);
}

/** The official runtime remains the only greeting sender. We manage its input
 * before it starts, preserving independently authored greeting files. */
export function syncGreeting(options,persona=currentGreetingPersona(options),{hold=!startupStatus(options).avatarReady}={}){
  assert.ok(persona?.body?.trim(),'Greeting requires the complete current persona');
  const path=join(options.cwd??options.dataDir,'clawchat/greeting.md'),recordFile=join(options.dataDir,'greeting-input.json');
  const before=existsSync(path)?readFileSync(path,'utf8'):null,record=readState(recordFile,null);
  let contents='<!-- whalenest: current persona for the official first greeting -->\n'
    +'以下是我当前的人格，首次见面时也沿用同一个身份、关系和说话方式。\n\n'
    +persona.body.trim()+'\n\n---\n\n'+instruction;
  const heldCustom=record?.heldCustom;
  if(heldCustom!==undefined)contents=heldCustom;
  const custom=before!==null&&sha(before)!==legacy&&sha(before)!==sha(instruction)
    &&(!record||record.instanceId!==options.instanceId||![record.sha256,record.pendingSha256].includes(sha(before)));
  if(custom&&(!hold||heldCustom!==undefined))return {state:'conflict',reason:'custom-greeting-preserved'};
  const preserve=heldCustom??(hold&&custom?before:undefined);
  if(hold)contents=''; // Official runtime does not generate/send an empty greeting input.
  const extra=preserve!==undefined?{heldCustom:preserve}:{};
  const digest=sha(contents);
  if(before===contents){
    writeState(recordFile,{schema:1,instanceId:options.instanceId,sha256:digest,...extra});
    return {state:hold?'held':'current',sha256:digest};
  }
  // Reserve the new digest first. If replacement is interrupted, either the old
  // digest or this exact pending digest is accepted on the next preparation.
  writeState(recordFile,{schema:1,instanceId:options.instanceId,sha256:before===null?null:sha(before),pendingSha256:digest,...extra});
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    writeFileSync(temporary,contents,{flag:'wx',mode:before===null?0o600:statSync(path).mode&0o777});
    assert.equal(existsSync(path)?readFileSync(path,'utf8'):null,before,'Greeting changed during preparation');
    renameSync(temporary,path);
  }finally{rmSync(temporary,{force:true});}
  writeState(recordFile,{schema:1,instanceId:options.instanceId,sha256:digest,...extra});
  return {state:hold?'held':'updated',sha256:digest};
}

/** Completion follows the input actually written, rather than a second readiness
 * read that can race with Core preparation immediately after holding the file. */
export async function refreshFirstGreeting(options,welcome,{sync=syncGreeting}={}){
  if(welcome&&!welcome.done())await welcome.tick();
  const result=sync(options);
  return {...result,pending:result.state==='held'||Boolean(welcome&&!welcome.done())};
}
