import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync,statSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {hash} from './routing.mjs';
import {readState} from './state.mjs';
import {humanMessageText} from './memory-adapter.mjs';
import {segmentBytes,fetchImage} from '../vendor/aurabot/src/core/net.js';
import {resolvePainting} from '../vendor/aurabot/src/features/paintings.js';

const max=5*1024*1024;
const inside=(root,path)=>{const rel=relative(realpathSync(root),path);return rel&&!rel.startsWith('..')&&!isAbsolute(rel);};
export function stickerTurn(exec,options,route,sessionId=String(exec.agent.id)){
 for(let n=exec.agent.session.seq;n>=0;n--){const e=exec.agent.session.eventAt(n);if(e?.type!=='user/message')continue;
  const message=e.data.message??e.data;if(!['user','schedule','aurabot'].includes(message.source?.kind))continue;
  const text=message.source.humanText??(message.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  let human=humanMessageText(text).replace(/^【私聊】[^：]*：/,'').split(/\n(?:用户图片附件|用户附件|用户语音|语音附件 |引用消息)/)[0];
  if(options&&route?.channel==='clawchat'&&message.source?.connectInputId){
   const receipt=readState(join(options.dataDir,'media/incoming',hash([route.account,route.conversation,sessionId,message.source.connectInputId]),'input.json'),null);
   if(receipt?.state==='completed')human+='\n'+Object.entries(receipt.transcripts??{}).filter(([i])=>receipt.transcription?.[i]?.state==='confirmed').map(([,t])=>t).join('\n');
  }
  return {message,text:human};
 }throw Error('需要当前主人消息');
}
function localBytes(path,roots){
 assert.ok(typeof path==='string'&&isAbsolute(path),'需要实际图片文件');assert.ok(!lstatSync(path).isSymbolicLink(),'不支持符号链接图片');
 const full=realpathSync(path);assert.ok(roots.some(root=>inside(root,full)),'图片不属于当前会话或明确指定的工作区');
 const st=statSync(full);assert.ok(st.isFile()&&st.size>0&&st.size<=max,'表情图片需为5MiB以内的普通文件');return readFileSync(full);
}
function pick(items,index){
 assert.ok(items.length,'当前会话没有可取得的图片，请先发送或明确引用');
 if(index===undefined)assert.equal(items.length,1,'有多张候选图片，请指定第几张');
 const i=index??1;assert.ok(Number.isInteger(i)&&i>=1&&i<=items.length,'图片编号不存在');return items[i-1];
}
export async function stickerMaterial(options,route,sessionId,args,exec,native){
 const turn=stickerTurn(exec,options,route,sessionId),source=args.filePath??args.source;
 if(args.painting){
  assert.ok(/^#?\d{1,2}$/.test(args.painting)||/^[^/\\]+\.(png|jpe?g|gif|webp)$/i.test(args.painting)&&turn.text.includes(args.painting),'请明确指定画作编号或完整文件名，不能猜测另一会话的最新画作');
  assert.ok(/画|作品|#\d/.test(turn.text),'本轮没有明确收录画作的要求');
  const painting=resolvePainting(route.channel==='qq'?'private:'+route.sender:'clawchat:'+sessionId,args.painting);assert.ok(painting,'当前会话找不到这幅画，请提供图片或完整文件名');
  return localBytes(painting.path,[join(options.dataDir,'aurabot/imagegen')]);
 }
 if(source&&turn.text.includes(source)){
  if(/^https?:\/\//.test(source))return fetchImage(source,{maxBytes:max,allowLocal:false});
  if(isAbsolute(source)&&inside(options.cwd,realpathSync(source)))return localBytes(source,[options.cwd]);
 }
 if(route.channel==='qq'){
  let media=native.hub.recentMedia('private:'+route.sender).filter(r=>r.userId===route.sender||r.fromReply);
  if(args.inputId)media=media.filter(r=>String(r.referenceId??r.messageId)===args.inputId);
  else if(media.length){const last=media.at(-1);media=media.filter(r=>last.messageId?r.messageId===last.messageId:r.at===last.at);}
  assert.ok(!source,'请使用当前QQ图片或主人明确指定的图片地址');
  const item=pick(media,args.index);return segmentBytes(item.seg,native.onebot,{maxBytes:max});
 }
 const session=exec.agent.session;assert.equal(String(exec.agent.id),String(sessionId),'图片会话不匹配');
 for(let n=session.seq;n>=0;n--){const e=session.eventAt(n);if(e?.type!=='user/message')continue;const m=e.data.message??e.data;
  const id=m.source?.connectInputId;if(!id||m.source.kind!=='user'||args.inputId&&args.inputId!==id)continue;
  const root=join(options.dataDir,'media/incoming',hash([route.account,route.conversation,sessionId,id])),file=join(root,'input.json');
  const receipt=readState(file,null);if(receipt?.state!=='completed')continue;
  const images=receipt.files.filter(f=>f.kind==='image');if(!images.length)continue;
  if(!args.inputId&&Date.now()-statSync(file).mtimeMs>30*60*1000)break;
  const item=source?images.find(f=>f.path===source):pick(images,args.index);assert.ok(item,'该图片不属于当前会话');
  const bytes=localBytes(item.path,[root]);assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,'收到的图片发生变化');return bytes;
 }
 throw Error('当前会话没有匹配的图片，请先发送或明确引用，不能读取另一会话未收录的图片');
}
