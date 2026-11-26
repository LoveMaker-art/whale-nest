import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,lstatSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {workspaceInstructionsSource,planWorkspaceInstructions,applyWorkspaceInstructions} from '../src/workspace-instructions.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const source=(version='1.0.0-beta.4.dev.21',template='可以记事、通话与创作。\n')=>({version,template,sha256:sha(template)});
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'whalenest-instructions-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const options={instanceId:'fixture',cwd:join(root,'workspace'),dataDir:join(root,'data')};mkdirSync(options.cwd);mkdirSync(options.dataDir);
  const prepare=input=>planWorkspaceInstructions(options,input),apply=input=>applyWorkspaceInstructions(prepare(input));
  return {root,options,prepare,apply,path:join(options.cwd,'AGENTS.md'),state:join(options.dataDir,'workspace-instructions.json'),journal:join(options.dataDir,'workspace-instructions.pending.json')};
}
const read=path=>readFileSync(path,'utf8');

test('the declared source verifies both packaged and installed templates, while legacy packages have no resource',()=>{
  const actual=workspaceInstructionsSource();assert.ok(actual.template.includes('歌曲创作'));
  const manifest={schema:1,name:'AGENTS.md',template:'capabilities.md',sha256:actual.sha256};
  const bundle={files:Object.fromEntries(Object.entries({'package.json':JSON.stringify({version:actual.version}),
    'src/assets/workspace-instructions.json':JSON.stringify(manifest),'src/assets/capabilities.md':actual.template}).map(([name,content])=>['artifacts/whalenest/'+name,{encoding:'utf8',content}]))};
  assert.deepEqual(workspaceInstructionsSource({bundle}),actual);
  assert.equal(workspaceInstructionsSource({bundle:{files:{}}}),null);
  bundle.files['artifacts/whalenest/src/assets/capabilities.md'].content+='改动';
  assert.throws(()=>workspaceInstructionsSource({bundle}),/checksum/);
});

test('preflight is read-only, creates one managed block and preserves existing instructions and mode',t=>{
  const f=fixture(t),user='用户自己的运行规则。\n';writeFileSync(f.path,user,{mode:0o640});chmodSync(f.path,0o640);
  const plan=f.prepare(source());assert.equal(read(f.path),user);assert.equal(existsSync(f.state),false);
  const previousMask=process.umask(0o077);
  try{assert.equal(applyWorkspaceInstructions(plan).changed,true);}finally{process.umask(previousMask);}
  assert.ok(read(f.path).startsWith(user));
  assert.equal(lstatSync(f.path).mode&0o777,0o640);
  const inode=lstatSync(f.path).ino;assert.equal(f.apply(source()).changed,false);assert.equal(lstatSync(f.path).ino,inode);
  assert.equal(applyWorkspaceInstructions(plan).changed,false,'an acknowledged commit may be replayed');
});

test('upgrades and rollbacks replace only the managed block and preserve notes added after installation',t=>{
  const f=fixture(t),original='原有规则';writeFileSync(f.path,original);
  f.apply(source());writeFileSync(f.path,read(f.path)+'\n后加的私人说明。\n');
  f.apply(source('1.0.0-beta.4.dev.22','新能力摘要。\n'));
  assert.match(read(f.path),/新能力摘要/);assert.match(read(f.path),/后加的私人说明/);assert.doesNotMatch(read(f.path),/可以记事/);
  f.apply(source());assert.match(read(f.path),/可以记事/);assert.doesNotMatch(read(f.path),/新能力摘要/);
  f.apply(null);assert.equal(read(f.path),original+'\n后加的私人说明。\n');
  assert.equal(JSON.parse(read(f.state)).phase,'removed');assert.equal(f.apply(null).changed,false);
});

test('a rollback to a legacy package removes an otherwise empty generated file and can install again',t=>{
  const f=fixture(t);f.apply(source());f.apply(null);assert.equal(existsSync(f.path),false);
  f.apply(source());assert.match(read(f.path),/可以记事/);
});

