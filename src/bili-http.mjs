import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {UA,wbiSign} from '../vendor/aurabot/src/bili/api.js';
import {readBiliInbox} from './bili-inbox-http.mjs';
import {parseBiliJson} from './bili-json.mjs';
export {parseBiliJson} from './bili-json.mjs';

export function createBiliHttp({getCookie=()=>'',fetchImpl=fetch,now=Date.now,deviceId=randomUUID(),getDeviceId=()=>deviceId}={}) {
 let keys,anonymousBuvid='';
 const cookies=()=>{const value=getCookie();assert.ok(!/[\r\n]/.test(value),'Invalid cookie');return value+(anonymousBuvid&&!/(?:^|;\s*)buvid3=/.test(value)?(value?'; ':'')+'buvid3='+anonymousBuvid:'');};
 async function decode(response){
  const reader=response.body?.getReader();assert.ok(reader,'B 站返回空响应');let total=0;const chunks=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;assert.ok(total<=8*1024*1024,'B 站响应超过8MiB');chunks.push(Buffer.from(value));}}catch(e){await reader.cancel().catch(()=>{});throw e;}
  return parseBiliJson(Buffer.concat(chunks).toString('utf8'));
 }
 async function raw(url,{method='GET',form,jsonBody,multipart,allowCodes=[],signal}={}){
  const headers={'user-agent':UA,referer:'https://www.bilibili.com/',origin:'https://www.bilibili.com',cookie:cookies()};let body;
  if(form){headers['content-type']='application/x-www-form-urlencoded';body=new URLSearchParams(form).toString();}
  else if(jsonBody){headers['content-type']='application/json';body=JSON.stringify(jsonBody);}
  else if(multipart)body=multipart;
  const response=await fetchImpl(url,{method,headers,body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000),redirect:'error'});
  if(!response.ok)throw Object.assign(new Error('B 站 HTTP '+response.status),{httpStatus:response.status,definitelyNotApplied:[400,401,403,404,405,413,415,422].includes(response.status)});
  const envelope=await decode(response);
  if(envelope.code!==0&&!allowCodes.includes(envelope.code))throw Object.assign(new Error('B 站业务错误 '+String(envelope.code)),{code:envelope.code,definitelyNotApplied:[-101,-111,-400,-403,-404].includes(envelope.code)});
  return envelope.data??{};
 }
 async function nav({signal}={}){const data=await raw('https://api.bilibili.com/x/web-interface/nav',{allowCodes:[-101],signal});
  if(data.wbi_img){const key=url=>String(url??'').split('/').at(-1).split('.')[0];keys={img:key(data.wbi_img.img_url),sub:key(data.wbi_img.sub_url),at:now()};}
  return {isLogin:data.isLogin===true,mid:String(data.mid??''),name:String(data.uname??'')};
 }
 async function ensureBuvid(signal){if(anonymousBuvid||/(?:^|;\s*)buvid3=/.test(cookies()))return;const data=await raw('https://api.bilibili.com/x/frontend/finger/spi',{signal});anonymousBuvid=String(data.b_3??'');}
 async function request(path,{params={},signed=false,host='api',...options}={}) {
  assert.ok(path.startsWith('/')&&!path.includes('://'),'Fixed API path required');
  const origin=host==='vc'?'https://api.vc.bilibili.com':'https://api.bilibili.com';let query;
  if(signed){await ensureBuvid(options.signal);if(!keys||now()-keys.at>6*3600000)await nav({signal:options.signal});assert.ok(keys?.img&&keys?.sub,'未取得 WBI 签名信息');query=wbiSign(params,keys.img,keys.sub,now());}
  else query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();
  return raw(origin+path+(query?'?'+query:''),options);
 }
 const csrf=()=>{const value=cookies().split(/;\s*/).find(part=>part.startsWith('bili_jct='))?.slice(9);assert.ok(value,'B 站登录凭据缺少写操作校验信息');return value;};
 function auth(){assert.match(cookies(),/(?:^|;\s*)SESSDATA=.+/,'需要先登录 B 站');return csrf();}
 async function search(keyword,{limit=10,order='totalrank'}={}){
  assert.ok(Number.isInteger(limit)&&limit>=1&&limit<=50&&['totalrank','click','pubdate','dm'].includes(order),'搜索数量或排序无效');const results=[],seen=new Set();
  for(let page=1;page<=3&&results.length<limit;page++){const data=await request('/x/web-interface/wbi/search/type',{signed:true,params:{search_type:'video',keyword,order,page}});const rows=data.result??[];assert.ok(Array.isArray(rows),'搜索返回格式错误');
   for(const v of rows)if(!seen.has(v.bvid)){seen.add(v.bvid);results.push({bvid:v.bvid,aid:v.aid,title:String(v.title??'').replace(/<[^>]*>/g,''),author:v.author,desc:String(v.description??'').replace(/<[^>]*>/g,''),play:Number(v.play)||0,pubdate:Number(v.pubdate)*1000,duration:v.duration});}
   if(rows.length<20)break;
  }return results.slice(0,limit);
 }
 async function comments(aid,{cursor='',mode='hot',limit=20}={}) {
  assert.ok(Number.isSafeInteger(Number(aid))&&Number(aid)>0,'Invalid video ID');assert.ok(limit>=1&&limit<=100,'Invalid comment limit');
  const data=await request('/x/v2/reply/wbi/main',{signed:true,params:{type:1,oid:aid,mode:mode==='time'?2:3,plat:1,web_location:1315875,pagination_str:JSON.stringify({offset:cursor})}});
  const rows=Array.isArray(data.replies)?data.replies:[];
  return {items:rows.slice(0,limit).map(reply=>({id:String(reply.rpid??''),author:String(reply.member?.uname??''),text:String(reply.content?.message??'').slice(0,3000),like:Number(reply.like)||0,parent:String(reply.parent??'0'),root:String(reply.root??'0')})),nextCursor:String(data.cursor?.pagination_reply?.next_offset??''),isEnd:data.cursor?.is_end===true};
 }
 async function subtitle(video){
  const data=await request('/x/player/wbi/v2',{signed:true,params:{bvid:video.bvid,cid:video.cid}}),list=data.subtitle?.subtitles??[];
  const chosen=list.find(item=>/zh|中文/i.test(String(item.lan)+String(item.lan_doc)))??list[0];if(!chosen?.subtitle_url)return {state:'unavailable',text:'',language:null};
  const url=new URL(String(chosen.subtitle_url).startsWith('//')?'https:'+chosen.subtitle_url:chosen.subtitle_url);
  assert.ok(url.protocol==='https:'&&(url.hostname.endsWith('.hdslb.com')||url.hostname.endsWith('.bilibili.com')),'Unexpected subtitle origin');
  const response=await fetchImpl(url.href,{headers:{'user-agent':UA,referer:'https://www.bilibili.com/'},signal:AbortSignal.timeout(25000),redirect:'error'});assert.ok(response.ok,'字幕读取失败');const body=await decode(response);
  return {state:'available',text:(body.body??[]).map(item=>String(item.content??'')).join(' '),language:String(chosen.lan??'')};
 }
 async function reply(aid,text,{root,parent}={}){const token=auth();return request('/x/v2/reply/add',{method:'POST',form:{type:'1',oid:String(aid),message:text,plat:'1',csrf:token,...(root?{root:String(root)}:{}),...(parent?{parent:String(parent)}:{})}});}
 async function interact(aid,{mode='like',coins=1,uid}={}) {
  const token=auth();assert.ok(['like','coin','fav','like_fav','triple'].includes(mode),'Unknown video interaction');assert.ok([1,2].includes(coins),'投币数量仅支持1或2');
  if(mode==='triple'){const data=await request('/x/web-interface/archive/like/triple',{method:'POST',form:{aid:String(aid),csrf:token}});assert.ok(data.like&&data.coin&&data.fav,'三连接口未确认全部动作');return {like:!!data.like,coin:!!data.coin,fav:!!data.fav,multiply:data.multiply??null};}
  const done={};try{
  if(mode==='like'||mode==='like_fav'){await request('/x/web-interface/archive/like',{method:'POST',form:{aid:String(aid),like:'1',csrf:token}});done.like=true;}
  if(mode==='coin'){await request('/x/web-interface/coin/add',{method:'POST',form:{aid:String(aid),multiply:String(coins),select_like:'0',csrf:token}});done.coins=coins;}
  if(mode==='fav'||mode==='like_fav'){
   assert.match(String(uid),/^\d+$/,'B 站账号UID不可用');const folders=await request('/x/v3/fav/folder/created/list-all',{params:{up_mid:uid,type:2,rid:aid}});const folder=folders.list?.[0];assert.ok(folder?.id,'没有可用收藏夹');
   if(!folder.fav_state)await request('/x/v3/fav/resource/deal',{method:'POST',form:{rid:String(aid),type:'2',add_media_ids:String(folder.id),del_media_ids:'',csrf:token}});done.fav=true;done.folderId=String(folder.id);
  }return done;}catch(error){if(done.like)delete error.definitelyNotApplied;throw error;}
 }
 async function sendMessage(receiver,text,{sender}={}) {
  const deviceId=getDeviceId();
  const token=auth();assert.match(String(receiver),/^\d+$/,'需要明确的接收者UID');assert.match(String(sender),/^\d+$/,'发送者UID不可用');
  const data=await request('/web_im/v1/web_im/send_msg',{host:'vc',signed:true,params:{w_sender_uid:sender,w_receiver_id:receiver,w_dev_id:deviceId},method:'POST',form:{'msg[sender_uid]':String(sender),'msg[receiver_id]':String(receiver),'msg[receiver_type]':'1','msg[msg_type]':'1','msg[msg_status]':'0','msg[content]':JSON.stringify({content:text}),'msg[timestamp]':String(Math.floor(now()/1000)),'msg[dev_id]':deviceId,'msg[new_face_version]':'0','msg[from_firework]':'0',build:'0',mobi_app:'web',csrf:token,csrf_token:token}});
  assert.ok(data.msg_key!==undefined&&String(data.msg_key),'私信接口未返回可靠回执，结果不确定');return {messageKey:String(data.msg_key)};
 }
 async function uploadImage(bytes,{name='image.png',mime='image/png'}={}){auth();const form=new FormData();form.set('file_up',new Blob([bytes],{type:mime}),name);form.set('biz','dyn');form.set('category','daily');
  const data=await request('/x/dynamic/feed/draw/upload_bfs',{method:'POST',multipart:form});assert.ok(typeof data.image_url==='string'&&Number(data.image_width)>0&&Number(data.image_height)>0,'图片上传回执不完整');const image=new URL(data.image_url);assert.ok(image.protocol==='https:'&&image.hostname.endsWith('.hdslb.com'),'图片上传来源异常');return {img_src:image.href,img_width:Number(data.image_width),img_height:Number(data.image_height),img_size:bytes.length/1024};
 }
 async function topic(id){assert.ok(Number.isSafeInteger(id)&&id>0,'话题ID需为正安全整数');const data=await request('/x/topic/web/details/top',{params:{topic_id:id,source:'Web'}}),item=data.top_details?.topic_item;
  assert.ok(item&&String(item.id)===String(id)&&typeof item.name==='string'&&item.name.trim(),'未取得对应真实话题，未执行发布');return {id,name:item.name,from_source:'dyn.web.detail',from_topic_id:id};
 }
 async function sendDynamic(text,{pictures=[],scheduleTime=0,topic}={}){const token=auth();assert.ok(pictures.length<=9,'动态图最多9张');
  if(scheduleTime)assert.ok(Number.isSafeInteger(scheduleTime)&&scheduleTime*1000>now()+300000&&scheduleTime*1000<=now()+604800000,'定时动态须在5分钟之后、7天之内，不会自动改成立即发布');
  const dyn_req={content:{contents:[{raw_text:text,biz_id:'',type:1}]},scene:2,meta:{app_meta:{from:'create.dynamic.web',mobi_app:'web'}},...(pictures.length?{pics:pictures}:{}),...(scheduleTime?{option:{timer_pub_time:scheduleTime}}:{}),...(topic?{topic}:{})};
  await request('/x/dynamic/feed/create/submit_check',{signed:true,params:{csrf:token},method:'POST',jsonBody:{content:dyn_req.content,...(pictures.length?{pics:pictures}:{}),scene:2,create_option:scheduleTime?{timer_pub_time:scheduleTime}:{}}});
  const data=await request('/x/dynamic/feed/create/dyn',{signed:true,params:{csrf:token},method:'POST',jsonBody:{dyn_req}});const id=data.dyn_id_str??data.dyn_id??data.dynamic_id;assert.ok(id!==undefined&&String(id),'动态接口未返回发布ID，结果不确定');return scheduleTime?{publicationState:'scheduled',draftId:String(id),scheduledAt:scheduleTime}:{publicationState:'published',dynamicId:String(id)};
 }
 return {nav,search,comments,subtitle,reply,interact,sendMessage,uploadImage,topic,sendDynamic,request,inbox:options=>{assert.match(cookies(),/(?:^|;\s*)SESSDATA=.+/,'需要先登录B站');return readBiliInbox(request,options);}};
}
