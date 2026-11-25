import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {comparePluginVersions,validateUpdatePrerequisites} from './plugin-release.mjs';
import {readState} from './state.mjs';

const exec=promisify(execFile);
const busyJobs=new Set(['accepted','running']);

export function connectorRequirement(release) {
  return validateUpdatePrerequisites(release.prerequisites)?.clawchatIntegration;
}

/** Only the image's public, signed-integration updater performs installation.
 * A release cannot supply an executable, source URL, trust key or command. */
export function createOfficialConnectorUpdater(options,{run=exec}={}) {
  const executable=options.pluginUpdates?.connectorExecutable??'/usr/local/bin/clawchat-dsh';
  assert.ok(isAbsolute(executable),'An absolute official updater executable is required');
  async function command(args,timeout=15000) {
    const {stdout}=await run(executable,['plugin',...args],{cwd:options.cwd,timeout,maxBuffer:1024*1024});
    const value=JSON.parse(stdout);
    assert.ok(value && typeof value==='object' && !Array.isArray(value),'Invalid official updater response');
    return value;
  }
  return {
    async inspect() {
      const value=await command(['status']);
      const override=readState(join(options.dataDir,'connector-override.json'),null);
      const custom=Boolean(override?.directory && options.clawchat.delivery.connectBin===join(override.directory,'clawchat-connect'));
      return {...value,effective:{custom,version:custom?override.baseVersion:value.running?.version}};
    },
    async prepare(requirement) {
      const checked=await command(['check','--version',requirement.upgradeVersion],30000);
      assert.ok(['current','update_available'].includes(checked.status),'No compatible official connector release');
      assert.equal(checked.release?.version,requirement.upgradeVersion,'Unexpected official connector release');
      assert.equal(checked.release.runtime,'deepseek-harness');
      assert.equal(checked.release.plugin,'clawchat-connect');
      assert.equal(checked.downgrade_requested,false,'Automatic connector downgrade is not allowed');
      assert.match(checked.release.artifact?.sha256??'',/^[a-f0-9]{64}$/);
      return {version:checked.release.version,target:checked.release.version+'-'+checked.release.artifact.sha256};
    },
    upgrade:requirement=>command(['upgrade','--version',requirement.upgradeVersion,'--defer'],180000),
    rollback:()=>command(['rollback','--defer'],180000),
  };
}

export function connectorPlan(status,requirement) {
  const health=status.running?.health;
  const current=status.effective?.version;
  const ready=status.status==='running' && status.selected?.id===status.running?.id &&
    status.selected?.version===status.running?.version && health?.version===status.running?.version &&
    health.ready===true && health.connected===true && health.draining!==true;
  if (!ready || busyJobs.has(status.job?.status)) return {state:'unavailable',current};
  assert.ok(typeof health.identity==='string' && health.identity,'Official connector identity is missing');
  assert.match(current??'',/^\d+\.\d+\.\d+$/,'Actual connector base version is missing');
  const sufficient=comparePluginVersions(current,requirement.minimumVersion)>=0;
  if (status.effective?.custom && (!sufficient || requirement.officialOnly)) {
    return {state:'migration-required',current,required:requirement.minimumVersion,
      message:'当前仍运行定制连接器，需要配套迁移版本；没有切换官方底座或继续安装鲸栖。'};
  }
  return {state:sufficient?'ready':'upgrade-required',current,required:requirement.minimumVersion,
    ...(sufficient?{}:{target:requirement.upgradeVersion})};
}

export function connectorSnapshot(status) {
  return {selectedId:status.selected?.id,version:status.running?.version,
    identity:status.running?.health?.identity,jobId:status.job?.id};
}