test('manual managed-block edits and deletion are preserved instead of silently overwritten',t=>{
  const f=fixture(t);f.apply(source());const state=read(f.state);
  writeFileSync(f.path,read(f.path).replace('可以记事','用户自改'));
  const edited=read(f.path);assert.throws(()=>f.prepare(source('1.0.0-beta.4.dev.22')),/edited/);
  assert.equal(read(f.path),edited);assert.equal(read(f.state),state);
  rmSync(f.path);assert.throws(()=>f.prepare(source()),/removed/);assert.equal(existsSync(f.path),false);
});

test('user changes after preflight invalidate a pending replacement, while replanning preserves those changes',t=>{
  const f=fixture(t);f.apply(source());const next=source('1.0.0-beta.4.dev.22','另一版内容。\n'),plan=f.prepare(next);
  writeFileSync(f.path,read(f.path)+'\n新增用户规则。\n');assert.throws(()=>applyWorkspaceInstructions(plan),/after preflight/);
  f.apply(next);assert.match(read(f.path),/新增用户规则/);
  assert.equal(applyWorkspaceInstructions(plan).changed,false,'replay after a successful replan is harmless');
});

test('symlinks, foreign ownership, forged markers and invalid UTF-8 are rejected without touching their targets',t=>{
  const f=fixture(t),outside=join(f.root,'outside');writeFileSync(outside,'保留');symlinkSync(outside,f.path);
  assert.throws(()=>f.prepare(source()),/regular file/);assert.equal(read(outside),'保留');rmSync(f.path);
  writeFileSync(f.path,'<!-- whalenest:capabilities:begin -->\n伪造\n<!-- whalenest:capabilities:end -->\n');
  assert.throws(()=>f.prepare(source()),/edited/);rmSync(f.path);
  writeFileSync(f.path,Buffer.from([0xff]));assert.throws(()=>f.prepare(source()),/UTF-8/);rmSync(f.path);
  f.apply(source());const state=JSON.parse(read(f.state));state.instanceId='other';writeFileSync(f.state,JSON.stringify(state));
  assert.throws(()=>f.prepare(source()),/ownership/);
});

test('recovery completes an interrupted file/state pair before upgrading, reverting or replaying it',t=>{
  for(const afterFile of [false,true]){
    const f=fixture(t);f.apply(source());const next=source('1.0.0-beta.4.dev.22','中断后的新内容。\n'),plan=f.prepare(next);
    writeFileSync(f.journal,JSON.stringify({schema:1,beforeFileHash:plan.before.file.hash,beforeStateHash:plan.before.state.hash,
      afterFileHash:sha(plan.afterText),afterState:plan.afterState}));
    if(afterFile)writeFileSync(f.path,plan.afterText);
    f.apply(source());assert.match(read(f.path),/可以记事/);assert.equal(existsSync(f.journal),false);
    f.apply(next);assert.match(read(f.path),/中断后的新内容/);
  }
});

test('a changed interrupted pair and an active writer are not adopted; a verified dead writer is recoverable',t=>{
  const f=fixture(t);f.apply(source());const plan=f.prepare(source('1.0.0-beta.4.dev.22'));
  writeFileSync(f.journal,JSON.stringify({schema:1,beforeFileHash:plan.before.file.hash,beforeStateHash:plan.before.state.hash,afterFileHash:sha(plan.afterText),afterState:plan.afterState}));
  writeFileSync(f.path,read(f.path)+'用户新内容');assert.throws(()=>f.prepare(source()),/interrupted/);rmSync(f.journal);
  const lock=join(f.options.dataDir,'workspace-instructions.lock');
  writeFileSync(lock,JSON.stringify({instanceId:'fixture',hostname:hostname(),pid:process.pid,token:'active'}));
  assert.throws(()=>f.apply(source()),/active/);rmSync(lock);
  writeFileSync(lock,JSON.stringify({instanceId:'fixture',hostname:hostname(),pid:2147483647,token:'dead'}));
  assert.equal(f.apply(source()).changed,false);assert.equal(existsSync(lock),false);
});
