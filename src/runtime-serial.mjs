import {AsyncLocalStorage} from 'node:async_hooks';
/** The SDK remains a single writer; independent call and chat work share this local gate. */
export function runtimeSerial(){
 const context=new AsyncLocalStorage();let tail=Promise.resolve();
 return {async acquire(signal){
  signal?.throwIfAborted();const held=context.getStore();if(held)return {run:fn=>fn(),release(){}};
  let release;const before=tail;tail=new Promise(resolve=>{release=resolve;});let ready=false,abort;
  try{
   await Promise.race([before,...(signal?[new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});})]:[])]);
   ready=true;signal?.throwIfAborted();const owner={};let released=false;
   return {run:fn=>context.run(owner,fn),release(){if(!released){released=true;release();}}};
  }catch(error){if(ready)release();else void before.then(release);throw error;}
  finally{if(abort)signal.removeEventListener('abort',abort);}
 }};
}
