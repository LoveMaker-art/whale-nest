import assert from 'node:assert/strict';
import {WebSocket} from 'undici';
import {setTimeout as delay} from 'node:timers/promises';

/** Exercise the app's actual SSE/WS contract without a hardware microphone. */
export async function connectPlatformVoice(origin,owner,{browserOrigin}={}) {
  const headers = {'x-clawchat-user-id':owner};
  const page = await fetch(origin,{headers});
  assert.equal(page.status,200);
  const markup = await page.text();
  assert.match(markup,/aria-label="开始通话"/);
  const build = Number.parseInt(/id="build-id">([a-f0-9]{12})</.exec(markup)?.[1],16);
  assert.ok(build);
  const wsHeaders = browserOrigin ? {...headers,origin:browserOrigin} : headers;
  const ws = new WebSocket(origin.replace(/^http/,'ws')+'/ws',{headers:wsHeaders});
  ws.binaryType='arraybuffer';
  const frames = [];
  const controller = new AbortController();
  let stream;
  let ended = false;
  let audioMetadata;
  function receive(frame) {
    frames.push(frame);
    if (frame.type==='segment_end') send({type:'played',source:'audio_ended',
      client_turn_id:frame.client_turn_id,segment_id:frame.segment_id,samples:frame.samples});
  }
  ws.addEventListener('message',message=>{
    if (message.data instanceof ArrayBuffer) {
      assert.equal(audioMetadata?.type,'audio');
      receive({...audioMetadata,pcm:Buffer.from(message.data).toString('base64')});
      audioMetadata=undefined;
      return;
    }
    const frame=JSON.parse(message.data);
    if (frame.type==='audio') audioMetadata=frame;
    else receive(frame);
  });
  ws.addEventListener('close',()=>{ended=true;});
  const send = value=>ws.send(JSON.stringify(value));
  async function waitFor(predicate,timeout=18000) {
    const end = Date.now()+timeout;
    while (Date.now()<end) {
      const failure = frames.find(frame=>frame.type==='error');
      if (failure) throw Error(JSON.stringify(failure));
      const match = frames.find(predicate);
      if (match) return match;
      if (ended) break;
      await delay(30);
    }
    throw Error('Platform voice frames missing: '+JSON.stringify(frames.map(f=>f.type)));
  }
  try {
    await Promise.race([new Promise((resolve,reject)=>{
      ws.addEventListener('open',resolve,{once:true});
      ws.addEventListener('error',()=>reject(Error('Voice websocket failed')),{once:true});
    }),delay(4000,undefined,{ref:false}).then(()=>{throw Error('Voice websocket timeout');})]);
    send({type:'start',protocol_version:2,build_id:build,
      capabilities:{sse_downstream:1,stream_upload:1,recorder:1}});
    const start = await waitFor(frame=>frame.type==='session'&&frame.state==='started');
    assert.equal(start.downstream_transport,'sse');
    const response = await fetch(origin+'/downstream?session_id='+start.session_id+'&after=0',{headers,signal:controller.signal});
    assert.equal(response.status,200);
    stream = (async()=>{
      let buffered = '';
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          if (line.startsWith('data: ')) receive(JSON.parse(line.slice(6)));
        }
      }
    })();
    stream.catch(()=>{});
    await waitFor(frame=>frame.type==='sse_ready',5000);
    return {
      frames,waitFor,send,callId:start.session_id,
      upload(id,pcm) {
        send({type:'utterance_start',client_turn_id:id,encoding:'pcm_s16le',sample_rate:16000,upload_mode:'batch'});
        for (let offset=0;offset<pcm.length;offset+=4096) ws.send(pcm.subarray(offset,offset+4096));
        send({type:'utterance_end',client_turn_id:id});
      },
      async close(){
        if (ws.readyState===WebSocket.OPEN) {
          send({type:'end_session'});
          await waitFor(frame=>frame.type==='session_end',4000).catch(()=>{});
        }
        ws.close();
        controller.abort();
        await stream?.catch(()=>{});
      },
    };
  } catch (error) {
    ws.close();
    controller.abort();
    await stream?.catch(()=>{});
    throw error;
  }
}

