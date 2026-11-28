import {ownRoot as installedOwnRoot} from '../src/platform-client.mjs';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareConnectorStartup} from '../src/connector-startup.mjs';
import {inspectSourceCandidate,sourceNodeOptions,sourceBunOptions,selectedSourceRuntime} from '../src/source-candidate.mjs';
import {recoverBindingTransition} from '../src/binding-transition.mjs';

const home=homedir(),read=path=>JSON.parse(readFileSync(path,'utf8'));
const instancePath=join(home,'.dsh/companion/aurabot-v1/instance.json');
const instance=recoverBindingTransition(instancePath);
const candidate=inspectSourceCandidate(instance);
const ownRoot=candidate?.root??installedOwnRoot(instance);
const {prepareFirstBinding}=await import(pathToFileURL(join(ownRoot,'src/first-binding.mjs')));
const {beginStartup}=await import(pathToFileURL(join(ownRoot,'src/startup-state.mjs')));
process.env.WHALENEST_CORE_EPOCH=randomUUID();
process.env.WHALENEST_NODE_EXECUTABLE=process.execPath;
beginStartup(instance);
const {syncGreeting}=await import(pathToFileURL(join(ownRoot,'src/greeting.mjs')));
// Prepare identity and the official greeting input before Core caches routes
// or starts first greeting generation. No message is sent from this launcher.
try{
  prepareFirstBinding(instance,instancePath);
  console.error('[whalenest-greeting] '+syncGreeting(instance).state);
}catch(error){
  // The official host must run to receive activation; our SDK remains gated
  // until preparation verifies the new instance's identity.
  if(error.code!=='FIRST_BINDING_PENDING')throw error;
  syncGreeting(instance,undefined,{hold:true});
  console.error('[whalenest-init] '+error.code);
}
if(candidate){
  process.env.WHALENEST_SOURCE_INSTANCE=join(instance.dataDir,'instance.json');
  process.env.NODE_OPTIONS=sourceNodeOptions(process.env.NODE_OPTIONS,fileURLToPath(new URL('../scripts/source-preload.mjs',import.meta.url)));
  process.env.BUN_OPTIONS=sourceBunOptions(process.env.BUN_OPTIONS,fileURLToPath(new URL('../scripts/source-preload.mjs',import.meta.url)));
}else delete process.env.WHALENEST_SOURCE_INSTANCE;
await prepareConnectorStartup(instance,{migrateProfile:true});
// Official Exposure alone owns the relay and its companion. An old combined
// deployment rolls back its matching launcher together with its Core.
process.env.CLAWCHAT_PRESERVE_PUBLICATIONS_ON_SHUTDOWN='1';
delete process.env.CLAWCHAT_CONNECT_AGENT_LIVEWARE_RELAY;
delete process.env.CLAWCHAT_CONNECT_LIVEWARE_PATH;
// The public signed host owns official release selection and lifecycle.
  const child=spawn('/usr/local/bin/clawchat-dsh',['serve'],{cwd:instance.cwd,stdio:'inherit',env:process.env});
  const handlers=new Map(['SIGINT','SIGTERM'].map(signal=>[signal,()=>child.kill(signal)]));
  for(const [signal,handler] of handlers)process.on(signal,handler);
  try{process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(code??(signal==='SIGTERM'?0:1)));});}
  finally{for(const [signal,handler] of handlers)process.off(signal,handler);}
