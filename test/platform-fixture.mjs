import {writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {readState,writeState} from '../src/state.mjs';

/** A public CLI fixture. Tests set identity/readiness instead of emulating the
 * connector's database or installation ledger. Unexpected old commands fail. */
export async function preparePlatformFixture({root,options},state={}){
 const route=options.clawchat.route;
 const delivery=options.clawchat.delivery??={};
 delivery.connectBin??=join(root,'fake-clawchat');delivery.configPath??=join(root,'fake-config.json');
 const stateFile=join(root,'platform-state.json');
 writeState(stateFile,{userId:'fixture-agent',ownerId:route.sender,conversationId:route.conversation,connected:true,available:true,running:0,queued:0,...state});
 if(!existsSync(delivery.configPath))writeState(delivery.configPath,{defaultAgent:route.account,agents:{[route.account]:{}}});
 const script='#!'+process.execPath+'\n'+`
const fs=require('node:fs'),a=process.argv.slice(2);
if(a[0]==='__clawnest-state'){console.log(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));process.exit(0);}
if(a[0]==='config'&&a[1]==='get'){const config=JSON.parse(fs.readFileSync(a[a.indexOf('--config')+1],'utf8'));console.log(JSON.stringify({outputVisibility:'normal',...config}));process.exit(0);}
if(a[0]!=='tool'||a[1]!=='call')throw Error('Unexpected public fixture command: '+a[0]);
const input=JSON.parse(a[a.indexOf('--input-json')+1]),id=a[a.indexOf('--request-id')+1],path=input.path;
fs.appendFileSync(${JSON.stringify(join(root,'delivered.jsonl'))},JSON.stringify({tool:a[2],id,input,...(path?{artifact:fs.readFileSync(path).toString('base64')}:{})})+'\\n');
console.log(JSON.stringify({status:'succeeded',result:{sent:true,messageId:'fixture-ack-'+id}}));
`;
 await writeFile(delivery.connectBin,script,{mode:0o700});
 return {platformStateFile:stateFile,setPlatformState:patch=>writeState(stateFile,{...readState(stateFile),...patch}),readPlatformState:()=>readState(stateFile)};
}
