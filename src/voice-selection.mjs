import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readState,writeState} from './state.mjs';
import {hash} from './routing.mjs';
import {defaultPlatformVoice,resolvePlatformVoice,platformVoiceChoices} from './voice-catalog.mjs';

const conflict=()=>Object.assign(Error('音色刚被其他操作修改了，请查看当前音色后重新选择'),{code:'VOICE_SELECTION_CONFLICT',status:409});

/** Owner chat controls use the SDK's single config writer. */
export function createVoiceSelection(options,{getConfig,setConfig,speech}){
  const enabled=options.speech?.enabled===true,model=options.speech?.ttsModel??null;
  const initial=options.speech?.voice??(enabled?defaultPlatformVoice:null);
  const current=()=>getConfig().voice.platformVoice??initial;
  const verified=()=>[...new Set([initial,...(getConfig().voice.platformVoices??[])].filter(Boolean))];
  let tail=Promise.resolve();
  function status(){
    const voice=current(),verifiedVoices=verified(),choices=platformVoiceChoices(model,{current:voice,verified:verifiedVoices});
    return {enabled,voice,voiceName:choices.find(item=>item.voice===voice)?.name??null,choices,verifiedVoices,
      voiceCatalog:'whalenest-and-instance-verified',ttsModel:model,asrModel:options.speech?.asrModel??null};
  }
  function change(value,{requestId,signal}={}){
    const run=async()=>{
      assert.ok(enabled&&model,'平台语音尚未启用');
      assert.ok(typeof requestId==='string'&&requestId.length>0&&requestId.length<=256,'音色设置需要稳定操作编号');
      const voice=resolvePlatformVoice(value,model),fingerprint=hash([model,voice]);
      const file=join(options.dataDir,'voice/selection-requests',hash([options.instanceId,requestId])+'.json');
      let record=readState(file,null);
      if(record){
        assert.equal(record.fingerprint,fingerprint,'音色操作编号与内容不一致');
        if(record.state==='completed')return {ok:true,...status(),verifiedVoice:voice,appliedVoice:voice,replayed:true};
        if(record.state==='failed')throw Object.assign(Error(record.error),{code:record.code??'VOICE_SELECTION_FAILED'});
      }else{
        record={schema:1,fingerprint,voice,beforeVoice:current(),state:'checking'};writeState(file,record);
      }
      if(![record.beforeVoice,voice].includes(current()))throw conflict();
      if(record.state==='checking'){
        try{
          if(voice!==current()){
            signal?.throwIfAborted();
            const checked=await speech.synthesize('你好，我是鲸鱼娘。',requestId,{voice,signal});
            assert.equal(checked.voice,voice,'音色检查结果不一致');
          }
          record.state='checked';writeState(file,record);
        }catch(error){record.state='failed';record.error=error.message;record.code=error.code;writeState(file,record);throw error;}
      }
      signal?.throwIfAborted();
      if(![record.beforeVoice,voice].includes(current()))throw conflict();
      const cfg=getConfig();
      setConfig({...cfg,voice:{...cfg.voice,platformVoice:voice,
        platformVoices:[...new Set([...verified(),voice])]}});
      assert.equal(current(),voice,'音色设置未保存');
      record.state='completed';writeState(file,record);
      return {ok:true,...status(),verifiedVoice:voice,appliedVoice:voice,replayed:false};
    };
    const result=tail.then(run);tail=result.catch(()=>{});return result;
  }
  return {status,current,change};
}
