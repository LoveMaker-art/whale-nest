import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,renameSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {sdkProcesses,recoverLease} from './recovery.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');

/** Remove only our historical, standalone global disable. Other profile
 * patches, including permissions and persona, remain byte-for-byte intact.
 * A richer override is owned by its author and needs explicit adaptation. */
export function nativeSdkProfile(source) {
  const entries=[...source.matchAll(/^- id: sdk-jsonrpc-server[ \t]*\r?$/gm)];
  assert.ok(entries.length<=1,'SDK profile has ambiguous JSON-RPC overrides');
  if(!entries.length)return source;
  const start=entries[0].index;
  const rest=source.slice(start+entries[0][0].length);
  const next=/\n-(?: |\r?$)/m.exec(rest);
  const end=next?start+entries[0][0].length+next.index+1:source.length;
  const block=source.slice(start,end);
  if(!/^  disabled:[ \t]*true[ \t]*\r?$/m.test(block))return source;
  assert.equal(block.trimEnd().replaceAll('\r\n','\n'),'- id: sdk-jsonrpc-server\n  disabled: true',
    'SDK JSON-RPC override contains additional settings; adaptation required');
  return source.slice(0,start)+block.replace(/^- id: sdk-jsonrpc-server[ \t]*\r?\n  disabled: true[ \t]*(?:\r?\n|$)/,'')+source.slice(end);
}

export function inspectConnectorStartup(options,{migrateProfile=true}={}) {
  assert.ok(options?.instanceId&&options.home&&options.dataDir,'An existing instance is required for startup preparation');
  const profileFile=join(resolve(options.home),'profiles/sdk/cordis.patch.yml');
  const before=readFileSync(profileFile,'utf8');
  const after=migrateProfile?nativeSdkProfile(before):before;
  return {profileFile,beforeSha256:digest(before),afterSha256:digest(after),changed:before!==after,migrateProfile};
}

function assertOffline(options,processRoot) {
  assert.equal(sdkProcesses(options.home,processRoot).length,0,'Previous DSH SDK is still running; startup preparation withheld');
}

function replaceProfile(profileFile,beforeSha256,contents) {
  assert.equal(digest(readFileSync(profileFile)),beforeSha256,'SDK profile changed during startup preparation');
  const temporary=profileFile+'.'+randomUUID()+'.tmp';
  const mode=statSync(profileFile).mode&0o777;
  try {
    writeFileSync(temporary,contents,{flag:'wx',mode});
    assert.equal(digest(readFileSync(profileFile)),beforeSha256,'SDK profile changed during startup preparation');
    renameSync(temporary,profileFile);
  } finally {rmSync(temporary,{force:true});}
}

/** Run only before the official host starts, or after its supervisor has fully
 * stopped. Old connector records skip profile migration; their old bridge has
 * no process-local JSON-RPC override yet. */
export function prepareConnectorStartup(options,{migrateProfile=true,expectedProfileSha256,processRoot='/proc'}={}) {
  const profile=inspectConnectorStartup(options,{migrateProfile});
  if(expectedProfileSha256)assert.equal(profile.beforeSha256,expectedProfileSha256,'SDK profile changed after preflight');
  assertOffline(options,processRoot);
  // recoverLease refuses live, foreign-host or different-instance owners and
  // archives only lease metadata. It never restores conversation data.
  const lease=existsSync(join(options.dataDir,'runtime.lock'))?recoverLease(options):{recovered:false};
  if(profile.changed) {
    assertOffline(options,processRoot);
    replaceProfile(profile.profileFile,profile.beforeSha256,nativeSdkProfile(readFileSync(profile.profileFile,'utf8')));
  }
  return {profile,lease};
}

/** Rollback restores only a profile still owned by this migration. A newer
 * edit or an active SDK prevents replacement; sessions and receipts stay put. */
export function restoreConnectorStartup(options,prepared,backupFile,{processRoot='/proc'}={}) {
  const profile=prepared.profile??prepared;
  if(!profile.changed)return {restored:false};
  assert.equal(profile.profileFile,join(resolve(options.home),'profiles/sdk/cordis.patch.yml'),'Startup profile belongs to another instance');
  assertOffline(options,processRoot);
  const before=readFileSync(backupFile);
  assert.equal(digest(before),profile.beforeSha256,'SDK rollback profile does not match the original');
  replaceProfile(profile.profileFile,profile.afterSha256,before);
  return {restored:true};
}
