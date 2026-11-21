import {readFileSync,appendFileSync} from 'node:fs';
export function installBiliFixture(ctx){
 const original=globalThis.fetch;
 globalThis.fetch=async(input,...args)=>{
  const url=new URL(String(input));
  const inboxFile=process.env.WHALENEST_BILI_INBOX_FIXTURE;
  if(inboxFile&&['api.bilibili.com','api.vc.bilibili.com'].includes(url.hostname)&&/get_sessions|fetch_session_msgs|\/x\/msgfeed\//.test(url.pathname)){
   if((args[0]?.method??'GET')!=='GET')throw Error('Inbox fixture forbids writes');appendFileSync(inboxFile+'.calls',JSON.stringify({path:url.pathname,method:args[0]?.method??'GET'})+'\n');
   const fixture=JSON.parse(readFileSync(inboxFile)),key=url.pathname.endsWith('/get_sessions')?'sessions':url.pathname.endsWith('/fetch_session_msgs')?'messages':url.pathname.split('/').at(-1);return Response.json({code:0,data:fixture[key]});
  }
  if(url.hostname==='aisubtitle.hdslb.com')return Response.json({body:[{content:'TEST_OCEAN：鲸鱼生活在海洋。'}]});
  if(url.hostname!=='api.bilibili.com')return original(input,...args);
  if(process.env.WHALENEST_TRACE)appendFileSync(process.env.WHALENEST_TRACE+'.bili-api-calls',JSON.stringify({path:url.pathname,method:args[0]?.method??'GET'})+'\n');
  let data;
  if(url.pathname.endsWith('/spi'))data={b_3:'fixture-buvid'};
  else if(url.pathname.endsWith('/nav'))data={isLogin:!!inboxFile,...(inboxFile?{mid:123,uname:'合成测试账号'}:{}),wbi_img:{img_url:'https://i0.hdslb.com/'+('a'.repeat(32))+'.png',sub_url:'https://i0.hdslb.com/'+('b'.repeat(32))+'.png'}};
  else if(url.pathname.endsWith('/search/type'))data={result:[{bvid:'BV1xx411c7mD',aid:123,title:'TEST_OCEAN 海洋科普',author:'测试作者'}]};
  else if(url.pathname.endsWith('/wbi/view'))data={bvid:'BV1xx411c7mD',aid:123,cid:456,title:'TEST_OCEAN 海洋科普',desc:'鲸鱼资料',owner:{name:'测试作者'},stat:{view:10}};
  else if(url.pathname.endsWith('/wbi/v2'))data={subtitle:{subtitles:[{lan:'zh',lan_doc:'中文',subtitle_url:'https://aisubtitle.hdslb.com/fixture.json'}]}};
  else if(url.pathname.endsWith('/wbi/main'))data={replies:[{rpid:1,member:{uname:'测试'},content:{message:'公开热评'}}]};
  else if(url.pathname.endsWith('/sign/update'))data={};
  else throw Error('Unexpected Bili fixture URL: '+url.pathname);
  return Response.json({code:0,data});
 };
 ctx.effect(()=>()=>{globalThis.fetch=original;});
}
