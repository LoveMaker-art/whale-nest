import {appendFileSync,closeSync,readFileSync,write} from 'node:fs';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

// A process-level protocol fixture. It never loads DSH or calls a provider.
const log=event=>appendFileSync(process.env.WHALENEST_TEST_BRIDGE_LOG,JSON.stringify(event)+'\n');
const overlay=process.argv[process.argv.lastIndexOf('--patch')+1];
const entries=JSON.parse(readFileSync(overlay,'utf8'));
const config=entries.find(entry=>entry.insert)?.insert[0].config;
const mode=process.env.WHALENEST_TEST_BRIDGE_MODE??'normal';
const maxFrameBytes=Number(process.env.WHALENEST_TEST_BRIDGE_LIMIT??16*1024*1024);
const inputFd=Number(process.env.CONNECT_DSH_BRIDGE_FD_IN),outputFd=Number(process.env.CONNECT_DSH_BRIDGE_FD_OUT);
log({kind:'start',pid:process.pid,overlay,home:process.env.DSH_HOME,inputFd,outputFd});
const capabilityKeys=['promptQueue','promptSteer','cancel','durableReceipt','history','approvals','questions','models',
 'presets','permissionPresets','skills','commands','imageInput','localProducedFilePresentation','portableArtifactOutput',
 'archive','restore','delete','crossProcessSessionOwnership'];
const hello={type:'hello',protocol:{name:'clawchat-connect-dsh-bridge',major:mode==='bad-major'?3:2,build:'运维自测鲸鱼',maxFrameBytes},
 home:mode==='bad-home'?'/another-instance':config.home,profile:config.profile,capabilities:Object.fromEntries(capabilityKeys.map(key=>[key,true]))};
let output=Promise.resolve();
function bytes(buffer){
 output=output.then(()=>new Promise((resolve,reject)=>{
  let offset=0;
  const step=()=>write(outputFd,buffer,offset,buffer.length-offset,null,(error,count)=>{
   if(error){if(error.code==='EAGAIN')setTimeout(step,2);else reject(error);return;}
   offset+=count;if(offset<buffer.length)step();else resolve();
  });step();
 }));return output;
}
const send=frame=>bytes(Buffer.from(JSON.stringify(frame)+'\n'));
async function fragmented(buffer){
 const start=buffer.indexOf(Buffer.from('鲸'))+1;
 await bytes(buffer.subarray(0,start));
 await new Promise(resolve=>setTimeout(resolve,5));
 await bytes(buffer.subarray(start));
}
if(mode==='silent'){setInterval(()=>{},1000);}
else if(mode==='early-exit'){process.stderr.write('fixture-only-private-token\n');process.exit(29);}
else{
 if(mode==='stubborn'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
 await fragmented(Buffer.from(JSON.stringify(hello)+'\n'));
 if(mode==='closed-input'){
  closeSync(inputFd);setInterval(()=>{},1000);
 }else{
  const lines=createInterface({input:createReadStream(null,{fd:inputFd}),crlfDelay:Infinity});
  lines.on('line',line=>{
   const request=JSON.parse(line);log({kind:'request',...request});
   void(async()=>{
    const reply=result=>send({type:'response',id:request.id,ok:true,result});
    if(request.method==='hang')return;
    if(request.method==='delayed'){await new Promise(resolve=>setTimeout(resolve,80));return await reply({late:true});}
    if(request.method==='shutdown'){
     if(mode==='stubborn')return;
     await reply({disposed:true});process.exit(0);
    }
    if(request.method==='exit'){process.stderr.write('fixture-only-private-token\n');process.exit(23);}
    if(request.method==='error')return await send({type:'response',id:request.id,ok:false,error:{code:'session-not-found',message:'fixture session missing'}});
    if(request.method==='malformed')return await send({type:'event',sessionId:'fixture',event:{seq:'bad',time:0,type:'user/message',data:{}}});
    if(request.method==='duplicate-hello')return await send(hello);
    if(request.method==='large-frame')return await bytes(Buffer.from('x'.repeat(16*1024*1024+1)+'\n'));
    if(request.method==='fragment'){
     const frames=[{type:'event',sessionId:'fixture',event:{seq:1,time:1,type:'assistant/message',data:{text:'鲸鱼回复'}}},
      {type:'interaction',id:'question-1',sessionId:'fixture',request:{kind:'user-input',title:'fixture question'}},
      {type:'response',id:request.id,ok:true,result:{text:'鲸鱼回复'}}];
     return await fragmented(Buffer.from(frames.map(frame=>JSON.stringify(frame)+'\n').join('')));
    }
    await reply({method:request.method,params:request.params});
   })().catch(()=>process.exit(31));
  });
 }
}
