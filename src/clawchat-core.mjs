import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {readState} from './state.mjs';
import {readClawChatToolStatus,readClawChatPlatformState} from './clawchat-state.mjs';

const exec = promisify(execFile);
const controlOrigin = 'http://127.0.0.1:47822';

export function configuredConnectExecutable(options, config) {
  const executable = options?.clawchat?.delivery?.connectBin
    ?? join(dirname(dirname(config.agents.dsh.runtimeConfig.executablePathOverride)), 'clawchat-connect');
  assert.ok(typeof executable === 'string' && isAbsolute(executable), 'An absolute configured Connect executable is required');
  return executable;
}

export function createClawChatCore(options, {run=exec,fetchImpl=fetch}={}) {
  const {connectBin,configPath} = options.clawchat.delivery;
  assert.ok(isAbsolute(configPath));
  const lockPath = join(dirname(configPath), 'plugins.lock.json');
  const installed = pluginId => readState(lockPath, null)?.plugins?.[pluginId];
  const binding = pluginId => {
    const config = readState(configPath, null);
    const bindings = Object.entries(config?.agents ?? {}).filter(([,value]) => value.runtime?.pluginId === pluginId);
    assert.equal(bindings.length, 1, 'Installation must belong to a single Agent');
    assert.equal(bindings[0][0], options.clawchat.route.account, 'Unexpected Connect binding');
    return {configuration:bindings[0][1], stateDbPath:config.stateDbPath};
  };
  return {
    installed, binding,
    toolStatus:(toolName, requestId) => readClawChatToolStatus(configPath, options.clawchat.route.account, toolName, requestId),
    async state() {
      return readClawChatPlatformState({connectBin,configPath},{run});
    },
    async change(pluginId, operation, body, timeout=60000) {
      const response = await fetchImpl(controlOrigin+'/core/v1/plugins/'+encodeURIComponent(pluginId)+'/'+encodeURIComponent(operation), {
        method:'POST', headers:{'Content-Type':'application/json','X-ClawChat-Connect-Core-Config-Path':configPath},
        body:JSON.stringify(body), signal:AbortSignal.timeout(timeout), redirect:'error',
      });
      await response.body?.cancel();
      return response.ok;
    },
  };
}
