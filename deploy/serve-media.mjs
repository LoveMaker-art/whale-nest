import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {extensionHostConfig,verifyInstalledConnector} from '../src/connector-extension.mjs';
import {prepareConnectorStartup} from '../src/connector-startup.mjs';
import {inspectSourceCandidate,sourceNodeOptions,selectedSourceRuntime} from '../src/source-candidate.mjs';
import {recoverBindingTransition} from '../src/binding-transition.mjs';

const home=homedir(),read=path=>JSON.parse(readFileSync(path,'utf8'));
const record=read(join(home,'.dsh/companion/aurabot-v1/connector-override.json'));
// Source compatibility is verified while preparing the installed extension.
verifyInstalledConnector(record);
const instancePath=join(home,'.dsh/companion/aurabot-v1/instance.json');
const instance=recoverBindingTransition(instancePath);
const candidate=inspectSourceCandidate(instance);
const ownRoot=candidate?.root??join(dirname(selectedSourceRuntime(instance).activeArtifact),'whalenest');
const {prepareFirstBinding}=await import(pathToFileURL(join(ownRoot,'src/first-binding.mjs')));
const {syncGreeting}=await import(pathToFileURL(join(ownRoot,'src/greeting.mjs')));
// Prepare identity and the official greeting input before Core caches routes
// or starts first greeting generation. No message is sent from this launcher.
prepareFirstBinding(instance,instancePath);
console.error('[whalenest-greeting] '+syncGreeting(instance).state);
process.env.WHALENEST_CORE_EPOCH=randomUUID();
if(candidate){
  process.env.WHALENEST_SOURCE_INSTANCE=join(instance.dataDir,'instance.json');
  process.env.NODE_OPTIONS=sourceNodeOptions(process.env.NODE_OPTIONS,fileURLToPath(new URL('../scripts/source-preload.mjs',import.meta.url)));
}else delete process.env.WHALENEST_SOURCE_INSTANCE;
await prepareConnectorStartup(instance,{migrateProfile:record.startupProfileScoped===true});
// Official Exposure alone owns the relay and its companion. An old combined
// deployment rolls back its matching launcher together with its Core.
process.env.CLAWCHAT_PRESERVE_PUBLICATIONS_ON_SHUTDOWN='1';
delete process.env.CLAWCHAT_CONNECT_AGENT_LIVEWARE_RELAY;
delete process.env.CLAWCHAT_CONNECT_LIVEWARE_PATH;
// The original host still verifies the complete signed base and owns run leases,
// drain/recovery, platform identity and service lifecycle. Only its launch target
// is a separately recorded, owner-authorized local extension.
const host='/opt/clawnest-integration/host';
const config=read(join(host,'host.json'));
const {main}=await import(pathToFileURL(join(host,'entry.mjs')));
process.exitCode=await main(extensionHostConfig(config,record),['serve'],'agent');
