import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const required={clawchat_send_file:['chat_id','path'],clawchat_send_image:['chat_id','path'],
 clawchat_send_voice:['chat_id','path'],clawchat_send_message:['chatId','chatType','text']};

/** Read-only deployment preflight. Validate actual public interfaces rather
 * than pinning a connector/DSH version or relying on release descriptions. */
export async function inspectOfficialDeliveryCapabilities(options,{run=exec}={}){
 const {connectBin,configPath}=options.clawchat.delivery,tools={},missing=[];
 for(const [name,fields]of Object.entries(required)){
  try{
   const value=JSON.parse((await run(connectBin,['tool','describe',name,'--config',configPath],
    {cwd:options.cwd,timeout:8000,maxBuffer:1024*1024})).stdout);
   const valid=value.name===name&&fields.every(field=>Object.hasOwn(value.inputSchema?.properties??{},field));
   tools[name]=valid;if(!valid)missing.push(name);
  }catch{tools[name]=false;missing.push(name);}
 }
 let conversion=false;
 try{await run(options.media?.ffmpeg??'ffmpeg',['-version'],{cwd:options.cwd,timeout:5000,maxBuffer:65536});conversion=true;}catch{}
 return {ok:missing.length===0&&conversion,tools,missing,conversion,
  message:missing.length?'当前连接器缺少所需官方发送接口，未停止服务或切换源码':!conversion?'音频转换程序不可用，未停止服务或切换源码':'官方发送接口与音频转换预检通过'};
}
