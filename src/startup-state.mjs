import {join} from 'node:path';
import {readState,writeState} from './state.mjs';
import {requireCurrentInstanceBinding} from './instance-binding.mjs';

const same=(a,b)=>a&&b&&['account','agent','owner','conversation'].every(k=>a[k]===b[k]);
const live=pid=>{try{if(!Number.isSafeInteger(pid)||pid<=0)return false;process.kill(pid,0);return true;}catch{return false;}};
export const startupFile=(options,name)=>join(options.dataDir,name+'.json');
export function beginStartup(options){
  writeState(startupFile(options,'binding-core'),{schema:1,instanceId:options.instanceId,
    coreEpoch:process.env.WHALENEST_CORE_EPOCH,platformInstanceId:process.env.CLAWNEST_INSTANCE_ID,state:'starting'});
}
export function observeCoreBinding(options){
  requireCurrentInstanceBinding(options);
  const binding=readState(startupFile(options,'first-binding'),null);
  if(!binding?.identity)return;
  writeState(startupFile(options,'binding-core'),{schema:1,instanceId:options.instanceId,
    platformInstanceId:process.env.CLAWNEST_INSTANCE_ID,coreEpoch:process.env.WHALENEST_CORE_EPOCH,
    pid:process.pid,identity:binding.identity,state:'prepared'});
}
/** Readiness is derived from the current Core/SDK observations and the existing
 * resource records. A failed optional first pass permits later work, not success. */
export function startupStatus(options,{alive=live}={}){
  const binding=readState(startupFile(options,'first-binding'),null);
  if(options.clawchat?.firstBinding!==true||!binding?.platformInstanceId)
    return {coordinated:false,baseReady:true,avatarReady:true,appsAllowed:true,qqAllowed:true,backgroundAllowed:true};
  let verified=true;
  try{requireCurrentInstanceBinding(options);}catch{verified=false;}
  const core=readState(startupFile(options,'binding-core'),null),sdk=readState(startupFile(options,'binding-runtime'),null);
  const epoch=core?.coreEpoch;
  const baseReady=!!(verified&&epoch&&core.instanceId===options.instanceId&&core.state==='prepared'
    &&core.platformInstanceId===binding.platformInstanceId&&same(core.identity,binding.identity)
    &&sdk?.coreEpoch===epoch&&same(sdk.identity,binding.identity)&&alive(core.pid)&&alive(sdk.pid));
  const avatarReady=baseReady&&['confirmed','preserved'].includes(binding.avatar?.state);
  const avatarSettled=baseReady&&['confirmed','preserved','failed','unconfigured','unverified'].includes(binding.avatar?.state);
  const call=readState(startupFile(options,'managed-liveware'),null),song=readState(startupFile(options,'song-liveware'),null);
  const passed=record=>record?.startupPass?.coreEpoch===epoch&&record.startupPass.state==='deferred';
  const callSettled=options.realtime?.enabled!==true||!!(call?.legacy?.url&&call?.publication?.url)||passed(call);
  const songSettled=options.singing?.playback?.enabled!==true||!!song?.url||passed(song);
  const appsAllowed=baseReady&&avatarSettled;
  const qqAllowed=appsAllowed&&callSettled&&songSettled;
  const qqStatus=options.qq?.gateway?.loginQrFile
    ?readState(join(options.qq.gateway.loginQrFile,'../../managed-status.json'),null):null;
  const qqSettled=!options.qq?.gateway?.loginQrFile||qqStatus?.ready===true&&qqStatus.platformInstanceId===binding.platformInstanceId
      &&same(qqStatus.identity,binding.identity)&&Date.now()-qqStatus.at>=0&&Date.now()-qqStatus.at<20000
    ||qqStatus?.reason==='resource-stop'||qqStatus?.reason==='startup-deferred'&&qqStatus.coreEpoch===epoch;
  return {coordinated:true,identity:binding.identity,platformInstanceId:binding.platformInstanceId,coreEpoch:epoch,baseReady,avatarReady,avatarSettled,appsAllowed,
    callSettled,songSettled,qqAllowed,backgroundAllowed:qqAllowed&&qqSettled};
}
export function deferStartupComponent(options,name){
  const status=startupStatus(options);
  if(!status.appsAllowed)return;
  const file=startupFile(options,name),record=readState(file,null);
  if(record)writeState(file,{...record,startupPass:{coreEpoch:status.coreEpoch,state:'deferred'}});
}
