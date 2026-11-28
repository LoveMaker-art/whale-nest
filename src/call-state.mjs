import {join} from 'node:path';
import {readState} from './state.mjs';
export const callStateFile=options=>join(options.dataDir,'realtime/call-state.json');
export function activeCall(options){
 if(options.realtime?.sessionEnabled===false)return false;
 const r=readState(callStateFile(options),null),route=options.clawchat?.route;
 if(!r?.active||r.owner!==route?.sender||r.chat!==route?.conversation||!Number.isSafeInteger(r.pid))return false;
 try{process.kill(r.pid,0);return true;}catch{return false;}
}
