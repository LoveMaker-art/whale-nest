import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {readState,writeState} from './state.mjs';
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
export function syncGreeting(options,persona=currentGreetingPersona(options)){
  assert.ok(persona?.body?.trim(),'Greeting requires the complete current persona');
  const path=join(options.cwd??options.dataDir,'greeting.md'),recordFile=join(options.dataDir,'greeting-input.json');
  const before=existsSync(path)?readFileSync(path,'utf8'):null,record=readState(recordFile,null);
  const contents='<!-- whalenest: current persona for the official first greeting -->\n'
    +'以下是我当前的人格，首次见面时也沿用同一个身份、关系和说话方式。\n\n'
    +persona.body.trim()+'\n\n---\n\n'+instruction;
  const digest=sha(contents);
  if(before===contents){
    writeState(recordFile,{schema:1,instanceId:options.instanceId,sha256:digest});
    return {state:'current',sha256:digest};
  }
  if(before!==null&&sha(before)!==legacy&&sha(before)!==sha(instruction)
      &&(!record||record.instanceId!==options.instanceId||![record.sha256,record.pendingSha256].includes(sha(before))))
    return {state:'conflict',reason:'custom-greeting-preserved'};
  // Reserve the new digest first. If replacement is interrupted, either the old
  // digest or this exact pending digest is accepted on the next preparation.
  writeState(recordFile,{schema:1,instanceId:options.instanceId,sha256:before===null?null:sha(before),pendingSha256:digest});
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    writeFileSync(temporary,contents,{flag:'wx',mode:before===null?0o600:statSync(path).mode&0o777});
    assert.equal(existsSync(path)?readFileSync(path,'utf8'):null,before,'Greeting changed during preparation');
    renameSync(temporary,path);
  }finally{rmSync(temporary,{force:true});}
  writeState(recordFile,{schema:1,instanceId:options.instanceId,sha256:digest});
  return {state:'updated',sha256:digest};
}
