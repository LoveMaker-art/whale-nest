import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {extensionHostConfig,verifyInstalledConnector} from '../src/connector-extension.mjs';
import {prepareConnectorStartup} from '../src/connector-startup.mjs';

const home=homedir(),read=path=>JSON.parse(readFileSync(path,'utf8'));
const record=read(join(home,'.dsh/companion/aurabot-v1/connector-override.json'));
// Source compatibility is verified while preparing the installed extension.
verifyInstalledConnector(record);
const instance=read(join(home,'.dsh/companion/aurabot-v1/instance.json'));
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
