import assert from 'node:assert/strict';
import {join} from 'node:path';
import original from './aurabot-stickers-module.generated.mjs';
import {stickerPath,NEVER_RANDOM} from './aurabot-stickers.generated.mjs';
import {defineTool,str,int} from '../vendor/aurabot/src/tools/tools.js';
import {stickerMaterial,stickerTurn} from './sticker-material.mjs';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {hash,senderKey,routeKey} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {createMediaSender} from './media-delivery.mjs';
import {stickerScenes,stickerDirections} from './sticker-selection.mjs';

const tagGuide='标签优先使用一个场景（'+stickerScenes.join('、')+'）、具体话题和表达方向（'+stickerDirections.join('、')+'），合计最多5个。';

/** One owner-facing action path over the original store. Only material and
 * delivery differ by channel; no second library or matching algorithm. */
export function createStickers(options,{getConfig,getNative,store:providedStore,selection,senderFor=(route,id)=>createMediaSender(options,route,{sessionId:id})}){
 const flights=new Map(),directory=join(options.dataDir,'expressions/sticker-operations');
 const store=()=>providedStore??getNative().modules.use('stickers');
 function authorize(route,exec){
  assert.ok(route.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(route)),'表情管理仅限已关联主人私聊');requireManualOwnerTurn(exec);
 }
 function intent(action,exec,route,sessionId){
  const text=stickerTurn(exec,options,route,sessionId).text.replace(/```[\s\S]*?```/g,'').replace(/\{[^\n]*\}/g,'');
  if(action==='add'){
   assert.ok(!/(?:不要|不用|别|不需要|禁止)(?:再|自动)?(?:收录|收藏|收图|收为|存图|保存|添加|导入)/.test(text),'主人本轮未授权收录');
   assert.ok(/收录|收[为进下].{0,12}(?:表情|图库)|(?:存|保存|收藏|添加|导入).{0,30}(?:这|那|图|表情)|(?:这|那|图|表情).{0,30}(?:收为|收进|收下|存下|保存|收藏)|做成表情/.test(text),'需要主人明确要求把图片收为表情，普通图片和模型自行调用不构成授权');
  }
  if(action==='send')assert.ok(!/(?:别|不要|不用|禁止).{0,8}(?:发|配).{0,8}(?:图|表情)/.test(text),'本轮要求不发图片');
  if(action==='importQQ')assert.ok(/(?:导入|同步).{0,16}(?:QQ|qq|收藏)|(?:QQ|qq|收藏).{0,16}(?:导入|同步)/.test(text)&&!/(不要|别|禁止).{0,10}(导入|同步)/.test(text),'需要主人明确要求导入QQ收藏');
  if(action==='delete')assert.ok(/删除|删掉|移除|删去/.test(text)&&!/(不要|别|禁止).{0,6}(?:删除|删掉|移除)/.test(text),'需要主人明确要求删除表情');
  if(action==='update')assert.ok(/改名|命名|取名|重命名|标签|这张.{0,10}适合|以后.{0,20}用|只.{0,6}(?:手动|点名)|允许.{0,6}自动|可以.{0,6}自动/.test(text),'需要主人明确要求修改名字、标签或使用方式');
  return text;
 }
 function metadata(args){
  assert.ok(args.name===undefined||typeof args.name==='string'&&args.name.trim()&&args.name.length<=12,'表情名字需为1–12字');
  assert.ok(args.automatic===undefined||typeof args.automatic==='boolean','自动使用需为布尔值');
  assert.ok(args.tags===undefined||Array.isArray(args.tags)&&args.tags.length<=5&&args.tags.every(t=>typeof t==='string'&&t.trim()&&t.length<=8),'标签最多5个，每个1–8字');
 }
 function tagsFor(args,item,text){
  if(args.tags===undefined&&args.automatic===undefined)return undefined;
  const tags=(args.tags??item?.tags??[]).map(tag=>tag.trim().replace(/^#/,'')).filter(Boolean);
  const explicitManual=/(?:只|仅).{0,6}(?:手动|点名)|(?:别|不要|禁止|不许|不能|不用).{0,6}自动/.test(text);
  if(args.automatic===true)assert.ok(!explicitManual&&/(?:允许|可以|能).{0,6}自动|取消.{0,6}只手动/.test(text),'需明确允许这张图自动发送');
  const manual=args.automatic===false||explicitManual||args.tags?.includes(NEVER_RANDOM)||args.automatic!==true&&item?.tags?.includes(NEVER_RANDOM);
  const clean=[...new Set(tags.filter(tag=>tag!==NEVER_RANDOM))];
  return manual?[NEVER_RANDOM,...clean].slice(0,5):clean;
 }
 function find(args){const item=args.id?store().library().items.find(i=>i.md5===args.id):store().match(args.query);assert.ok(item,'图库中没有合适的表情');return item;}
 async function sendCC(item,route,sessionId,requestId,signal){
  const result=await senderFor(route,sessionId).send({filePath:stickerPath(item),requestId},{signal});
  if (result.state==='confirmed'&&result.messageId) selection?.record(route,item);
  return result;
 }
 async function action(args,exec,route,sessionId){
  authorize(route,exec);const operation=args.action??'list';
  assert.ok(['list','add','update','delete','send','status'].includes(operation),'未知表情操作');
  if(operation==='list'){const q=String(args.query??''),library=store().library().items;return {ok:true,count:library.length,items:library.filter(i=>!q||[i.name,...i.tags??[]].some(t=>t.includes(q))).map(({md5,name,tags,uses})=>({id:md5,name,tags,uses:uses??0}))};}
  const scope=hash([options.instanceId,routeKey(route),senderKey(route),sessionId]);
  if(operation==='status'){
   assert.match(args.requestId??'',/^whalenest-sticker-[a-f0-9]{64}$/);const r=readState(join(directory,args.requestId+'.json'),null);assert.equal(r?.scope,scope,'当前会话没有这项表情请求');
   if(route.channel==='clawchat'&&r.action==='send'&&r.result?.state==='uncertain'&&r.result.requestId){
    const sender=senderFor(route,sessionId);
    if(typeof sender.check==='function'){
     const receipt=await sender.check(r.result.requestId,{signal:exec.signal});
     const latest=readState(join(directory,args.requestId+'.json'),null);
     if(latest?.result?.state==='confirmed')return latest.result;
     r.result={...receipt,ok:receipt.state==='confirmed'&&!!receipt.messageId,operationId:args.requestId};
     r.state=receipt.state==='confirmed'?'completed':receipt.state==='failed'?'failed':'uncertain';
     const item=r.result.ok&&!r.usesRecorded&&store().library().items.find(i=>i.md5===r.itemId);
     if(item){store().markUsed(item.md5);selection?.record(route,item);r.usesRecorded=true;}
     writeState(join(directory,args.requestId+'.json'),r);
    }
   }
   return r.result??{ok:false,state:'uncertain',operationId:args.requestId,message:'发送结果不确定，保留原请求，禁止换编号重发'};
  }
  const text=intent(operation,exec,route,sessionId);metadata(args);
  if(operation==='update')assert.ok(args.name!==undefined||args.tags!==undefined||args.automatic!==undefined,'需要指定新名字、标签或使用方式');
  const id='whalenest-sticker-'+hash([options.instanceId,sessionId,nativeOperationId(exec)]),file=join(directory,id+'.json'),fingerprint=hash(args);
  const old=readState(file,null);if(old){assert.equal(old.scope,scope,'表情请求归属冲突');assert.equal(old.fingerprint,fingerprint,'表情请求内容冲突');return old.result??{ok:false,state:'uncertain',operationId:id,message:'原操作结果不确定，请核对，不能重复收录或发送'};}
  if(flights.has(id))return flights.get(id);
  const work=async()=>{
   let bytes,item;
   if(operation==='add')bytes=await stickerMaterial(options,route,sessionId,args,exec,getNative?.());else item=find(args);
   if(operation==='send')assert.ok(getConfig().stickers.enabled,'表情发送已关闭');
   const tags=['add','update'].includes(operation)?tagsFor(args,item,text):undefined;
   const identity={scope,fingerprint,operationId:id,action:operation,...(item?{itemId:item.md5}:{})};
   writeState(file,{...identity,state:'uncertain'});
   let result;
   if(operation==='add')result=await store().addFromBuffer(bytes,{name:args.name??'新表情',tags:tags??[],from:'tool',toQQ:false});
   else if(operation==='update')result=store().rename(item.md5,args.name,tags,{toQQ:false});
   else if(operation==='delete')result=await store().remove(item.md5,{fromQQ:false});
   else if(route.channel==='qq')result=await getNative().hub.sendSticker('private:'+route.sender,item,undefined,undefined,{requestId:id});
   else {result=await sendCC(item,route,sessionId,id,exec.signal);if(result.state==='confirmed')store().markUsed(item.md5);}
   if(operation==='send')result={...result,ok:result?.state==='confirmed'&&!!result?.messageId,operationId:id};
   else {assert.ok(result?.ok,result?.reason??'表情操作未保存');result={...result,operationId:id};}
   writeState(file,{...identity,state:result.ok?'completed':'uncertain',usesRecorded:operation==='send'&&result.ok,result});return result;
  };
  const promise=work();flights.set(id,promise);try{return await promise;}finally{flights.delete(id);}
 }
 function tool(route,sessionId){return defineTool({name:'companion_stickers',description:'主人共同表情库：list查看；add仅在主人明确要求收录时用，默认取当前会话最近一批实际图片；多图用index从1编号，引用旧回合用inputId。filePath/source仅用于本会话附件或主人明确给出的工作区文件/图片URL，不能读取另一端未收录图片；没有图或指代不清先澄清。name/tags可选。'+tagGuide+'仅手动用时传automatic=false，主人明确允许后可设为true。默认新表情，不调用视觉起名、不写QQ收藏。update改名、标签或使用方式，delete删除，send按id/query发送当前私聊。仅confirmed且有messageId表示发出，未知用status和operationId核对，不换请求重发。',
  properties:{action:str('list/add/update/delete/send/status'),id:str('表情MD5'),query:str('名字或情绪'),filePath:str('当前附件或主人给出的工作区图片路径'),source:str('主人明确提供的图片URL或工作区路径'),inputId:str('本会话图片来源回合/消息编号'),index:int('候选图片编号，从1开始；多图必须指定'),painting:str('主人明确指定的原画作编号或完整文件名'),name:str('名字，最多12字'),tags:{type:'array',items:{type:'string'}},automatic:{type:'boolean'},requestId:str('status填写此前返回的operationId')},
  render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],execute:(args,exec)=>action(args,exec,route,sessionId)});}
 const ports={
  takeAutoScene(session,turn){
   const id=String(session.id),scene=selection?.scene(id,turn);
   selection?.forget(id);
   return scene;
  },
  pickAuto(chatId,scene){return selection?.pick(selection.qqRoute(chatId),scene,store());},
  manualCall(block){if(!['companion_stickers','companion_paintings'].includes(block.name))return false;try{return (typeof block.arguments==='string'?JSON.parse(block.arguments):block.arguments)?.action==='send';}catch{return true;}},async send(chatId,item,opts,send){
  const identity=[options.instanceId,chatId,opts.operationId];
  const id=opts.requestId??'whalenest-auto-sticker-'+hash(opts.automatic?[...identity,'optional']: [...identity,opts.index,item.md5]);
  assert.ok(opts.requestId||opts.operationId,'QQ表情发送缺少持久回合标识');
  const file=join(options.dataDir,'expressions/qq-sticker-receipts',hash(id)+'.json'),old=readState(file,null);
  if(old){assert.equal(old.itemId,item.md5,'表情请求素材冲突');return {...old,replayed:true};}
  writeState(file,{requestId:id,itemId:item.md5,state:'uncertain'});
  try{const r=await send();assert.ok(r?.message_id||r?.messageId,'QQ网关未返回实际图片消息回执');const result={requestId:id,itemId:item.md5,state:'confirmed',messageId:String(r.message_id??r.messageId)};writeState(file,result);selection?.record(selection.qqRoute(chatId),item);return result;}
  catch(error){return {requestId:id,itemId:item.md5,state:'uncertain',message:'QQ图片发送未获确认，禁止重复发送'};}
 }};
 const aliases={qq_save_sticker:a=>({...a,action:'add'}),qq_collect_sticker:a=>({...a,action:'add'}),qq_add_sticker:a=>({...a,action:'add'}),qq_edit_sticker:a=>({action:a.delete?'delete':'update',query:a.sticker,name:a.new_name,tags:a.tags,automatic:a.automatic}),qq_send_sticker:a=>({action:'send',query:a.name})};
 function module(){return {...original,setup(api){return original.setup({...api,
  rule:rule=>api.rule(()=>'- 主人明确请求收录或发表情时使用表情工具，名称和用途以主人给出的信息为准。'+tagGuide+'“不随机”表示只手动发。普通聊天写正常回复，自动配图由本轮独立指令管理。QQ收藏导入必须明确要求。'),
  tool(factory){return api.tool(where=>factory(where).map(t=>{
   if(aliases[t.name])return defineTool({name:t.name,description:t.name==='qq_send_sticker'?'从共同图库发送到当前QQ会话，需confirmed和messageId；失败或未知不重发。':'主人明确要求时管理同一共同图库；收录不依赖自动开关，不同步QQ收藏，不自动看图起名。多图需index明确选择，paintings需明确要求。',properties:{...t.parameters.properties,inputId:str('当前会话来源消息编号'),index:int('多张图片编号，从1开始'),automatic:{type:'boolean'}},required:t.parameters.required,
    render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],async execute(args,exec){const cfg=getConfig(),route={channel:'qq',account:cfg.botQQ,sender:where.chat.userId,kind:where.chat.kind,conversation:where.chat.userId};
     if(t.name==='qq_send_sticker'&&(where.chat.kind!=='private'||where.chat.userId!==cfg.ownerQQ))return getNative().hub.sendSticker(where.chat.chatId,args.name,undefined,undefined,{requestId:'whalenest-sticker-'+hash([options.instanceId,String(where.sessionId),nativeOperationId(exec)])});
     return action(aliases[t.name](args),exec,route,String(where.sessionId));}});
   if(t.name==='qq_import_qq_stickers')return defineTool({name:t.name,description:t.description,properties:t.parameters.properties,required:t.parameters.required,
    render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}],execute(args,exec){const cfg=getConfig(),route={channel:'qq',account:cfg.botQQ,sender:where.chat.userId,kind:where.chat.kind,conversation:where.chat.userId};authorize(route,exec);intent('importQQ',exec);assert.ok(cfg.enabled&&!cfg.dryRun&&getNative().onebot.state==='connected','需要已登录QQ网关');return t.execute(args,exec);}});
   return t;
  }));}
 });}};}
 return {tool,action,ports,module,sendCC,store};
}
