import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {importNative} from './native-dsh.mjs';
import { apply, inject } from './aurabot-host.generated.mjs';

const [{default:SessionController},{default:AgentPresets},{default:AgentPreset}]=await Promise.all([
  importNative('@deepseek-ai/dsh-api-session-controller'),importNative('@deepseek-ai/dsh-agent-preset-registry'),
  importNative('@deepseek-ai/dsh-agent-preset'),
]);

/** One original host and module manager; QQ uses its original Hub. */
export async function createNativeAurabot(ctx, adapters) {
  assert.ok(!ctx.get('aurabot'),'Original Aurabot is already loaded; a second host must not start');
  const forks = [];
  let host;
  const mount = async (plugin, config) => {
    const fork = ctx.plugin(plugin, config);
    forks.push(fork);
    await fork;
    return fork;
  };
  const dispose = async () => {
    for (const fork of forks.reverse()) await fork.dispose();
    forks.length = 0;
  };
  try {
    if (!ctx.get('agentPresets')) {
      await mount(AgentPresets, {default:'whalenest-sdk'});
      await mount(AgentPreset, {id:'whalenest-sdk',name:'ClawChat SDK',plugins:[]});
    }
    assert.ok(ctx.get('agentPresets'), 'Official Agent preset registry did not start');
    for (const row of JSON.parse(readFileSync(new URL('./aurabot-presets.generated.json', import.meta.url)))) {
      await mount(AgentPreset, row.config);
    }
    if (!ctx.get('sessionController')) await mount(SessionController, { nativeOpen: false });
    assert.ok(ctx.get('sessionController'), 'Official session controller did not start; missing: '+SessionController.inject.filter(name=>!ctx.get(name)).join(','));
    await mount({ name: 'whalenest-original-aurabot', inject,
      apply(scope) { host = apply(scope, adapters); } });
    assert.ok(host, 'Original Aurabot host did not start');
    await host.ready;
    return Object.assign(host,{dispose});
  } catch (error) { await dispose(); throw error; }
}
