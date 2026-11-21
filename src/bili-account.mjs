import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readState,writeState} from './state.mjs';
import {hash,routeKey,senderKey} from './routing.mjs';
import {qrPng} from './qr-png.mjs';
import {UA} from '../vendor/aurabot/src/bili/api.js';
import {createBiliHttp} from './bili-http.mjs';
import {loadBiliOwnerState} from './bili-state.mjs';

/** One private credential vault; callers see status, never cookies or QR keys. */
export function createBiliAccount(options,route,{fetchImpl=fetch,now=Date.now,mutationPolicy}={}){
 const dir=join(resolve(options.dataDir),'bili');mkdirSync(dir,{recursive:true,mode:0o700});
 const file=join(dir,'account.json'),store=loadBiliOwnerState(options,route,file,{generation:0,deviceId:randomUUID(),cookie:'',challenges:{},mutations:{}});
 const {scope,save,scopedId}=store,vault=store.state,flights=new Map();save();
 mutationPolicy?.importReceipts(Object.values(vault.mutations));
 const status=()=>({state:vault.cookie?'credentials-saved':'logged-out',verifiedAt:vault.verifiedAt??null,uid:vault.uid??null,name:vault.name??null});
 const safeMutation=r=>({ok:r.state==='confirmed',state:r.state,operationId:r.id,...(r.receipt?{receipt:r.receipt}:{}),message:r.state==='confirmed'?'平台接口已确认此账号操作；不代表接收方已读。':r.state==='failed'?'平台拒绝此操作，未自动重试。':'结果不确定，已保留记录，不要换请求重试。'});
 async function passport(path,params){const url=new URL('https://passport.bilibili.com/x/passport-login/web/qrcode/'+path);for(const [key,value] of Object.entries({...params,source:'main-fe-header'}))url.searchParams.set(key,value);
  const response=await fetchImpl(url,{headers:{'user-agent':UA,referer:'https://www.bilibili.com/'},redirect:'error',signal:AbortSignal.timeout(20000)});assert.ok(response.ok,'登录接口请求失败');const text=await response.text();assert.ok(text.length<65536,'登录响应过大');const body=JSON.parse(text);assert.equal(body.code,0,'登录接口拒绝请求');return {data:body.data,headers:response.headers};
 }
 async function start(requestId){assert.ok(typeof requestId==='string'&&requestId,'Stable login request required');const id=scopedId('whalenest-bili-login-',[requestId],id=>!!vault.challenges[id]),old=vault.challenges[id];
  if(old)return challengeView(old);const record={id,state:'uncertain',generation:vault.generation,createdAt:now(),expiresAt:now()+180000};vault.challenges[id]=record;save();
  try{const {data}=await passport('generate',{});assert.ok(typeof data.qrcode_key==='string'&&data.qrcode_key&&typeof data.url==='string','登录二维码信息不完整');const url=new URL(data.url);assert.ok(url.protocol==='https:'&&(url.hostname==='bilibili.com'||url.hostname.endsWith('.bilibili.com')),'二维码来源不受信任');
   const qrDir=join(resolve(options.dataDir),'media','outgoing','bili-login');mkdirSync(qrDir,{recursive:true,mode:0o700});const imagePath=join(qrDir,id+'.png');writeFileSync(imagePath,qrPng(url.href),{mode:0o600});
   Object.assign(record,{state:'waiting',key:data.qrcode_key,imagePath});save();return challengeView(record);
  }catch{save();return challengeView(record);}
 }
 function challengeView(record){let state=record.state;if(now()>=record.expiresAt&&['waiting','scanned'].includes(state))state='expired';return {ok:['waiting','scanned','confirmed'].includes(state),challengeId:record.id,key:record.id,state,...(['waiting','scanned'].includes(state)?{imagePath:record.imagePath,png:record.imagePath,expiresAt:record.expiresAt}:{}),message:state==='confirmed'?'账号已核验，凭据已私有保存。':state==='expired'?'二维码已过期，请明确重新发起登录。':state==='uncertain'?'登录请求结果不确定，未自动重试。':state==='unverified'?'扫码凭据尚未通过账号核验，未替换原账号；可手动再次轮询进行只读核验。':state==='cancelled'?'此登录请求已取消。':'仅在主人要求登录时发送这张本地二维码图片供扫码；轮询不会自动继续。'};}
 async function acceptCandidate(record){assert.equal(flights.size,0,'账号操作进行中，暂不能替换凭据');const generation=vault.generation;
  try{const info=await createBiliHttp({getCookie:()=>record.pendingCookie,fetchImpl,now}).nav();assert.equal(generation,vault.generation);assert.ok(info.isLogin&&/^\d+$/.test(info.mid));
   vault.devices??={};vault.deviceId=vault.devices[info.mid]??=randomUUID();vault.cookie=record.pendingCookie;vault.uid=info.mid;vault.name=info.name;vault.verifiedAt=now();vault.generation++;record.generation=vault.generation;record.state='confirmed';
   for(const other of Object.values(vault.challenges)){delete other.key;delete other.pendingCookie;if(other!==record)other.state='cancelled';}clearImages();
  }catch{record.state='unverified';}save();return challengeView(record);
 }
 async function poll(id){const record=vault.challenges[id];assert.ok(record&&record.generation===vault.generation,'未知或已取消的登录请求');if(record.state==='confirmed')return challengeView(record);
  if(record.pendingCookie)return acceptCandidate(record);if(now()>=record.expiresAt){record.state='expired';delete record.key;clearImage(record);save();return challengeView(record);}
  assert.ok(record.key&&['waiting','scanned'].includes(record.state),'登录请求不可轮询');if(record.lastPollAt!==undefined&&now()-record.lastPollAt<3000)return {...challengeView(record),retryAfterMs:3000-(now()-record.lastPollAt)};
  record.lastPollAt=now();save();const generation=vault.generation;const {data,headers}=await passport('poll',{qrcode_key:record.key});assert.equal(generation,vault.generation,'账号状态已改变，忽略旧轮询结果');
  if(data.code===0){const parts=(headers.getSetCookie?.()??[]).map(value=>value.split(';')[0]).filter(value=>/^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid|buvid3)=/.test(value));const cookie=parts.join('; ');
   if(!['SESSDATA','bili_jct','DedeUserID'].every(key=>new RegExp('(?:^|;\\s*)'+key+'=.+').test(cookie))){record.state='uncertain';save();return challengeView(record);}
   record.pendingCookie=cookie;delete record.key;record.state='unverified';save();return acceptCandidate(record);
  }else if(data.code===86101)record.state='waiting';else if(data.code===86090)record.state='scanned';else if(data.code===86038){record.state='expired';delete record.key;clearImage(record);}else record.state='uncertain';
  save();return challengeView(record);
 }
 function clearImage(record){if(record.imagePath){try{unlinkSync(record.imagePath);}catch(e){if(e.code!=='ENOENT')throw e;}delete record.imagePath;}}
 function clearImages(){for(const record of Object.values(vault.challenges))clearImage(record);}
 async function whoami(api){if(!vault.cookie)return {ok:true,...status(),message:'当前未登录 B 站，没有绑定账号。'};const generation=vault.generation;try{const info=await api.nav();assert.equal(generation,vault.generation,'账号已改变');if(!info.isLogin){delete vault.verifiedAt;delete vault.uid;delete vault.name;save();return {ok:false,...status(),state:'expired',message:'已保存凭据当前未通过登录核验，请重新登录。'};}
   assert.match(info.mid,/^\d+$/);vault.uid=info.mid;vault.name=info.name;vault.verifiedAt=now();save();return {ok:true,...status(),state:'logged-in',message:'B 站登录态已通过平台核验。'};
  }catch{return {ok:false,...status(),state:'unverified',message:'本次无法核验平台登录态；未据此判定登录成功。'};}}
 function logout(){assert.equal(flights.size,0,'账号操作进行中，暂不能清除凭据');vault.cookie='';vault.generation++;delete vault.uid;delete vault.name;delete vault.verifiedAt;clearImages();vault.challenges={};save();return {ok:true,...status(),message:'已清除本实例凭据和登录请求；这不代表平台已撤销其他设备登录。'};}
 async function mutate({requestId,kind,input},action){assert.ok(vault.cookie&&vault.uid,'需要先登录并通过 bili_whoami 核验');assert.ok(requestId&&kind,'Stable account operation required');
  const id=scopedId('whalenest-bili-op-',[requestId],id=>!!vault.mutations[id]),intent=hash({kind,input,uid:vault.uid}),fingerprint=hash({intent,generation:vault.generation}),old=vault.mutations[id];
  if(old){assert.equal(old.fingerprint,fingerprint,'账号操作标识与内容冲突');if(flights.has(id))await flights.get(id);return {...safeMutation(vault.mutations[id]),duplicate:true};}
  const held=Object.values(vault.mutations).find(r=>r.intent===intent&&r.state==='uncertain');if(held)return {...safeMutation(held),duplicate:true};
  const admission=mutationPolicy?.reserve(id,{kind,uid:vault.uid,input});if(admission&&!admission.ok)return admission;
  const record={id,kind,intent,fingerprint,state:'uncertain',uid:vault.uid,createdAt:now()};vault.mutations[id]=record;save();
  const work=(async()=>{try{const receipt=await action({uid:vault.uid,deviceId:vault.deviceId});assert.ok(receipt&&typeof receipt==='object'&&Object.keys(receipt).length,'缺少明确回执');record.receipt=receipt;record.state='confirmed';}catch(error){if(error.definitelyNotApplied)record.state='failed';record.code=Number.isInteger(error.code)?error.code:null;}record.updatedAt=now();save();mutationPolicy?.settle(id,record.state);return safeMutation(record);})();flights.set(id,work);try{return await work;}finally{flights.delete(id);}
 }
 function adoptCookie(cookie){assert.ok(!cookie||!vault.cookie||vault.cookie===cookie,'原B站配置与共同账号凭据不同，需要明确确认账号后迁移');if(cookie&&!vault.cookie&&!vault.nativeCookieImported){vault.cookie=cookie;vault.nativeCookieImported=true;save();}return !!vault.cookie;}
 return {adoptCookie,getCookie:()=>vault.cookie,getDeviceId:()=>vault.deviceId,generation:()=>vault.generation,deviceId:vault.deviceId,status,start,poll,whoami,logout,mutate,receipts:()=>Object.values(vault.mutations).slice(-20).map(safeMutation)};
}
