import assert from 'node:assert/strict';
import {defineTool,str,int,bool} from '../vendor/aurabot/src/tools/tools.js';
import {createCompanionPolicy} from './companion-policy.mjs';
import {createDiary} from './diary.mjs';
import {createDiaryPublisher} from './diary-publisher.mjs';
import {requireManualOwnerTurn} from './native-tool.mjs';

function operationId(ctx){
 assert.ok(ctx?.callId&&ctx.agent?.session,'Native tool identity required');const session=ctx.agent.session;
 for(let n=session.seq;n>=0;n--){const event=session.eventAt(n),message=event?.data?.message;
  if(event?.type==='assistant/message'&&message?.content?.some(b=>b.type==='tool-call'&&String(b.id)===String(ctx.rootCallId??ctx.callId)))return String(message.id)+':'+String(ctx.callId);
 }throw Error('Persisted native call required');
}
export function companionSettingsTool(policy){
 return defineTool({name:'companion_settings',description:'主人查询或调整自动联系与活动。contactEnabled只控制普通主动搭话，automatic控制既有兴趣活动和日记；proactivePlatform为QQ/ClawChat共用的主动消息首选（qq/clawchat），不改变开关。手动请求仍回复当前会话。后台硬额度不可提高。',
   properties:{action:str('status/update/pause/resume/cancel_job'),jobId:str('cancel_job 的任务编号'),contactEnabled:bool('普通主动搭话开关'),proactivePlatform:{type:'string',enum:['qq','clawchat'],description:'全局主动消息首选，QQ需已关联且连接可用'},automatic:bool('是否启用既有自动活动'),interests:{type:'array',items:{type:'string'},description:'最多10个兴趣关键词'},awakeFrom:int('联系开始小时'),awakeTo:int('联系结束小时'),idleMinutes:int('私聊空闲分钟'),cooldownMinutes:int('主动联系间隔分钟'),maxProactivePerDay:int('每天主动消息总上限'),maxBrowsePerDay:int('每天兴趣活动上限'),diaryHour:int('每日归档小时')},
   execute:(args,ctx)=>{const action=args.action??'status';if(action==='status')return {ok:true,...policy.status(),message:JSON.stringify(policy.status())};
    requireManualOwnerTurn(ctx);assert.ok(!policy.nativeJob(ctx.agent.session),'后台任务不能改变主人的设置');let result;
    if(action==='pause')result=policy.configure({paused:true});else if(action==='resume')result=policy.configure({paused:false});
    else if(action==='cancel_job')result=policy.cancelJob(args.jobId);else{assert.equal(action,'update','未知设置操作');const {action:_,jobId,...patch}=args;result=policy.configure(patch);}
    return {ok:true,...result,message:JSON.stringify(result)};
   }});
}
export function createCompanionService(options,route,{activities,now,publisherRun,policy:sharedPolicy,composeDiary,getQzone}={}){
 const policy=sharedPolicy??createCompanionPolicy(options,route,{now}),diary=createDiary(options,route,{activities,now,compose:composeDiary});
 const publisher=createDiaryPublisher(options,route,{diary,now,run:publisherRun,getQzone});
 function nativeJob(ctx){return ctx?.agent?.session?policy.nativeJob(ctx.agent.session):null;}
 function tools(){return [
  companionSettingsTool(policy),
  defineTool({name:'companion_diary',description:'主人私人日记：sources/write/read/list/delete；publication_preview预览仅含公开活动事实的动态草稿，publication_permissions读取平台权限，publication_status查询回执，publish显式发布，unpublish撤回动态。私人归档独立保留；发布默认关闭，需先确认正文及全局受众。',
   render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
   properties:{action:str('sources/write/read/list/delete/publication_preview/publication_permissions/publication_status/publish/unpublish，默认read'),date:str('YYYY-MM-DD，默认今天'),reflection:str('可选：主人明确指定的补充感想，单独标注；正文由原生成器依据真实活动产生'),platform:{type:'string',enum:['clawchat','qq'],description:'公开发布位置；publish/unpublish必须明确指定，不由主动消息首选推断'},visibility:str('明确确认的受众：ClawChat为owner，QQ按预览返回all/friends/selected/self/excluded'),approvedText:str('publish时主人已确认的完整publication_preview正文'),revise:bool('主人明确要求重新整理时才设为true')},
   execute:(args,ctx)=>{const action=args.action??'read',job=nativeJob(ctx),date=args.date??diary.today();
    if(job)assert.equal(date,job.date,'后台日记日期必须与任务一致');
    if(action==='sources'){const items=diary.sources(date);return {ok:true,items,message:JSON.stringify(items)};}
    if(['write','delete'].includes(action)){requireManualOwnerTurn(ctx);assert.ok(!job,'后台整理由唯一原生成入口执行');}
    if(action==='write')return diary.write({date,reflection:args.reflection??'',revise:args.revise??false,requestId:operationId(ctx),automatic:!!job});
    if(action==='list')return {ok:true,items:diary.list(),message:JSON.stringify(diary.list())};
    if(action==='delete'){assert.ok(!job,'后台任务不能删除日记');return diary.remove(date);}
    const platform=args.platform??'clawchat';assert.ok(['clawchat','qq'].includes(platform),'未知发布平台');const pub=platform==='qq'?publisher.qq:publisher;
    if(action==='publication_preview')return pub.preview(date,args.visibility);
    if(action==='publication_permissions')return pub.permissions(args.visibility);
    if(action==='publication_status')return pub.check(date);
    if(action==='publish'||action==='unpublish'){assert.ok(!job,'后台任务不能发布或删除平台动态');requireManualOwnerTurn(ctx);assert.ok(args.platform,'公开发布/撤回需要明确指定平台');if(platform==='clawchat'&&args.visibility)assert.equal(args.visibility,'owner','需要重新核对ClawChat全局受众');return action==='publish'?pub.publish(date,args.approvedText,args.visibility):pub.remove(date);}
    assert.equal(action,'read','未知日记操作');return diary.read(date);
   }}),
 ];}
 function prompt(job){const prefix='【伙伴后台任务，不是主人发言】任务编号 '+job.id+'。只基于真实记录，不写入主人偏好。';
  if(job.kind==='contact')return job.prompt;
  if(job.kind==='browse')throw Error('B站自动浏览由原模块执行，不使用第二套提示生成流程');
  if(job.kind==='diary')throw Error('日记由原compose直接生成，不运行第二套自动写作提示');
  throw Error('Unknown companion background task');
 }
 function finish(ids,{text,completed}={}){const job=policy.jobForInput(ids);if(!job)return null;
  if(completed&&job.kind==='diary'&&!diary.read(job.date).ok)completed=false;
  if(completed&&job.kind==='browse'&&!activities.list(20).some(record=>record.ok&&record.jobId===job.id))completed=false;
  return policy.finish(ids,{text,completed});
 }
 return {policy,diary,publisher,tools,nativeJob,prompt,finish,tick:dispatch=>policy.tick({dispatch,hasDiarySources:date=>diary.sources(date).length>0,diaryExists:date=>diary.exists(date)})};
}
