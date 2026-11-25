import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {voiceModelOverlay,fastVoiceModel,selectFastVoiceModel} from '../src/voice-model.mjs';

async function fixture(t,providers){
 const home=await mkdtemp(join(tmpdir(),'whalenest-call-model-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const modelPatchFile=join(home,'.clawchat-dsh/models.patch.yml');
 await mkdir(join(home,'.clawchat-dsh'));
 const patch=[{id:'llm-pi-ai',config:{providers}},{id:'agent-default-model',config:{provider:'clawling',model:fastVoiceModel.model}}];
 await writeFile(modelPatchFile,JSON.stringify(patch));
 return {home,modelPatchFile,patch};
}

const nativeProvider=()=>({api:'openai-completions',apiKeyEnv:'FIXTURE_EXISTING_CREDENTIAL_REFERENCE',baseURL:'https://fixture.invalid/v1',models:[
 {id:fastVoiceModel.model,name:'Existing Flash',contextWindow:12000,maxTokens:300,input:['text','image'],reasoning:false},
 {id:'vision',input:['text','image']},
]});

test('call model configuration retains all official routes and uses the existing credential reference',async t=>{
 const providers={clawling:nativeProvider(),other:{api:'openai-completions',apiKeyEnv:'OTHER_REFERENCE',models:[{id:'other'}]}};
 const f=await fixture(t,providers),before=await readFile(f.modelPatchFile,'utf8');
 const overlay=voiceModelOverlay({env:{HOME:f.home}}),configured=overlay[0].config.providers,alias=configured[fastVoiceModel.provider];
 assert.deepEqual(configured.clawling,providers.clawling);
 assert.deepEqual(configured.other,providers.other);
 assert.equal(alias.apiKeyEnv,providers.clawling.apiKeyEnv);
 assert.equal(alias.baseURL,providers.clawling.baseURL);
 assert.deepEqual(alias.compat,{thinkingFormat:'deepseek'});
 assert.deepEqual(alias.models,[{...providers.clawling.models[0],reasoningEfforts:{off:null,low:'low'}}]);
 assert.equal(await readFile(f.modelPatchFile,'utf8'),before,'Only the process overlay may contain the call alias');
 assert.deepEqual(f.patch[1],{id:'agent-default-model',config:{provider:'clawling',model:fastVoiceModel.model}});
 const models=[{selection:{provider:'clawling',model:fastVoiceModel.model},isDefault:true},
  {selection:fastVoiceModel,supportedReasoningEfforts:['off','low']}];
 assert.deepEqual(selectFastVoiceModel(models),{model:fastVoiceModel,reasoningEffort:'off'});
});

test('optional call configuration leaves absent, unsupported or already configured routes alone',async t=>{
 const missing=await mkdtemp(join(tmpdir(),'whalenest-call-absent-'));t.after(()=>rm(missing,{recursive:true,force:true}));
 assert.deepEqual(voiceModelOverlay({modelPatchFile:join(missing,'missing.json')}),[]);
 for(const providers of [
  {},{clawling:{...nativeProvider(),api:'anthropic-messages'}},
  {clawling:{...nativeProvider(),models:[]}},
  {clawling:nativeProvider(),[fastVoiceModel.provider]:{api:'openai-completions',models:[{id:'custom'}]}},
 ]){
  const f=await fixture(t,providers),before=await readFile(f.modelPatchFile,'utf8');
  assert.deepEqual(voiceModelOverlay({modelPatchFile:f.modelPatchFile}),[]);
  assert.equal(await readFile(f.modelPatchFile,'utf8'),before);
 }
});
