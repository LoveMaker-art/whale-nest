import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {readClawChatPlatformState} from './clawchat-state.mjs';
import {installedPlugin,platformConfig} from './platform-client.mjs';

const exec = promisify(execFile);
const controlOrigin = 'http://127.0.0.1:47822';

export function createClawChatCore(options, {run=exec,runSync,fetchImpl=fetch}={}) {
  const {connectBin,configPath} = options.clawchat.delivery;
  assert.ok(isAbsolute(configPath));
  const installed = pluginId => installedPlugin(options,pluginId,{run:runSync});
  const binding = pluginId => {
    const config = platformConfig(options,{run:runSync});
    const bindings = Object.entries(config?.agents ?? {}).filter(([,value]) => value.runtime?.pluginId === pluginId);
    assert.equal(bindings.length, 1, 'Installation must belong to a single Agent');
    assert.equal(bindings[0][0], options.clawchat.route.account, 'Unexpected Connect binding');
    return {configuration:bindings[0][1]};
  };
  return {
    installed, binding,
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
