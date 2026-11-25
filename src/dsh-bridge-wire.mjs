import {close,createReadStream,write} from 'node:fs';
import {createInterface} from 'node:readline';
import {bridgeError,optionalObject} from './dsh-bridge-contract.mjs';

const concurrentMethods=new Set(['interactionResponse','cancel','cancelCompanionExpression','cancelCompanionVoiceSpeech']);
const maxPendingRequests=128;

/** One FD connection owns framing, backpressure, request ordering and teardown.
 * Cancellation and interaction answers bypass the queue they must unblock.
 */
export function createDshBridgeWire({maxFrameBytes,encodeBridgeFrame,inputFd=Number(process.env.CONNECT_DSH_BRIDGE_FD_IN??'4'),
 outputFd=Number(process.env.CONNECT_DSH_BRIDGE_FD_OUT??'3')}){
 const input=createReadStream(null,{fd:inputFd,autoClose:true});
 const lines=createInterface({input,crlfDelay:Infinity});
 let writes=Promise.resolve(),requests=Promise.resolve(),pending=0,reading=true,closed=false;
 const log=message=>{try{process.stderr.write('[whalenest-dsh-bridge] '+message+'\n');}catch{}};
 const terminate=reason=>{log('terminating: '+reason);process.kill(process.pid,'SIGTERM');};
 function writeAll(buffer){
  return new Promise((resolve,reject)=>{
   let offset=0;
   const step=()=>write(outputFd,buffer,offset,buffer.length-offset,null,(error,written)=>{
    if(error){if(error.code==='EAGAIN')setTimeout(step,2);else reject(error);return;}
    offset+=written;if(offset<buffer.length)step();else resolve();
   });
   step();
  });
 }
 function send(frame){
  let result;
  try{result=encodeBridgeFrame(frame,maxFrameBytes);}
  catch(error){return Promise.reject(error);}
  if(result.degraded)log(`${frame.type} frame degraded from ${result.degraded.originalBytes} to ${result.degraded.bytes} bytes`+
   (result.degraded.placeholder?' (placeholder)':` (${result.degraded.fields} truncated fields)`));
  writes=writes.then(()=>writeAll(Buffer.from(result.encoded)));
  return writes;
 }
 function enqueue(run){
  const result=requests.then(run);
  requests=result.catch(()=>{});
  return result;
 }
 function stopReading(){
  if(!reading)return;reading=false;lines.close();input.destroy();
 }
 function start(methods,afterRequest){
  lines.on('line',line=>{
   if(!reading)return;
   if(Buffer.byteLength(line)>maxFrameBytes){terminate(`incoming frame exceeds the ${maxFrameBytes}-byte limit`);return;}
   if(pending>=maxPendingRequests){terminate(`more than ${maxPendingRequests} pending Bridge requests`);return;}
   let request;
   try{request=JSON.parse(line);}catch{terminate('incoming frame is not valid JSON');return;}
   pending++;
   const run=async()=>{
    try{
     if(!optionalObject(request))throw bridgeError('malformed-request','Bridge request must be an object');
     if(request.type!=='request'||typeof request.id!=='string'||typeof request.method!=='string')
      throw bridgeError('malformed-request','Bridge request envelope is malformed');
     if(!Object.hasOwn(methods,request.method))throw bridgeError('method-not-found','Unsupported Bridge method: '+request.method);
     const params=optionalObject(request.params)??{};
     const result=await methods[request.method](params);
     await afterRequest(request.method,params);
     await send({type:'response',id:request.id,ok:true,result});
     if(request.method==='shutdown'){
      stopReading();await writes;setImmediate(()=>process.kill(process.pid,'SIGTERM'));
     }
    }catch(error){
     const id=optionalObject(request)&&typeof request.id==='string'?request.id:'';
     if(!id){terminate('incoming request has no id');return;}
     await send({type:'response',id,ok:false,error:{code:typeof error?.code==='string'?error.code:'internal-error',
      message:error instanceof Error?error.message:String(error)}});
    }
   };
   const execute=()=>run().catch(error=>terminate('response write failed: '+(error?.message??error))).finally(()=>{pending--;});
   if(concurrentMethods.has(request?.method))void execute();else void enqueue(execute);
  });
 }
 return {send,start,enqueue,stopReading,terminate,
  async dispose(){
   if(closed)return;closed=true;stopReading();
   await requests.catch(()=>{});await writes.catch(()=>{});
   await new Promise(resolve=>close(outputFd,()=>resolve()));
  },
 };
}
