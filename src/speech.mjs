import assert from 'node:assert/strict';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sniffMedia } from './media.mjs';
import { readState, writeState } from './state.mjs';
import { createHash } from 'node:crypto';
import {readPlatformProvider} from './platform-provider.mjs';
import {buildWav,parseWav} from '../vendor/aurabot/src/voice/wav.js';

import {defaultPlatformVoice,platformVoiceIdPattern} from './voice-catalog.mjs';
export {defaultPlatformVoice,platformVoiceIdPattern};

const flights=new Map(),digest=bytes=>createHash('sha256').update(bytes).digest('hex');

export function createSpeechClient(options, fetchImpl = fetch, {getVoice} = {}) {
  async function route() {
    const speech = options.speech ?? {};
    assert.ok(speech.enabled, '语音服务尚未启用，请检查实例模型配置。');
    return {speech,...await readPlatformProvider(speech)};
  }
  async function response(path, init) {
    const { base, key } = await route();
    const signal=init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
    const result = await fetchImpl(base + path, { ...init, redirect:'error', signal,
      headers: { ...init.headers, authorization: 'Bearer ' + key } });
    if (!result.ok) {
      let code;try { const body=await result.json();code=body.error?.code??body.error?.type??body.code; } catch {}
      const safeCode=typeof code==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(code)?code:'upstream-error';
      const error=new Error('语音服务请求失败（HTTP '+result.status+'，'+safeCode+'）');error.status=result.status;throw error;
    }
    return result;
  }
  return {
    async transcribe(file, mime, requestId, {signal}={}) {
      const { speech } = await route();
      assert.ok(speech.asrModel, '尚未配置语音识别模型');
      const details = await stat(file); assert.ok(details.size <= (options.media?.maxBytesEach ?? 16 * 1024 * 1024), '音频超过大小限制');
      const body = new FormData(); body.set('model', speech.asrModel);
      body.set('language',speech.language??'zh');
      body.set('file', new Blob([await readFile(file)], { type: mime }), file.split('/').at(-1));
      const r = await response('/audio/transcriptions', { method: 'POST', body, signal, headers: { 'Idempotency-Key': requestId } });
      const result = await r.json();
      assert.ok(typeof result.text === 'string' && result.text.trim() && result.text.length <= 32000, '语音识别未返回有效文本');
      return result.text.trim();
    },
    async synthesize(text, requestId, {signal,voice:requestedVoice,emotion:requestedEmotion}={}) {
      assert.ok(typeof text === 'string' && text.trim() && text.length <= 2000, '朗读文本需为 1–2000 字符');
      assert.ok(typeof requestId==='string'&&requestId&&requestId.length<=256,'语音请求需要稳定标识');signal?.throwIfAborted();
      const { speech,base } = await route(); assert.ok(speech.ttsModel, '尚未配置语音合成模型');
      const format=speech.responseFormat??'pcm',sampleRate=speech.sampleRate??22050;
      const voice=requestedVoice??getVoice?.()??speech.voice??defaultPlatformVoice;
      assert.ok(typeof voice==='string'&&platformVoiceIdPattern.test(voice),'音色标识无效');
      // These tags are restricted to the platform model/voice verified by
      // listening acceptance. Other combinations keep their plain input.
      const tag=['excited','sad'].includes(requestedEmotion)?'['+requestedEmotion+']':'';
      const emotion=tag&&(speech.provider??'clawling')==='clawling'
        &&speech.ttsModel==='qwen-audio-3.0-tts-flash'&&voice==='longanfengyue'
        &&(text.startsWith(tag)||text.length+tag.length<=2000)?requestedEmotion:null;
      const input=emotion&&!text.startsWith(tag)?tag+text:text;
      assert.ok(['pcm','mp3','wav'].includes(format),'不支持的语音返回格式');assert.ok(Number.isInteger(sampleRate)&&sampleRate>=8000&&sampleRate<=48000,'语音采样率无效');
      const dir = join(resolve(options.dataDir), 'media', 'outgoing'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const receiptFile = join(dir, 'request-' + createHash('sha256').update(requestId).digest('hex') + '.json');
      const inputHash=digest(text);
      const fingerprint = digest(JSON.stringify([input,speech.ttsModel,voice,format,sampleRate,base]));
      // A setting change applies to the next request. Existing IDs keep their
      // original voice, including after restart or an uncertain paid request.
      const active=flights.get(receiptFile);if(active){assert.equal(active.inputHash,inputHash,'语音请求标识与内容冲突');return active.promise;}
      const work=async()=>{
      const previous = readState(receiptFile,null);
      if (previous) {
        const legacyFingerprint=digest(JSON.stringify([text,speech.ttsModel,previous.artifact?.voice??voice,format,sampleRate,base]));
        assert.ok(previous.inputHash?previous.inputHash===inputHash:previous.fingerprint===legacyFingerprint,'语音请求标识与内容冲突');
        assert.equal(previous.state,'completed','上次语音合成结果不确定，请先核对，避免重复调用');
        const bytes=await readFile(previous.artifact.path);assert.equal(bytes.length,previous.artifact.size,'已生成语音发生变化');assert.equal(digest(bytes),previous.artifact.id,'已生成语音发生变化');return previous.artifact;
      }
      const expression=emotion?{emotion}:{};
      writeState(receiptFile,{fingerprint,inputHash,voice,...expression,state:'processing'});
      try {
        const r = await response('/audio/speech', { method: 'POST', signal, headers: { 'content-type': 'application/json', 'Idempotency-Key': requestId },
          body: JSON.stringify({ model: speech.ttsModel, voice, input, response_format: format,
            ...(format==='pcm'?{stream_format:'audio',sample_rate:sampleRate,extra:{qwen:{sample_rate:sampleRate}}}:{}) }) });
        const max = options.media?.maxBytesEach ?? 16 * 1024 * 1024;
        const chunks = []; let size = 0;
        for await (const chunk of r.body) { size += chunk.length; assert.ok(size <= max, '合成音频超过大小限制'); chunks.push(Buffer.from(chunk)); }
        let bytes = Buffer.concat(chunks); assert.ok(bytes.length, '语音服务返回空文件');
        let mime = sniffMedia(bytes.subarray(0,8192),r.headers.get('content-type'));
        const declared=r.headers.get('content-type')?.toLowerCase().split(';')[0];
        if(format==='pcm'&&!['audio/wav','audio/x-wav','audio/mpeg','audio/mp3','audio/mp4','audio/ogg','audio/flac','audio/webm'].includes(declared)){
          assert.ok(r.headers.get('content-type')?.toLowerCase().startsWith('audio/'),'语音服务未返回音频');
          assert.equal(bytes.length%2,0,'PCM音频长度无效');
          const samples=new Int16Array(bytes.length/2);for(let i=0;i<samples.length;i++)samples[i]=bytes.readInt16LE(i*2);
          bytes=buildWav(samples,sampleRate);mime='audio/wav';
        }
        assert.ok(bytes.length<=max,'合成音频超过大小限制');
        assert.ok(mime.startsWith('audio/'),'语音服务未返回可识别音频文件');
        const extension = {'audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/mp4':'m4a','audio/flac':'flac','audio/webm':'webm'}[mime];
        const id = createHash('sha256').update(bytes).digest('hex');
        const file = join(dir,id+'.'+extension);
        await writeFile(file,bytes,{mode:0o600});
        const wav=mime==='audio/wav'?parseWav(bytes):null;
        const artifact={id,path:file,name:'大肥鱼的语音.'+extension,mime,kind:'audio',size:bytes.length,state:'generated',...(wav?{duration:Math.round(wav.data.length*1000/(wav.rate*wav.channels*2))}:{}),model:speech.ttsModel,voice,...expression};
        writeState(join(dir,id+'.json'),artifact);writeState(receiptFile,{fingerprint,inputHash,voice,...expression,state:'completed',artifact});
        return artifact;
      } catch(error) { writeState(receiptFile,{fingerprint,inputHash,voice,...expression,state:'uncertain'});throw error; }
      };
      const promise=work();flights.set(receiptFile,{inputHash,promise});try{return await promise;}finally{flights.delete(receiptFile);}
    },
  };
}
