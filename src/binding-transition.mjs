import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readState,writeState} from './state.mjs';
import {clawchatBindingState} from './clawchat-state.mjs';

const fileFor=options=>join(options.dataDir,'binding-transition.json');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** A small write-ahead journal for our own files. Recovery accepts only the
 * verified activation and the recorded before/after values; concurrent edits
 * stop recovery rather than being overwritten. No platform data is changed. */
export function recoverBindingTransition(configPath,{afterWrite=()=>{}}={}){
  const options=readState(configPath,null),file=fileFor(options),job=readState(file,null);
  if(!job||job.state==='committed')return options;
  assert.equal(job.schema,1);assert.equal(job.instanceId,options.instanceId);
  assert.equal(resolve(job.configPath),resolve(configPath));
  const current=clawchatBindingState(options.clawchat.delivery.configPath,job.identity.account).current();
  for(const key of ['agent','owner','conversation'])assert.equal(current?.[key],job.identity[key],
    'Activation changed during binding recovery');
  const allowed=new Set(['first-binding.json','source-candidate.json','managed-liveware.json',
    'song-liveware.json','call-liveware.json','binding-reload.json'].map(name=>join(options.dataDir,name)));
  allowed.add(resolve(configPath));
  // Preflight every member before writing any remaining member.
  for(const entry of job.writes){
    assert.ok(allowed.has(resolve(entry.path)),'Unexpected binding transition target');
    const value=readState(entry.path,null);
    assert.ok(equal(value,entry.before)||equal(value,entry.after),'Binding input was edited during recovery: '+entry.path);
  }
  for(const entry of job.writes){
    if(!equal(readState(entry.path,null),entry.after))writeState(entry.path,entry.after);
    afterWrite(entry.path);
  }
  writeState(file,{...job,state:'committed'});
  return readState(configPath,null);
}

export function commitBindingTransition(options,configPath,identity,changes,dependencies){
  const writes=changes.map(([path,after])=>({path:resolve(path),before:readState(path,null),after}))
    .filter(entry=>!equal(entry.before,entry.after));
  if(!writes.length)return;
  writeState(fileFor(options),{schema:1,instanceId:options.instanceId,configPath:resolve(configPath),
    identity,state:'pending',writes});
  recoverBindingTransition(configPath,dependencies);
}
