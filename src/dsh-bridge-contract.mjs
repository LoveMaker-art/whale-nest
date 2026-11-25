// Whale's DSH process protocol. It retains wire compatibility with protocol 2
// while keeping validation and native persistence access in our own modules.
export const bridgeProtocol={name:'clawchat-connect-dsh-bridge',major:2};
export const bridgeError=(code,message)=>Object.assign(new Error(message),{code});
export const optionalObject=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:undefined;
export const optionalString=value=>typeof value==='string'&&value.trim()!==''?value:undefined;

export function requestString(value,key,allowEmpty=false){
 const result=value?.[key];
 if(typeof result!=='string'||(!allowEmpty&&!result.trim()))
  throw bridgeError('malformed-request',`${key} must be a ${allowEmpty?'string':'non-empty string'}`);
 return result;
}
export function requiredString(value,label){
 if(!optionalString(value))throw Error(label+' is required');
 return value;
}
export function requiredPositiveInteger(value,label){
 if(!Number.isSafeInteger(value)||value<=0)throw Error(label+' is required');
 return value;
}
export function requestImages(params){
 if(params.images===undefined)return [];
 if(!Array.isArray(params.images))throw bridgeError('malformed-request','images must be an array');
 return params.images.map(value=>{
  const image=optionalObject(value);
  if(!image)throw bridgeError('malformed-request','each image must be an object');
  const name=optionalString(image.name);
  return {path:requestString(image,'path'),mediaType:requestString(image,'mediaType'),...(name?{name}:{})};
 });
}
export function nativeSessionEvents(session){
 if(typeof session.eventAt!=='function')return [...session.events];
 const events=[];
 for(let seq=0;seq<=session.seq;seq++){const event=session.eventAt(seq);if(event!==undefined)events.push(event);}
 return events;
}
export async function inspectNativeSession(persistence,sessionId){
 if(typeof persistence.inspect==='function')return await persistence.inspect(sessionId);
 const handle=await persistence.open(sessionId,'read');
 try {const {events}=await handle.read(0);return {meta:handle.header,events};}
 finally {await handle.close();}
}
