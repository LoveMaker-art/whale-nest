import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,fsyncSync,fchmodSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {hostname} from 'node:os';
import {fileURLToPath} from 'node:url';

const begin='<!-- whalenest:capabilities:begin -->';
const end='<!-- whalenest:capabilities:end -->';
const resource='src/assets/workspace-instructions.json';
const digest=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>JSON.stringify(value,null,2)+'\n';
const conflict=message=>Object.assign(Error('Workspace instructions: '+message),{code:'WORKSPACE_INSTRUCTIONS_CONFLICT'});

function file(path) {
  let info;
  try{info=lstatSync(path);}catch(error){if(error.code==='ENOENT')return {text:null,hash:null,mode:0o600};throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw conflict('expected a regular file within the size limit');
  const bytes=readFileSync(path);
  const text=bytes.toString('utf8');
  if(!Buffer.from(text).equals(bytes))throw conflict('file must be UTF-8');
  return {text,hash:digest(bytes),mode:info.mode&0o777};
}

/** Read only this plugin's declared resource. Older packages have no resource. */
export function workspaceInstructionsSource({bundle,installedRoot}={}) {
  const root=installedRoot??fileURLToPath(new URL('../',import.meta.url));
  const get=relative=>{
    if(bundle){
      const entry=bundle.files?.['artifacts/whalenest/'+relative];
      if(!entry)return null;
      assert.ok(['utf8','base64'].includes(entry.encoding));
      return Buffer.from(entry.content,entry.encoding);
    }
    const path=join(root,relative);
    return existsSync(path)?readFileSync(path):null;
  };
  const bytes=get(resource);
  if(!bytes)return null;
  const manifest=JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.schema,1);assert.equal(manifest.name,'AGENTS.md');
  assert.equal(manifest.template,'capabilities.md');assert.match(manifest.sha256,/^[a-f0-9]{64}$/);
  const template=get('src/assets/'+manifest.template),pkg=get('package.json');
  assert.ok(template&&pkg,'Managed instructions resource is incomplete');
  assert.equal(digest(template),manifest.sha256,'Managed instructions resource checksum mismatch');
  const version=JSON.parse(pkg.toString('utf8')).version;
  assert.match(version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.ok(!template.includes(begin)&&!template.includes(end),'Resource contains reserved markers');
  return {version,template:template.toString('utf8'),sha256:manifest.sha256};
}

function paths(options) {
  assert.ok(typeof options.instanceId==='string'&&options.instanceId.trim());
  assert.ok(isAbsolute(options.cwd)&&isAbsolute(options.dataDir));
  const cwd=realpathSync(options.cwd),directory=resolve(options.dataDir);
  return {instanceId:options.instanceId,cwd,directory,path:join(cwd,'AGENTS.md'),
    state:join(directory,'workspace-instructions.json'),journal:join(directory,'workspace-instructions.pending.json'),
    lock:join(directory,'workspace-instructions.lock')};
}

function owned(state,p) {
  if(!state||state.schema!==1||state.instanceId!==p.instanceId||state.cwd!==p.cwd||state.path!==p.path
    ||!['managed','removed'].includes(state.phase))throw conflict('ownership record does not match this instance and workspace');
  return state;
}

function pendingView(p,before) {
  let state=before.state.text===null?null:owned(JSON.parse(before.state.text),p);
  if(before.journal.text===null)return state;
  const pending=JSON.parse(before.journal.text);
  owned(pending.afterState,p);
  if(pending.schema!==1)throw conflict('unsupported recovery record');
  if(before.file.hash===pending.beforeFileHash&&before.state.hash===pending.beforeStateHash)return state;
  if(before.file.hash===pending.afterFileHash&&[pending.beforeStateHash,digest(encoded(pending.afterState))].includes(before.state.hash))return pending.afterState;
  throw conflict('files changed during an interrupted synchronization');
}

function split(text) {
  text??='';
  const at=text.indexOf(begin),last=text.indexOf(end);
  if(at===-1&&last===-1)return {prefix:text,block:null,suffix:''};
  if(at===-1||last<at||text.indexOf(begin,at+begin.length)!==-1||text.indexOf(end,last+end.length)!==-1
    ||at>0&&text[at-1]!=='\n')throw conflict('managed markers were changed');
  const stop=last+end.length+(text[last+end.length]==='\n'?1:0);
  return {prefix:text.slice(0,at),block:text.slice(at,stop),suffix:text.slice(stop)};
}

/** Pure preflight, including ownership, user edits and interrupted-write checks. */
export function planWorkspaceInstructions(options,source=workspaceInstructionsSource()) {
  const p=paths(options),before={file:file(p.path),state:file(p.state),journal:file(p.journal)};
  const state=pendingView(p,before),parts=split(before.file.text);
  if(parts.block&&(state?.phase!=='managed'||digest(parts.block)!==state.blockSha256))throw conflict('managed content was edited; original retained');
  if(state?.phase==='managed'&&!parts.block)throw conflict('managed content was removed; original retained');
  if(!source&&!parts.block&&!state)return {...p,source,before,afterText:before.file.text,afterState:null,changed:false};
  let {prefix,suffix}=parts,separator=state?.separator??'',block=null;
  if(source){
    assert.match(source.version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.equal(digest(source.template),source.sha256,'Managed resource changed after preparation');
    if(!parts.block){separator=prefix&&!prefix.endsWith('\n\n')?(prefix.endsWith('\n')?'\n':'\n\n'):'';prefix+=separator;}
    block=begin+'\n<!-- version: '+source.version+'; sha256: '+source.sha256+' -->\n'+source.template.trimEnd()+'\n'+end+'\n';
  }else if(separator&&prefix.endsWith(separator))prefix=prefix.slice(0,-separator.length);
  const text=prefix+(block??'')+suffix;
  const afterText=text||null;
  const afterState={schema:1,instanceId:p.instanceId,cwd:p.cwd,path:p.path,phase:source?'managed':'removed',
    version:source?.version??null,templateSha256:source?.sha256??null,blockSha256:block?digest(block):null,separator:source?separator:''};
  return {...p,source,before,afterText,afterState,
    changed:before.file.text!==afterText||before.state.text!==encoded(afterState)||before.journal.text!==null};
}

function atomic(path,text,mode=0o600) {
  if(text===null){rmSync(path,{force:true});return;}
  const temporary=join(dirname(path),'.'+randomUUID()+'.whalenest-instructions');
  const fd=openSync(temporary,'wx',mode);
  try{
    try{writeFileSync(fd,text);fchmodSync(fd,mode);fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temporary,path);
  }finally{rmSync(temporary,{force:true});}
}

function lock(p) {
  mkdirSync(p.directory,{recursive:true,mode:0o700});
  for(let attempt=0;attempt<2;attempt++){
    try{
      const fd=openSync(p.lock,'wx',0o600),token=randomUUID();
      try{writeFileSync(fd,encoded({instanceId:p.instanceId,hostname:hostname(),pid:process.pid,token}));}
      catch(error){rmSync(p.lock,{force:true});throw error;}
      finally{closeSync(fd);}
      return ()=>{const current=file(p.lock);if(current.text&&JSON.parse(current.text).token===token)rmSync(p.lock);};
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      const current=file(p.lock),owner=JSON.parse(current.text);
      if(owner.instanceId!==p.instanceId||owner.hostname!==hostname()||!Number.isSafeInteger(owner.pid)||owner.pid<1)throw conflict('synchronization owner needs inspection');
      try{process.kill(owner.pid,0);throw conflict('another synchronization is active');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      if(file(p.lock).hash!==current.hash)throw conflict('synchronization owner changed');
      rmSync(p.lock);
    }
  }
  throw conflict('could not acquire synchronization ownership');
}

/** Commit the prepared managed block, preserving all text outside it. */
export function applyWorkspaceInstructions(plan) {
  const unlock=lock(plan);
  try{
    const current=planWorkspaceInstructions({instanceId:plan.instanceId,cwd:plan.cwd,dataDir:plan.directory},plan.source);
    if(!current.changed)return {state:current.afterState?.phase??'unmanaged',version:current.afterState?.version??null,path:current.path,changed:false};
    for(const [key,path]of [['file',plan.path],['state',plan.state],['journal',plan.journal]])
      if(file(path).hash!==plan.before[key].hash)throw conflict('input changed after preflight');
    if(plan.before.journal.text!==null){
      const pending=JSON.parse(plan.before.journal.text);
      if(plan.before.file.hash===pending.afterFileHash)atomic(plan.state,encoded(pending.afterState));
      rmSync(plan.journal);
    }
    plan=planWorkspaceInstructions({instanceId:plan.instanceId,cwd:plan.cwd,dataDir:plan.directory},plan.source);
    if(!plan.changed)return {state:plan.afterState?.phase??'unmanaged',version:plan.afterState?.version??null,path:plan.path,changed:false};
    const afterFileHash=plan.afterText===null?null:digest(plan.afterText);
    atomic(plan.journal,encoded({schema:1,beforeFileHash:plan.before.file.hash,beforeStateHash:plan.before.state.hash,afterFileHash,afterState:plan.afterState}));
    // Repeat immediately before the replacement, including user edits outside the block.
    if(file(plan.path).hash!==plan.before.file.hash||file(plan.state).hash!==plan.before.state.hash)throw conflict('input changed during synchronization');
    atomic(plan.path,plan.afterText,plan.before.file.mode);
    atomic(plan.state,encoded(plan.afterState));
    rmSync(plan.journal);
    return {state:plan.afterState.phase,version:plan.afterState.version,path:plan.path,changed:true};
  }finally{unlock();}
}
