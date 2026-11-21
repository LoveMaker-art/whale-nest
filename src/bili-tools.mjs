import assert from 'node:assert/strict';
import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,isAbsolute,join,basename} from 'node:path';
import {createBiliApi,findVideoId,UA} from '../vendor/aurabot/src/bili/api.js';
import {defineTool as aurabotTool,str,int,bool} from '../vendor/aurabot/src/tools/tools.js';
import {createBiliHttp} from './bili-http.mjs';
import {createBiliAccount} from './bili-account.mjs';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {sniffMedia} from './media.mjs';
import {createBiliRules} from './bili-rules.mjs';
import {createBiliInbox} from './bili-inbox.mjs';

const validText=(value,max)=>{assert.ok(typeof value==='string'&&value.trim()&&value.length<=max,'文字为空或超过长度限制');return value.trim();};
const defineTool=definition=>aurabotTool({...definition,render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]});
/** Additional Bili facade. No polling loop, model caller or automatic account writes. */
export function createBiliFeatures(options,route,{activities,policy,fetchImpl=fetch,now=Date.now,account:injectedAccount,http:injectedHttp,rules:injectedRules,originalComment}={}){
 const rules=injectedRules??createBiliRules(options,route,{now});
 const account=injectedAccount??createBiliAccount(options,route,{fetchImpl,now,mutationPolicy:rules});
 const api=createBiliApi({getCookie:account.getCookie,log:{debug(){}}});
 const http=injectedHttp??createBiliHttp({getCookie:account.getCookie,getDeviceId:account.getDeviceId,deviceId:account.deviceId,fetchImpl,now});
 const inbox=createBiliInbox(options,route,{account,http,rules,policy,now});
 function configure(patch){assert.ok(policy&&patch&&typeof patch==='object'&&!Array.isArray(patch),'配置须为对象');const shared={},specific={};
  for(const [key,value] of Object.entries(patch)){if(rules.owns(key))specific[key]=value;else shared[({perDay:'maxBrowsePerDay',gapMin:'cooldownMinutes'})[key]??key]=value;}
  rules.validate(specific);if(Object.keys(shared).length)policy.configure(shared);if(Object.keys(specific).length)rules.configure(specific);return {activitySettings:policy.status().settings,...rules.status(account.status().uid)};
 }
 async function video(value,page=1){assert.ok(Number.isInteger(page)&&page>=1&&page<=1000,'分P编号应为1—1000');value=String(value??'');let id=/^\d+$/.test(value)?{aid:value}:findVideoId(value);assert.ok(id,'需要视频BV号、av号或链接');if(id.short)id=findVideoId(await api.resolveShort(id.short));assert.ok(id&&!id.short,'短链接无法解析');
  const data=await http.request('/x/web-interface/wbi/view',{signed:true,params:id.bvid?{bvid:id.bvid}:{aid:id.aid}});const part=data.pages?.[page-1];assert.ok(part||(page===1&&data.cid),'指定分P不存在');return {aid:data.aid,bvid:data.bvid,cid:part?.cid??data.cid,title:data.title};
 }
 async function image(source){assert.ok(typeof source==='string'&&source.length<4096,'图片来源无效');let bytes,name='image';
  if(/^https:\/\//.test(source)){
   const url=new URL(source);assert.ok(!url.username&&!url.password&&!url.port&&(url.hostname.endsWith('.hdslb.com')||url.hostname.endsWith('.bilibili.com')),'远程图片仅接收B站HTTPS来源，其他来源请先保存为工作区文件');
   const response=await fetchImpl(url,{headers:{'user-agent':UA},redirect:'error',signal:AbortSignal.timeout(25000)});assert.ok(response.ok,'图片下载失败');const reader=response.body.getReader(),parts=[];let total=0;
   try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;assert.ok(total<=10*1024*1024,'图片超过10MiB');parts.push(Buffer.from(value));}}catch(e){await reader.cancel().catch(()=>{});throw e;}bytes=Buffer.concat(parts);
  }else{assert.ok(isAbsolute(source),'图片使用绝对路径');const actual=await realpath(source);const roots=await Promise.all([options.cwd,join(options.dataDir,'media')].filter(Boolean).map(async root=>{try{return await realpath(resolve(root));}catch{return null;}}));
   assert.ok(roots.some(root=>root&&!relative(root,actual).startsWith('..')&&!isAbsolute(relative(root,actual))),'图片须在工作区或附件目录内');const fd=await open(actual,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{const stat=await fd.stat();assert.ok(stat.isFile()&&stat.size>0&&stat.size<=10*1024*1024,'图片不是普通文件或超过10MiB');bytes=await fd.readFile();assert.equal(bytes.length,stat.size);}finally{await fd.close();}name=basename(actual);
  }
  const mime=sniffMedia(bytes);assert.ok(['image/png','image/jpeg','image/gif','image/webp'].includes(mime),'不支持的图片内容');return {bytes,name,mime};
 }
 function tools(sessionId){
  const manual=(ctx)=>{requireManualOwnerTurn(ctx);assert.ok(!policy?.nativeJob(ctx.agent.session),'后台任务不能操作账号');return nativeOperationId(ctx);};
  const mutation=(ctx,kind,input,action)=>account.mutate({requestId:sessionId+':'+manual(ctx),kind,input},action);
  const target={bvid:str('视频BV号、av号、纯数字aid或链接')};
  return [
   defineTool({name:'bili_scan',description:'主人手动发起一次B站兴趣资料读取并保存经历；可给direction/query或定点bvid，不自动登录或互动。',properties:{query:str('兴趣关键词'),direction:str('旧兴趣方向参数'),bvid:str('可选：定点读取视频，给出时不搜索')},execute:(a,c)=>activities.run({...(a.bvid?{link:a.bvid}:{query:a.query??a.direction}),sessionId,requestId:manual(c),signal:c.signal})}),
   defineTool({name:'bili_whoami',description:'核验当前B站登录状态和账号UID；不生成二维码，不返回凭据。',properties:{},execute:()=>account.whoami(http)}),
   defineTool({name:'bili_subtitle',description:'独立读取指定视频分P的可见字幕；没有可见字幕与读取失败分开报告，不生成或伪造字幕。',properties:{...target,page:int('分P编号，默认1')},required:['bvid'],execute:async a=>{const v=await video(a.bvid,a.page??1),result=await http.subtitle(v);return {ok:true,...result,video:v,message:result.state==='available'?result.text:'本次账号或匿名访问未取得可见字幕。'};}}),
   defineTool({name:'bili_comments',description:'读取视频评论，支持热度/时间排序和平台返回的字符串游标分页。请求错误不会当作没有评论。',properties:{...target,cursor:str('上次返回的nextCursor，首屏留空'),mode:str('hot/time，默认hot'),num:int('单页最大条数1—100，默认30')},required:['bvid'],execute:async a=>{assert.ok(['hot','time'].includes(a.mode??'hot'));const v=await video(a.bvid),result=await http.comments(v.aid,{cursor:a.cursor??'',mode:a.mode??'hot',limit:a.num??30});return {ok:true,...result,message:JSON.stringify(result)};}}),
   defineTool({name:'bili_reply',description:'仅在主人明确要求时向指定视频发表评论或回复指定root/parent/rpid。先登录核验；不确定不可重发，force也不能绕过后台限制。',properties:{...target,text:str('主人授权的评论正文'),root:str('可选：根评论ID'),parent:str('可选：回复评论ID'),rpid:str('旧回复评论ID参数；回复一级评论时也作为root'),force:bool('旧手动授权标记，不能绕过后台限制')},required:['bvid','text'],execute:async(a,c)=>{manual(c);const text=validText(a.text,1000),parent=a.parent??a.rpid,root=a.root??parent;for(const value of [root,parent])if(value)assert.match(value,/^\d+$/);if(originalComment)return originalComment(a.bvid,text,{root,parent,maxChars:1000},c,sessionId);const v=await video(a.bvid);return mutation(c,'reply',{aid:v.aid,text,root:root??null,parent:parent??null},async()=>{const receipt=await http.reply(v.aid,text,{root,parent});assert.ok(receipt.rpid!==undefined,'评论未返回回执，结果不确定');return {commentId:String(receipt.rpid)};});}}),
   defineTool({name:'bili_triple',description:'仅在主人明确授权对应动作时点赞/投币/收藏/三连；三连以平台确认的实际动作和投币数为准。先登录。',properties:{...target,mode:str('like/coin/fav/like_fav/triple，默认like'),coin_num:int('coin模式投币数1或2；triple由平台决定'),coinNum:int('旧投币数参数')},required:['bvid'],execute:async(a,c)=>{manual(c);const mode=a.mode??'like',coins=a.coin_num??a.coinNum??1;assert.ok(['like','coin','fav','like_fav','triple'].includes(mode)&&[1,2].includes(coins));const v=await video(a.bvid);return mutation(c,'interact',{aid:v.aid,mode,coins},({uid})=>http.interact(v.aid,{mode,coins,uid}));}}),
   defineTool({name:'bili_send_message',description:'仅在主人明确要求向该UID发送该正文时发B站私信。先登录核验；确认msg_key才算平台接受，不代表已读。',properties:{receiver_uid:str('明确的接收者UID，使用字符串保真'),uid:str('旧接收者UID参数'),text:str('主人授权的私信正文，最多500字符'),force:bool('旧手动授权标记，不能绕过后台限制')},required:['text'],execute:(a,c)=>{const receiver=a.receiver_uid??a.uid;assert.match(receiver,/^\d+$/);const text=validText(a.text,500);return mutation(c,'message',{receiver,text},({uid})=>http.sendMessage(receiver,text,{sender:uid}));}}),
   defineTool({name:'bili_send_dynamic',description:'仅在主人明确要求时发B站文字/图文动态，最多9张已有图片。不调用生图。话题须先取得真实名称；定时须在5分钟之后、7天之内，scheduled表示已安排而非已公开。',properties:{text:str('主人授权的正文'),images:{anyOf:[{type:'array',items:{type:'string'}},{type:'string'}],description:'工作区路径或B站HTTPS图片，最多9张；兼容逗号/换行分隔字符串'},topic_id:int('话题ID，0为无'),topicId:int('旧话题ID参数'),schedule_time:int('定时Unix秒，0为立即'),scheduleTime:int('旧定时Unix秒参数'),force:bool('旧手动授权标记，不能绕过后台限制')},required:['text'],execute:async(a,c)=>{manual(c);const text=validText(a.text,10000),images=typeof a.images==='string'?a.images.split(/[\n,]/).map(v=>v.trim()).filter(Boolean):a.images??[],scheduleTime=a.schedule_time??a.scheduleTime??0,topicId=a.topic_id??a.topicId??0;assert.ok(Array.isArray(images)&&images.length<=9);assert.ok(Number.isSafeInteger(topicId)&&topicId>=0,'话题ID需为非负安全整数');
    assert.ok(rules.settings().dynamicOn||a.force===true,'B站动态发布未开启；仅主人当场明确要求时可传force=true，仍受次数与间隔限制');
    if(scheduleTime)assert.ok(Number.isSafeInteger(scheduleTime)&&scheduleTime*1000>now()+300000&&scheduleTime*1000<=now()+604800000,'定时动态须在5分钟之后、7天之内');
    const topic=topicId?await http.topic(topicId):undefined;
    return mutation(c,'dynamic',{text,images,scheduleTime,topicId},async()=>{const pictures=[];for(const source of images){const data=await image(source);pictures.push(await http.uploadImage(data.bytes,data));}return http.sendDynamic(text,{pictures,scheduleTime,topic});});}}),
   defineTool({name:'bili_status',description:'查看B站账号、经历、操作额度/回执、监控状态与后台模型额度，无凭据输出。',properties:{},execute:()=>({ok:true,account:account.status(),activities:activities.list(5),operations:account.receipts(),rules:rules.status(account.status().uid),inbox:inbox.status(),background:policy?.status(),message:'状态来自本实例持久记录，登录有效性请使用bili_whoami。'})}),
   defineTool({name:'bili_inbox',description:'主人私聊查看B站私信、@和回复。check只发GET并显示实际结果，不自动回复或主动标已读；status/list查本地状态，dismiss仅本地标记处理。自动监控用bili_config的watchOn启用，通知不调用模型并共用联系限制。',properties:{action:str('status/check/list/dismiss，默认status'),limit:int('list数量1—100，默认20'),key:str('dismiss的消息key')},execute:async(a,c)=>{const action=a.action??'status';if(action==='status')return {ok:true,...inbox.status()};if(action==='list')return {ok:true,items:inbox.list(a.limit??20)};manual(c);if(action==='dismiss')return inbox.dismiss(a.key);assert.equal(action,'check','未知收件箱操作');return inbox.scan({manual:true});}}),
   defineTool({name:'bili_login_start',description:'仅当主人现在明确要求登录B站时生成本地二维码；不代替主人扫码，不自动轮询。将返回的真实PNG用原通道发送给主人。',properties:{},execute:(_a,c)=>account.start(sessionId+':'+manual(c))}),
   defineTool({name:'bili_login_poll',description:'主人发起登录后检查一次扫码状态。过期、缺凭据、核验失败均不冒充成功；不自动轮询。key是本地不透明编号，不是平台凭据。',properties:{challengeId:str('当前主人登录编号'),key:str('兼容旧参数：start返回的本地key编号')},execute:(a,c)=>{manual(c);return account.poll(a.challengeId??a.key);}}),
   defineTool({name:'bili_setup',description:'检查Node内置B站接线，无需安装Python/MCP；不会生成二维码或登录。',properties:{},execute:()=>({ok:true,backend:'Aurabot Node + WhaleNest adapters',node:process.version,account:account.status(),automaticAccountWrites:false,message:'内置接线已装载；不以安装完成代替真实登录或账号操作验收。'})}),
   defineTool({name:'bili_config',description:'查看/修改活动及B站规则。视频筛选minViews/minAgeDays；消息inboxOn/inboxUids/inboxOnceOnly/inboxMaxRemind/inboxPerDay；监控watchOn/watchDm/watchAt/watchInterval(60—1800秒)/watchScope(valley或always)；发布dynamicOn/dynamicPerDay/dynamicGapMin；其他账号操作reply/message/interact的PerDay与GapMin。perDay/gapMin仍映射统一陪伴策略。不会提高后台模型硬额度或开启自动账号写操作。',properties:{action:str('status/update/logout，默认status'),patch:{type:'object',additionalProperties:true,description:'配置补丁，未知字段拒绝；PerDay为null表示该类不另设日限，0禁止；force不能绕过次数/间隔'}},execute:(a,c)=>{if((a.action??'status')==='logout'){manual(c);return account.logout();}assert.ok(['status','update'].includes(a.action??'status'));if(a.patch){manual(c);configure(a.patch);}return {ok:true,account:account.status(),automaticAccountWrites:false,activitySettings:policy?.status().settings,rules:rules.status(account.status().uid),inbox:inbox.status(),message:'配置已持久保存；watchOn默认关闭，账号操作次数与间隔不受force绕过，后台模型硬上限保持实例配置。'};}}),
  ];
 }
 return {account,http,tools,rules,inbox,configure};
}