export async function connectPlatformVoiceHttp(origin,owner,{browserOrigin,chunked=false,dropFirstWriteReceipt=false}={}) {
  const {runInNewContext}=await import('node:vm');
  const {readFile}=await import('node:fs/promises');
  const {request}=await import('node:http');
  const headers={'x-clawchat-user-id':owner,...(browserOrigin?{origin:browserOrigin}:{})};
  const page=await fetch(origin,{headers});
  assert.equal(page.status,200);
  const build=Number.parseInt(/id="build-id">([a-f0-9]{12})</.exec(await page.text())?.[1],16);
  assert.ok(build);
  let lostReceipt=false;
  const {DshHttpVoiceSocket}=runInNewContext(await readFile(new URL('../vendor/platform-liveware/clawnest_voice/dsh-http.js',import.meta.url),'utf8')+'\nglobalThis;',{
    AbortController,crypto,btoa,atob,queueMicrotask,setTimeout,clearTimeout,
    async fetch(path,init={}){
      const url=new URL(path,origin);
      if (!chunked || init.body===undefined) return fetch(url,{...init,headers:{...headers,...init.headers}});
      // The relay is permitted to forward a POST body in HTTP chunks.
      return new Promise((resolve,reject)=>{
        const req=request(url,{method:'POST',headers:{...headers,...init.headers,'Transfer-Encoding':'chunked'},signal:init.signal},res=>{
          const bytes=[];
          res.on('data',chunk=>bytes.push(chunk));
          res.on('end',()=>{
            if(dropFirstWriteReceipt&&!lostReceipt&&url.pathname.endsWith('/frames')&&res.statusCode===200){
              lostReceipt=true;
              reject(Error('Test dropped the first write receipt'));
              return;
            }
            resolve(new Response(Buffer.concat(bytes),{status:res.statusCode}));
          });
          res.on('error',reject);
        });
        req.on('error',reject);
        const body=Buffer.from(init.body);
        req.write(body.subarray(0,Math.ceil(body.length/2)));
        req.end(body.subarray(Math.ceil(body.length/2)));
      });
    },
  });
  const socket=new DshHttpVoiceSocket('/');
  const frames=[];
  let audio, closed;
  socket.onopen=()=>socket.send(JSON.stringify({type:'start',protocol_version:2,build_id:build,
    connection_id:crypto.randomUUID(),capabilities:{sse_downstream:1,stream_upload:1,recorder:1}}));
  socket.onmessage=event=>{
    if (typeof event.data!=='string') {
      assert.ok(audio);
      frames.push({...audio,pcm:Buffer.from(event.data).toString('base64')});
      audio=undefined;
      return;
    }
    const value=JSON.parse(event.data);
    if (value.type==='audio') audio=value;
    else {
      frames.push(value);
      if(value.type==='segment_end') socket.send(JSON.stringify({type:'played',source:'audio_ended',
        client_turn_id:value.client_turn_id,segment_id:value.segment_id,samples:value.samples}));
    }
  };
  socket.onclose=event=>{closed=event;};
  async function waitFor(predicate,timeout=18000) {
    const end=Date.now()+timeout;
    while(Date.now()<end){
      const match=frames.find(predicate);
      if(match) return match;
      const error=frames.find(frame=>frame.type==='error');
      if(error) throw Error(JSON.stringify(error));
      if(closed) throw Error('Voice HTTP transport closed '+closed.code);
      await delay(25);
    }
    throw Error('Voice HTTP frames missing: '+JSON.stringify(frames.map(frame=>frame.type)));
  }
  try {
    const session=await waitFor(frame=>frame.type==='session'&&frame.state==='started',6000);
    return {
      frames,waitFor,session,send:value=>socket.send(JSON.stringify(value)),get lostReceipt(){return lostReceipt;},
      upload(id,pcm){
        socket.send(JSON.stringify({type:'utterance_start',client_turn_id:id,encoding:'pcm_s16le',sample_rate:16000,upload_mode:'batch'}));
        for(let offset=0;offset<pcm.length;offset+=4096) socket.send(pcm.subarray(offset,offset+4096));
        socket.send(JSON.stringify({type:'utterance_end',client_turn_id:id}));
      },
      close(){socket.close();},
    };
  }catch(error){socket.close();throw error;}
}
