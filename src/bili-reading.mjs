import {createBili} from './aurabot-bili.generated.mjs';

/** Standalone/test adapter for the same reader. The SDK injects its one module. */
export async function readBiliOriginal(api,link,{signal}={}){
 const methods=new Proxy(api,{get(target,key){
  const value=target[key];if(typeof value!=='function')return value;
  return async(...args)=>{signal?.throwIfAborted();const result=await value.apply(target,args);signal?.throwIfAborted();return result;};
 }});
 const reader=createBili({api:methods,getConfig:()=>({ownerQQ:'1',bili:{enabled:true,vision:false,shotLibrary:100}}),
  memory:null,hub:{},log:{debug(){},warn(){},info(){}},dsh:{}});
 try{return await reader.watch(link,{details:true});}finally{reader.dispose();}
}
