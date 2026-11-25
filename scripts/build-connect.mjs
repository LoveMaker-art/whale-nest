import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
export const bridgeAssets=['deepseek-harness-tool-policy.mjs','deepseek-harness-question-provider.mjs',
 'deepseek-harness-frame.mjs','deepseek-harness-history.mjs'];
const ownedModules=['dsh-bridge.mjs','dsh-bridge-contract.mjs','dsh-bridge-wire.mjs','dsh-bridge-interactions.mjs','dsh-bridge-sessions.mjs'];
const sha=value=>createHash('sha256').update(value).digest('hex');

/** Package our entry and four unchanged, licensed protocol helpers. No
 * official Bridge or Runtime source is read, transformed or generated here.
 */
export async function buildConnectBridge(destination,{configPath,portable=false}={}){
 destination=resolve(destination);await mkdir(destination,{recursive:true,mode:0o700});
 const manifest=JSON.parse(await readFile(join(root,'integration/clawchat/SOURCE.json'))),helpers={};
 for(const name of bridgeAssets){
  const bytes=await readFile(join(root,'integration/clawchat/base',name));
  assert.equal(sha(bytes),manifest.files['base/'+name],'Compatible protocol helper changed: '+name);
  helpers[name]=sha(bytes);await copyFile(join(root,'integration/clawchat/base',name),join(destination,name));
 }
 const modulePath=portable?'./whalenest/src/dsh-bridge.mjs':pathToFileURL(join(root,'src/dsh-bridge.mjs')).href;
 const defaultPath=portable?'new URL("./companion/aurabot-v1/instance.json",pathToFileURL(config.home+"/"))'
  :configPath?JSON.stringify(resolve(configPath)):'new URL("./instance.json",import.meta.url)';
 const entry=`import {pathToFileURL} from 'node:url';
import {createWhaleDshBridgeEntry} from ${JSON.stringify(modulePath)};
import {registerClawChatApprovalPolicy} from './deepseek-harness-tool-policy.mjs';
import {registerQuestionProviderWhenProfileReady} from './deepseek-harness-question-provider.mjs';
import {encodeBridgeFrame} from './deepseek-harness-frame.mjs';
import {pageHistoryEvents} from './deepseek-harness-history.mjs';
export const createEntry=(businessAdapters={})=>createWhaleDshBridgeEntry({encodeBridgeFrame,pageHistoryEvents,registerClawChatApprovalPolicy,
 registerQuestionProviderWhenProfileReady,resolveConfigPath:config=>${defaultPath}},businessAdapters);
const bridge=createEntry();
export const name=bridge.name;
export const inject=bridge.inject;
export const apply=bridge.apply;
`;
 const sources={};for(const name of ownedModules)sources['src/'+name]=sha(await readFile(join(root,'src',name)));
 await writeFile(join(destination,'bridge.mjs'),entry,{mode:0o600});
 await writeFile(join(destination,'provenance.json'),JSON.stringify({implementation:'whalenest-dsh-business-bridge',
  protocol:2,baseline:manifest.baseline,bridgeSha256:sha(entry),sources,helpers,coreModule:'src/connect-bridge.mjs'},null,2));
 return join(destination,'bridge.mjs');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await buildConnectBridge(process.argv[2]??'.whale-nest/connect-build'));
