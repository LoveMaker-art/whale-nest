import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {spawnSync} from 'node:child_process';
import {nativeSdkProfile,inspectConnectorStartup,prepareConnectorStartup,restoreConnectorStartup} from '../src/connector-startup.mjs';

const historical='- id: sandbox-policy\n  config:\n    mode: danger-full-access\n    workspaceRoot: !!js process.cwd()\n- id: system-prompt\n  config:\n    personaSuffix: |\n      fixture persona\n- id: sdk-jsonrpc-server\n  disabled: true\n';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'whalenest-startup-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const options={instanceId:'fixture-whale',home:join(root,'.dsh'),dataDir:join(root,'.dsh/companion/aurabot-v1')};
  const profileFile=join(options.home,'profiles/sdk/cordis.patch.yml'),processRoot=join(root,'proc');
  mkdirSync(dirname(profileFile),{recursive:true});mkdirSync(options.dataDir,{recursive:true});mkdirSync(processRoot);
  writeFileSync(profileFile,historical);
  return {root,options,profileFile,processRoot,ports:{processRoot},lease:join(options.dataDir,'runtime.lock')};
}

test('startup restores native SDK service while retaining permissions and persona; repeat and profile rollback preserve new data',t=>{
  const f=fixture(t),backup=join(f.root,'before-profile.yml');writeFileSync(backup,historical);
  const inspected=inspectConnectorStartup(f.options);
  const prepared=prepareConnectorStartup(f.options,{...f.ports,expectedProfileSha256:inspected.beforeSha256});
  const expected=historical.replace('- id: sdk-jsonrpc-server\n  disabled: true\n','');
  assert.equal(readFileSync(f.profileFile,'utf8'),expected);
  assert.equal(prepared.profile.changed,true);
  assert.equal(prepareConnectorStartup(f.options,f.ports).profile.changed,false);
  const session=join(f.options.dataDir,'new-session.json');writeFileSync(session,'new user data');
  assert.equal(restoreConnectorStartup(f.options,prepared,backup,f.ports).restored,true);
  assert.equal(readFileSync(f.profileFile,'utf8'),historical);
  assert.equal(readFileSync(session,'utf8'),'new user data');
});

test('startup recovers only a proven dead lease and retains the original lease metadata',t=>{
  const f=fixture(t),child=spawnSync(process.execPath,['-e',''],{stdio:'ignore'});
  assert.equal(child.status,0);assert.ok(child.pid);
  const lease={pid:child.pid,hostname:hostname(),instanceId:f.options.instanceId,startedAt:'fixture'};
  writeFileSync(f.lease,JSON.stringify(lease));
  const result=prepareConnectorStartup(f.options,f.ports);
  assert.equal(result.lease.recovered,true);assert.equal(existsSync(f.lease),false);
  assert.deepEqual(JSON.parse(readFileSync(result.lease.archive)),lease);
});

test('active or foreign lease prevents migration before the profile can change',t=>{
  const f=fixture(t);
  for(const lease of [
    {pid:process.pid,hostname:hostname(),instanceId:f.options.instanceId},
    {pid:process.pid,hostname:'another-host',instanceId:f.options.instanceId},
    {pid:process.pid,hostname:hostname(),instanceId:'another-instance'},
  ]) {
    writeFileSync(f.lease,JSON.stringify(lease));
    assert.throws(()=>prepareConnectorStartup(f.options,f.ports),/still running|another host|different instance/);
    assert.deepEqual(JSON.parse(readFileSync(f.lease)),lease);
    assert.equal(readFileSync(f.profileFile,'utf8'),historical);
  }
});

test('an SDK that has not acquired the companion lease still prevents profile migration',t=>{
  const f=fixture(t),proc=join(f.processRoot,'314');mkdirSync(proc);
  writeFileSync(join(proc,'cmdline'),['node','dsh','--profile','sdk',''].join('\0'));
  writeFileSync(join(proc,'environ'),'DSH_HOME='+f.options.home+'\0');
  assert.throws(()=>prepareConnectorStartup(f.options,f.ports),/Previous DSH SDK/);
  assert.equal(readFileSync(f.profileFile,'utf8'),historical);assert.equal(existsSync(f.lease),false);
});

test('rollback rejects profile edits and stale preflight instead of overwriting current settings',t=>{
  const f=fixture(t),backup=join(f.root,'before.yml');writeFileSync(backup,historical);
  const before=inspectConnectorStartup(f.options);
  const prepared=prepareConnectorStartup(f.options,f.ports);
  assert.throws(()=>prepareConnectorStartup(f.options,{...f.ports,expectedProfileSha256:before.beforeSha256}),/changed after preflight/);
  writeFileSync(f.profileFile,readFileSync(f.profileFile,'utf8')+'# a newer user edit\n');
  assert.throws(()=>restoreConnectorStartup(f.options,prepared,backup,f.ports),/profile changed/);
  assert.match(readFileSync(f.profileFile,'utf8'),/newer user edit/);
});

test('old connector startup leaves its global profile unchanged and richer overrides require review',t=>{
  const f=fixture(t);
  assert.equal(prepareConnectorStartup(f.options,{...f.ports,migrateProfile:false}).profile.changed,false);
  assert.equal(readFileSync(f.profileFile,'utf8'),historical);
  assert.throws(()=>nativeSdkProfile(historical+'  config:\n    enabled: false\n'),/additional settings/);
  assert.equal(nativeSdkProfile(historical.replaceAll('\n','\r\n')),historical.replace('- id: sdk-jsonrpc-server\n  disabled: true\n','').replaceAll('\n','\r\n'));
});
