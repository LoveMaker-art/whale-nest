import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const fastVoiceModel = {provider:'clawling-voice',model:'deepseek-v4.1-flash'};

/** Add the call-only route to our process overlay, preserving the official
 * model conversion and its credential reference without changing either file.
 */
export function voiceModelOverlay({env,modelPatchFile=join(env?.HOME??process.env.HOME??'/home/node','.clawchat-dsh/models.patch.yml')}={}) {
  let patch;
  try { patch=JSON.parse(readFileSync(modelPatchFile,'utf8')); }
  catch(error) { if(error.code==='ENOENT')return [];throw error; }
  if(!Array.isArray(patch))return [];
  const providers=patch.find(entry=>entry?.id==='llm-pi-ai')?.config?.providers;
  const provider=providers?.clawling;
  const model=Array.isArray(provider?.models)?provider.models.find(item=>item?.id===fastVoiceModel.model):undefined;
  if(!model||provider.api!=='openai-completions'||Object.hasOwn(providers,fastVoiceModel.provider))return [];
  // The provider dictionary is a volatile setting: an overlay replaces the
  // complete value, so retain every official route alongside our alias.
  return [{id:'llm-pi-ai',config:{providers:{...providers,[fastVoiceModel.provider]:{
    ...provider,compat:{thinkingFormat:'deepseek'},models:[{
      ...model,reasoningEfforts:{off:null,low:'low'},
    }],
  }}}}];
}

function sameModel(left,right) {
  return left?.provider===right.provider && left.model===right.model;
}

export function selectFastVoiceModel(models,selection) {
  const active=selection??models.find(model=>model.isDefault)?.selection;
  if (!sameModel(active,{provider:'clawling',model:fastVoiceModel.model})) return null;
  const route=models.find(model=>sameModel(model.selection,fastVoiceModel));
  return route?.supportedReasoningEfforts?.includes('off')
    ? {model:route.selection,reasoningEffort:'off'} : null;
}
