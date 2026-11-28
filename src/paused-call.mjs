import {createServer} from 'node:http';

/** Keep the existing private card reachable while native call integration is paused. */
export async function startPausedCall(options,{port=options.realtime?.port??8897}={}){
  const server=createServer((req,res)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    if(['/health','/healthz'].includes(req.url)){
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({ok:true,maintenance:true,available:false}));return;
    }
    if(req.url!=='/'||!['GET','HEAD'].includes(req.method)){
      res.writeHead(404);res.end();return;
    }
    res.setHeader('content-type','text/html; charset=utf-8');
    res.setHeader('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'");
    res.end(req.method==='HEAD'?'':'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>鲸栖通话</title><style>body{font:18px system-ui;background:#f0f6fb;color:#243b53;margin:0;display:grid;place-items:center;min-height:100vh}main{padding:32px;max-width:420px}p{line-height:1.7}</style><main><h1>通话暂时维护中</h1><p>聊天、普通语音消息和歌曲功能仍可使用。</p></main></html>');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {port:server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
