import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectBridge } from './build-connect.mjs';
import { prepareProfile } from '../src/profile.mjs';
import { enablePlatformSinging, enablePlatformSpeech } from '../src/runtime-upgrade.mjs';

export async function prepareConnect(configPath, destination) {
  configPath = resolve(configPath); destination = resolve(destination);
  const options = JSON.parse(await readFile(configPath));
  assert.ok(typeof options.home === 'string' && isAbsolute(options.home), 'An explicit absolute DSH_HOME is required');
  assert.ok(typeof options.dataDir === 'string' && isAbsolute(options.dataDir), 'An explicit absolute dataDir is required');
  assert.ok(options.instanceId, 'Instance identity required');
  const unpaired = options.clawchat?.firstBinding === true && !options.clawchat.route;
  if (unpaired) {
    assert.ok(!options.owners?.length && !options.clawchat.legacySnapshotPath, 'An unpaired instance must have no copied owner or legacy session');
    assert.ok(isAbsolute(options.clawchat.delivery.configPath) && isAbsolute(options.clawchat.delivery.connectBin), 'The preinstalled instance needs Connect paths');
    const providerConfigPath=options.speech?.providerConfigPath??join(dirname(options.home),'.clawchat-dsh/config.json');
    options.realtime={enabled:options.speech?.enabled!==false,...options.realtime};
    if(options.realtime.enabled && options.speech?.enabled!==false)
      options.speech=enablePlatformSpeech({providerConfigPath,...options.speech});
    options.singing={enabled:true,...options.singing,playback:{enabled:options.singing?.enabled!==false,...options.singing?.playback}};
    if(options.singing.enabled)options.singing=enablePlatformSinging({providerConfigPath,...options.singing});
  } else {
    assert.ok(options.owners?.length && options.clawchat?.route?.channel === 'clawchat' && options.clawchat.route.kind === 'private',
      'A verified ClawChat private route is required');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entry = await buildConnectBridge(destination);
  const preparedConfig=join(destination, 'instance.json');
  await writeFile(preparedConfig, JSON.stringify(options, null, 2), { mode: 0o600 });
  await prepareProfile(options.home, preparedConfig, { bridgeEntry: entry, externalOverlay: true });
  const plan = { schema: 1, state: 'prepared-not-active', bridgeEntry: entry, profile: 'whalenest', home: options.home,
    connectionOwner: 'existing ClawChat Core', automaticTaskCreation: false, accountBindingChanged: false,
    removeAfterCutover: ['dsh-mnemon', 'dsh-feiyu-mood', 'dsh-bili-subagent'],
    preserve: ['original persona', 'native session logs', 'native schedule state and pauses', 'delivery acknowledgements', 'private backups'],
    requiredBeforeCutover: ['verify host model/provider configuration', 'verify instance and old session identity',
      'freeze and verify final data conversion', 'verify Bili functionality requirements', 'exercise rollback including new data'],
  };
  await writeFile(join(destination, 'cutover-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
  return plan;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2] && process.argv[3], 'Usage: node scripts/prepare-connect.mjs INSTANCE_JSON OUTPUT_DIRECTORY');
  const plan = await prepareConnect(process.argv[2], process.argv[3]);
  console.log(JSON.stringify({ state: plan.state, bridgeEntry: plan.bridgeEntry, profile: plan.profile }));
}
