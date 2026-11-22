import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {readPlatformProvider} from './platform-provider.mjs';
import {startPlatformVoiceBridge} from './platform-voice-bridge.mjs';
import {defaultPlatformVoice} from './speech.mjs';
import {writeState} from './state.mjs';

const run = promisify(execFile);
const defaultAvatar = fileURLToPath(new URL('./assets/whalenest-avatar.png',import.meta.url));
const gatewayDirectory = fileURLToPath(new URL('../vendor/platform-liveware/',import.meta.url));

export function verifiedRealtimePublicOrigin(value) {
  if (value === undefined) return null;
  assert.match(value,/^https:\/\/app-[a-z0-9-]+\.apps\.clawling\.io$/,'Invalid ClawChat call origin');
  return value;
}

function profileReader({delivery,route}) {
  if (!delivery?.connectBin || !delivery.configPath || !route.account) return undefined;
  return async signal => {
    const {stdout} = await run(delivery.connectBin,['tool','call','clawchat_get_account_profile',
      '--agent',route.account,'--config',delivery.configPath,'--request-id','whalenest-voice-profile-'+randomUUID(),
      '--input-json','{}'],{timeout:8500,maxBuffer:128*1024,signal});
    const {result} = JSON.parse(stdout);
    assert.ok(result?.id,'ClawChat profile unavailable');
    return result;
  };
}

export async function startPlatformVoiceLiveware(options,{withPrivateVoiceSession,listModels,readProfile=profileReader(options.clawchat),port=options.realtime?.port??8897}={}) {
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535,'Invalid call port');
  const publicOrigin = verifiedRealtimePublicOrigin(options.realtime?.publicOrigin);
  const {speech} = options;
  const {base,key} = await readPlatformProvider(speech);
  const secret = Buffer.from(randomBytes(32).toString('hex'));
  const bridge = await startPlatformVoiceBridge(options,{secret,withPrivateVoiceSession,listModels,readProfile});
  const child = spawn(options.realtime?.python ?? 'python3',['-B','-m','clawnest_voice.dsh_runtime'],{
    cwd:gatewayDirectory,stdio:['pipe','pipe','inherit'],
  });
  const stopped = new Promise(resolve=>child.once('close',resolve));
  function stopChild() {
    child.kill('SIGTERM');
    const timer = setTimeout(()=>child.kill('SIGKILL'),10000);
    return stopped.finally(()=>clearTimeout(timer));
  }
  try {
    const ready = new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(Error('Platform voice gateway did not start')),8000);
      let pending = '';
      child.stdout.on('data',chunk=>{
        pending += chunk;
        const end = pending.indexOf('\n');
        if (end === -1) return;
        try {
          const result = JSON.parse(pending.slice(0,end));
          assert.ok(result.ready === true && Number.isInteger(result.port) && result.port > 0);
          resolve(result.port);
        } catch { reject(Error('Invalid platform voice startup receipt')); }
      });
      child.once('error',reject);
      child.stdin.once('error',reject);
      child.once('close',()=>reject(Error('Platform voice gateway exited')));
      stopped.then(()=>clearTimeout(timer));
    });
    child.stdin.end(JSON.stringify({port,base,key,secret:secret.toString(),owner:options.clawchat.route.sender,public_origin:publicOrigin,
      asr_model:speech.asrModel,tts_model:speech.ttsModel,voice:speech.voice||defaultPlatformVoice,
      sample_rate:speech.sampleRate??22050,default_avatar:defaultAvatar,bridge:bridge.port,data_dir:join(options.dataDir,'realtime/platform')}));
    const listening = await ready;
    writeState(join(options.dataDir,'realtime/server.json'),{
      pid:child.pid,port:listening,state:'ready',provider:'clawnest-voice',at:new Date().toISOString(),
    });
    let closing;
    const close = ()=>closing??=(async()=>{
      try { await stopChild(); }
      finally { await bridge.close(); }
    })();
    stopped.then(()=>{void close().catch(()=>{});});
    return {port:listening,close};
  } catch (error) {
    try { await stopChild(); }
    finally { await bridge.close(); }
    throw error;
  }
}
