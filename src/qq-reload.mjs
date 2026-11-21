import assert from 'node:assert/strict';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readState, writeState} from './state.mjs';
import {qqManagementFile} from './qq-transition.mjs';
import {routeKey, senderKey} from './routing.mjs';

const pluginId = 'whalenest.runtime.deepseek-harness';

/** Reconfigure the existing installation through Core's draining lifecycle.
 * Runs outside the SDK process being replaced; never installs another Agent. */
export async function reloadQQConnection(configPath, jobId, {fetchImpl = fetch} = {}) {
  const options = readState(resolve(configPath), null), file = qqManagementFile(options);
  const update = (fields) => {
    const state = readState(file, null), job = state?.transition;
    if (job?.id === jobId && job.state === 'queued') { Object.assign(job, fields); writeState(file, state); }
  };
  const job = readState(file, null)?.transition;
  if (job?.id !== jobId || job.state !== 'queued' || job.reloadState) return;
  try {
    assert.equal(resolve(job.configPath), resolve(configPath));
    assert.equal(job.instanceId, options.instanceId);
    assert.equal(senderKey(job.actor), senderKey(options.clawchat.route));
    assert.equal(routeKey(job.actor), routeKey(options.clawchat.route));
    const corePath = resolve(options.clawchat.delivery.configPath);
    const core = readState(corePath, null), lock = readState(resolve(dirname(corePath), 'plugins.lock.json'), null);
    const installed = lock?.plugins?.[pluginId];
    assert.equal(installed?.status, 'active', '鲸栖Runtime未在当前Core启用');
    const bindings = Object.entries(core.agents ?? {}).filter(([, value]) => value.runtime?.pluginId === pluginId);
    assert.equal(bindings.length, 1, '当前安装被多个Agent共用，不能隐式重载其他Agent');
    assert.equal(bindings[0][0], options.clawchat.route.account, 'Core绑定与当前主人通道不一致');
    const body = {installationConfiguration: installed.installationConfiguration ?? {},
      capabilityConfigurations: installed.capabilityConfigurations ?? {},
      runtimeConfigurations: {[bindings[0][0]]: bindings[0][1].runtimeConfig ?? {}}};
    // Persist before submitting. A timeout or process death must not resubmit
    // a configuration change whose completion is unknown.
    update({reloadState:'submitting'});
    const response = await fetchImpl('http://127.0.0.1:47822/core/v1/plugins/' + pluginId + '/configure', {
      method:'POST', headers:{'content-type':'application/json', 'X-ClawChat-Connect-Core-Config-Path':corePath},
      body:JSON.stringify(body), signal:AbortSignal.timeout(45000), redirect:'error',
    });
    if (!response.ok) { update({state:'failed',reloadState:'rejected'}); return; }
    // The SDK may already have confirmed the transition. Never overwrite it.
    update({reloadState:'accepted-awaiting-runtime'});
  } catch {
    const current = readState(file, null)?.transition;
    update(current?.reloadState === 'submitting' ? {reloadState:'uncertain'} : {state:'failed',reloadState:'preflight-failed'});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await reloadQQConnection(process.argv[2],process.argv[3]);
}
