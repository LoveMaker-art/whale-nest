import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync,statSync,readdirSync,existsSync} from 'node:fs';
import {join,basename,relative,isAbsolute} from 'node:path';
import {hash,ownerScope,senderKey,routeKey} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {nativeOperationId} from './native-tool.mjs';
import {stickerTurn} from './sticker-material.mjs';
import {createImageClient} from './image-client.mjs';
import {createMediaSender} from './media-delivery.mjs';
import originalModule from './aurabot-image-module.generated.mjs';
import {savePainting} from './aurabot-painting-save.generated.mjs';
import {listPaintings,paintingPath} from '../vendor/aurabot/src/features/paintings.js';
import {defineTool,str} from '../vendor/aurabot/src/tools/tools.js';
import {createHash} from 'node:crypto';

const digest=b=>createHash('sha256').update(b).digest('hex');
export function createImageAdapter(ctx,options,{getConfig,getNative,getRoute,client=createImageClient(options),senderFor=(route,id)=>createMediaSender(options,route,{sessionId:id})}){
 const directory=join(options.dataDir,'media/image-operations'),scope=ownerScope(options),flights=new Map();
 const recordFile=id=>{assert.match(id,/^whalenest-image-[a-f0-9]{64}$/);return join(directory,id+'.json');};
 function actor(where,exec,routeOverride){
  nativeOperationId(exec);const sessionId=String(where.sessionId??exec.agent.id),route=routeOverride??getRoute(sessionId,where.chat);
  assert.ok(route,'当前图像会话未绑定');const turn=stickerTurn(exec,options,route,sessionId),source=turn.message.source;
  assert.ok(!source.taskId&&source.kind!=='schedule','后台任务禁止图像生成或作品操作');
  assert.ok(options.owners.some(o=>senderKey(o)===senderKey({...route,sender:route.channel==='qq'?getConfig().ownerQQ:route.sender})),'仅已关联主人可使用图像能力');
  if(route.channel==='clawchat')assert.ok(route.kind==='private'&&source.kind==='user','仅主人当前手动私聊可使用图像能力');
  else assert.ok(source.kind==='aurabot'&&(getNative().hub.turnSendersAllOwner(sessionId)||where.chat?.kind==='group'&&getNative().hub.turnDirectFromOwner?.(sessionId)),'需要主人当前明确请求，保留原QQ主人权限');
  return {route,sessionId,turn,signal:exec.signal};
 }
 function authorizeDrawing(call,args){
  const text=call.turn.text.replace(/```[\s\S]*?```/g,'').replace(/\{[^\n]*\}/g,'');
  assert.ok(/画|绘|生[成图]|做.{0,12}(图|壁纸|头像)|改.{0,12}(图|图片|颜色|背景)|修改|重绘/.test(text)&&!/(不要|不用|别|禁止).{0,8}(画|绘|生图|生成|改图)/.test(text),'仅在主人明确要求生图或修改图片时使用');
  assert.ok(typeof args.prompt==='string'&&args.prompt.trim()&&args.prompt.length<=8000,'需要实际画面描述');
 }
 function checkedPainting(file){const path=paintingPath(file);assert.ok(path&&!lstatSync(path).isSymbolicLink()&&lstatSync(path).isFile(),'作品不存在或不是普通文件');return path;}
 const drawingId=call=>'whalenest-image-'+hash([options.instanceId,routeKey(call.route),call.sessionId,String(call.turn.message.id??call.turn.message.source.connectInputId)]);
 async function reference(call,mode){
  if(call.route.channel==='qq')return getNative().hub.referenceImage(call.chat,mode);
  const session=call.exec.agent.session;
  for(let n=session.seq;n>=0;n--){const e=session.eventAt(n);if(e?.type!=='user/message')continue;const m=e.data.message??e.data,id=m.source?.connectInputId;
   if(!id||m.source.kind!=='user')continue;
   if(mode==='quote'&&id!==call.turn.message.source.connectInputId)break;
   const root=join(options.dataDir,'media/incoming',hash([call.route.account,call.route.conversation,call.sessionId,id])),file=join(root,'input.json'),r=readState(file,null);
   if(r?.state!=='completed')continue;const pictures=r.files.filter(x=>x.kind==='image');if(!pictures.length)continue;
   assert.ok(Date.now()-statSync(file).mtimeMs<=30*60*1000,'临时参考图已过期，请重新提供图片');assert.equal(pictures.length,1,'有多张参考图，请单独发送或引用要修改的一张');
   const picture=pictures[0];assert.ok(!lstatSync(picture.path).isSymbolicLink(),'参考图不能为符号链接');const path=realpathSync(picture.path),rel=relative(realpathSync(root),path);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'参考图不属于当前会话');
   const bytes=readFileSync(path);assert.ok(bytes.length<=10*1024*1024,'参考图超过10MiB');assert.equal(digest(bytes),picture.sha256,'参考图发生变化');return bytes;
  }
  throw Error('当前会话没有可用参考图，请发送或明确引用一张图片；不能读取另一平台未授权的私聊图');
 }
 function saved(call,path,bytes){
  assert.ok(path,'图像已生成但作品保存失败，请恢复原请求，不重新生成');call.record.file=basename(path);call.record.sha256=digest(bytes);call.record.state='saved';writeState(recordFile(call.id),call.record);
 }
 async function deliver(route,sessionId,file,id,signal){
  const path=checkedPainting(file);
  if(route.channel==='clawchat')return senderFor(route,sessionId).send({filePath:path,requestId:id},{signal});
  const journal=join(options.dataDir,'media/image-deliveries',hash([id,routeKey(route)])+'.json'),old=readState(journal,null);if(old)return old;
  writeState(journal,{state:'uncertain',requestId:id,file});
  try{
   const r=await getNative().hub.sendSegments(route.kind+':'+route.conversation,[{type:'image',data:{file:'base64://'+readFileSync(path).toString('base64')}}],'[作品] '+file,{throwOnError:true,retries:0});
   assert.ok(r?.message_id||r?.messageId,'QQ网关未返回实际图片回执');const result={state:'confirmed',requestId:id,messageId:String(r.message_id??r.messageId),file};writeState(journal,result);return result;
  }catch{return {state:'uncertain',requestId:id,file,message:'QQ作品发送未确认，保留已有作品，不自动重发'};}
 }
 const ports={enabled:options.image?.enabled===true,generate:(...args)=>client.generate(...args),
  note:(call,fn)=>call.turn.text.includes('运维自测')?undefined:fn(),
  paintingScope:call=>call.route.channel==='qq'?call.chat.chatId:'clawchat:'+call.sessionId,
  referenceHub:call=>({referenceImage:(_chat,mode)=>reference(call,mode)}),saved,
  send:async(call,_bytes,path)=>{const result=await deliver(call.route,call.sessionId,basename(path),call.id,call.signal);call.record.delivery=result;writeState(recordFile(call.id),call.record);return result;},
  async execute(args,where,exec,run){
   const call={...actor(where,exec),chat:where.chat,exec};authorizeDrawing(call,args);
   const id=drawingId(call),file=recordFile(id),fingerprint=hash([args.prompt,args.shape??null,args.image??null]);
   const old=readState(file,null);if(old){assert.equal(old.scope,scope,'作品请求归属冲突');assert.equal(old.fingerprint,fingerprint,'同一主人回合只生成一张，请发新请求后再修改描述');return old.result??{ok:false,generated:!!old.file,saved:!!old.file,state:old.state,file:old.file,operationId:id,message:'原请求已存在，请查询或恢复已有结果，禁止另起付费请求重试'};}
   if(flights.has(id))return flights.get(id);
   call.id=id;call.record={scope,requestId:id,parameters:args,fingerprint,state:'running',route:call.route,sessionId:call.sessionId,createdAt:new Date().toISOString()};writeState(file,call.record);
   const promise=(async()=>{try{const result=await run(call);call.record.result=result;call.record.state=result.state==='confirmed'?'confirmed':call.record.file?'saved':'held';writeState(file,call.record);return result;}
    catch(error){call.record.state=call.record.file?'saved':'held';call.record.error=error.message;writeState(file,call.record);return {ok:false,generated:!!call.record.file,saved:!!call.record.file,file:call.record.file,operationId:id,state:call.record.state,message:error.message};}})();
   flights.set(id,promise);try{return await promise;}finally{flights.delete(id);}
  },
 };
 const status=()=>({enabled:ports.enabled,model:options.image?.model??null,n:1,size:options.image?.size??'1024x1024',background:false,archive:'original-paintings',billing:'foreground platform image use; CSP price not provided'});
 function managementTool(route,sessionId){return defineTool({name:'companion_paintings',description:'主人共同作品档案：list列作品；read按file查看元数据；send把已保存作品发到当前会话，不调用图像模型；status按operationId查原生成/投递状态；recover只恢复已返回结果的下载及存盘，不重新生成、不自动改发另一平台。失败或未知不能换新绘图请求重试。file只用作品文件名，不能传路径或URL。',
  properties:{action:str('list/read/send/status/recover'),file:str('作品库文件名'),operationId:str('此前绘图返回的operationId')},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],
  async execute(args,exec){const call=actor({sessionId},exec,route),action=args.action??'list';
   if(action==='list'){const listed=listPaintings({limit:20});return {ok:true,...listed,items:listed.items.map(i=>({...i,prompt:i.prompt.replace(/--wn-[a-f0-9]{16}$/,'')})),...status()};}
   if(action==='status'||action==='recover'){
    const r=readState(recordFile(args.operationId),null);assert.equal(r?.scope,scope,'没有这项作品请求');
    if(action==='recover'&&!r.file){const bytes=await client.recover(r.requestId,{signal:exec.signal}),path=savePainting(bytes,r.parameters.prompt,{requestId:r.requestId});saved({id:r.requestId,record:r},path,bytes);}
    return {ok:true,operationId:r.requestId,state:r.state,file:r.file??null,delivery:r.delivery??null,message:r.file?'作品已保存，可显式发送已有作品':'请求结果尚未确认，不重新付费生成'};
   }
   const path=checkedPainting(args.file);if(action==='read')return {ok:true,file:basename(path),bytes:statSync(path).size};
   assert.equal(action,'send','未知作品操作');
   const current=readState(recordFile(drawingId(call)),null);
   if(current?.scope===scope&&current.file===args.file&&current.delivery?.state==='confirmed')return {...current.delivery,operationId:current.requestId,alreadyDelivered:true,message:'本回合作品已确认发送，沿用实际回执，未重复投递'};
   for(const name of existsSync(directory)?readdirSync(directory).filter(n=>n.endsWith('.json')):[]){const r=readState(join(directory,name));
    if(r.file===args.file&&routeKey(r.route)===routeKey(route)&&r.delivery?.state==='uncertain'){
     if(route.channel==='clawchat'){const sender=senderFor(route,r.sessionId);if(sender.check){r.delivery=await sender.check(r.delivery.requestId,{signal:exec.signal});writeState(join(directory,name),r);}}
     return {...r.delivery,operationId:r.requestId,message:'沿用原作品发送记录，不新建请求重发'};
    }
   }
   const turn=stickerTurn(exec,options,route,String(sessionId));return deliver(route,String(sessionId),args.file,'whalenest-painting-send-'+hash([options.instanceId,routeKey(route),String(sessionId),String(turn.message.id??turn.message.source.connectInputId),args.file]),exec.signal);
  }});}
 function module(){return {...originalModule,setup(api){return originalModule.setup({...api,imagePorts:ports,tool(factory){return api.tool(where=>{
   const result=factory(where);return (Array.isArray(result)?result:[result]).filter(Boolean).map(t=>({...t,description:'主人明确要求画图或改图时使用平台图像模型，一次一张，产生实际图像用量。image只用当前会话last/quote或已保存作品文件名。先保存作品，再发回当前会话；状态未知不重新生成，用companion_paintings查询或恢复已有结果。保留原shape构图选择。',output:{...t.output,render(args,value){return [{type:'text',text:JSON.stringify({ok:value.ok,generated:value.generated,saved:value.saved,state:value.state,file:value.file,operationId:value.operationId,messageId:value.messageId,note:'state=confirmed表示平台已确认发送；能否把图片交给模型看是另一件事，不能据此补发'})},...t.output.render(args,value)];}}}));
  });}});}};}
 return {ports,module,managementTool,status,adaptTool:t=>({...t,name:'draw_image'}),client};
}
