import assert from 'node:assert/strict';
import {readFileSync,createReadStream} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {extensionHostConfig,coreCommit} from '../src/connector-extension.mjs';

const home=homedir(),read=path=>JSON.parse(readFileSync(path,'utf8'));
const record=read(join(home,'.dsh/companion/aurabot-v1/connector-override.json'));
const state=read(join(home,'.clawnest-integrations/deepseek-harness/state.json'));
assert.equal(state.selected,record.baseReleaseId,'Official integration changed; rebase the local media extension before starting');
assert.equal(record.upstreamCommit,coreCommit,'Unreviewed connector extension');
const hash=createHash('sha256');for await(const bytes of createReadStream(join(record.directory,'clawchat-connect-core')))hash.update(bytes);
assert.equal(hash.digest('hex'),record.binarySha256,'Media connector integrity mismatch');
assert.equal(createHash('sha256').update(readFileSync(join(record.directory,'clawchat-connect'))).digest('hex'),record.launcherSha256,'Platform compatibility launcher changed');
if(record.runtimeLibSha256)assert.equal(createHash('sha256').update(readFileSync(join(record.directory,'runtime/lib.mjs'))).digest('hex'),record.runtimeLibSha256,'Runtime model conversion changed');
if(record.livewareCompanion){
 assert.equal(createHash('sha256').update(readFileSync(record.livewareCompanion.path)).digest('hex'),record.livewareCompanion.sha256,'Liveware companion changed');
 process.env.CLAWCHAT_CONNECT_LIVEWARE_PATH=record.livewareCompanion.path;
 const instance=read(join(home,'.dsh/companion/aurabot-v1/instance.json'));
 if(instance.realtime?.enabled||instance.singing?.playback?.enabled)
  process.env.CLAWCHAT_CONNECT_AGENT_LIVEWARE_RELAY='1';
}
// The original host still verifies the complete signed base and owns run leases,
// drain/recovery, platform identity and service lifecycle. Only its launch target
// is a separately recorded, owner-authorized local extension.
const host='/opt/clawnest-integration/host';
const config=read(join(host,'host.json'));
const {main}=await import(pathToFileURL(join(host,'entry.mjs')));
process.exitCode=await main(extensionHostConfig(config,record),['serve'],'agent');
