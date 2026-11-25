import {readFile} from 'node:fs/promises';
import {importNative,createUserMessage,installModelSelection} from './native-dsh.mjs';
import {bridgeError,optionalObject,optionalString,requestString,requestImages,nativeSessionEvents,inspectNativeSession} from './dsh-bridge-contract.mjs';

const {contentHasImage}=await importNative('@deepseek-ai/dsh-llm');
async function optionalNative(name){
 try{return await importNative(name);}catch(error){
  if(['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND'].includes(error?.code))return undefined;throw error;
 }
}
const [skillModule,presetModule]=await Promise.all([optionalNative('@deepseek-ai/dsh-skill'),optionalNative('@deepseek-ai/dsh-agent-presets')]);
const renderSkillContent=skillModule?.renderSkillContent,resolveSessionPreset=presetModule?.resolveSessionPreset;

/** Owns only the native DSH handles obtained through the agents interface.
 * The caller supplies trusted conversation/business ownership; this module
 * never reads Connect's persistence or imports Connect's runtime classes.
 */
export function createDshBridgeSessions(ctx,{companion,pageHistoryEvents}){
 const handles=new Map();let services;
 function captureServices(){
  services={workspaceRegistry:ctx.get('workspaceRegistry'),agentDefaultModel:ctx.root.get('agentDefaultModel'),
   attachments:ctx.root.get('attachments'),permissionPresets:ctx.root.get('permissionPresets'),agentPresets:ctx.root.get('agentPresets')};
 }
 function owned(params){
  const sessionId=requestString(params,'sessionId'),handle=handles.get(sessionId);
  if(!handle)throw bridgeError('session-not-owned','DSH Session is not owned by this process: '+sessionId);
  return handle;
 }
 async function resolveSelection(value){
  const provider=requestString(value,'provider'),model=requestString(value,'model'),reasoningEffort=optionalString(value.reasoningEffort);
  const resolved=await ctx.llm.resolveCallConfig({provider,model,...(reasoningEffort?{reasoningEffort}:{})});
  return {provider:resolved.provider,model:resolved.model,...(resolved.reasoningEffort?{reasoningEffort:resolved.reasoningEffort}:{})};
 }
 async function open({sessionId,cwd,selection,requestedPreset,resume,route}){
  const {agentPresets,agentDefaultModel}=services;
  let resolvedPreset,modelSelection,disposeSelection=()=>{};
  if(agentPresets){
   resolvedPreset=(await agentPresets.resolve(requestedPreset)).id;
   if(resolvedPreset.startsWith('aurabot-'))throw bridgeError('unsupported','QQ Agent Presets are reserved for the QQ Hub');
  }else if(requestedPreset&&!resume)throw bridgeError('unsupported','Selected DSH Profile does not publish Agent Presets');
  const setup=async(scope,nativeAgent)=>{
   const agent=nativeAgent??scope.agent;
   if(!agent)throw bridgeError('composition-failed','DSH Agent setup has no scoped Agent');
   const logged=optionalObject(agent.session.requestHeader?.()?.config);
   const current=selection??(typeof logged?.provider==='string'&&typeof logged.model==='string'
    ?{provider:logged.provider,model:logged.model,...(typeof logged.reasoningEffort==='string'?{reasoningEffort:logged.reasoningEffort}:{})}
    :agentDefaultModel?.currentSelection?.());
   modelSelection=typeof agent.model?.current==='function'?{get current(){return agent.model.current();}}:{current,assembled:undefined};
   const dispose=agent.model?installModelSelection(scope):installModelSelection(scope,modelSelection);
   disposeSelection=typeof dispose==='function'?dispose:()=>{};
   if(typeof agent.model?.select==='function'&&current)agent.model.select(current);
   try{
    if(agentPresets)await agentPresets.mount(scope,resolvedPreset);
    companion().mount(scope,agent,route);
   }catch(error){disposeSelection();disposeSelection=()=>{};throw error;}
  };
  let native;
  try{
   const selected=selection?{agentOptions:{provider:selection.provider,model:selection.model}}:{};
   native=resume?await ctx.agents.resume({resumeSessionId:sessionId,...selected,setup})
    :await ctx.agents.create({sessionId,meta:{cwd,...(resolvedPreset?{agentPreset:resolvedPreset}:{})},...selected,setup});
  }catch(error){disposeSelection();throw error;}
  if(!modelSelection){await native.dispose();throw bridgeError('composition-failed','DSH Agent setup did not install model selection');}
  return {agent:native.agent,modelSelection,async dispose(){disposeSelection();await native.dispose();}};
 }
 async function closeAll(){
  const owned=[...handles.values()];handles.clear();
  await Promise.all(owned.map(handle=>handle.dispose()));
 }
 async function imagesFor(handle,params){
  const images=requestImages(params);if(!images.length)return [];
  const {attachments}=services;
  if(!attachments)throw bridgeError('unsupported-media','Selected DSH Profile does not publish Attachments');
  const selection=handle.modelSelection.current;
  if(!selection)throw bridgeError('model-unavailable','DSH image input requires an exact model selection');
  const model=await ctx.llm.resolveModelInfo(selection.provider,selection.model);
  if(!model.inputModalities?.includes('image'))throw bridgeError('unsupported-media',`DSH model "${selection.model}" does not accept image input`);
  const stored=await Promise.all(images.map(async image=>({data:new Uint8Array(await readFile(image.path)),
   mediaType:image.mediaType,...(image.name?{name:image.name}:{})})));
  return await attachments.saveImages(stored);
 }
 async function injectSkill(handle,skillName){
  const skills=ctx.root.get('skills');
  if(!skills||!renderSkillContent)throw bridgeError('unsupported','Selected DSH Profile does not publish Skills');
  const skill=await skills.get(skillName,{cwd:handle.agent.session.header.cwd,scope:handle.agent});
  if(!skill?.invocation.userInvocable)throw bridgeError('skill-not-found','DSH Skill is not user-invocable: '+skillName);
  handle.agent.inject(createUserMessage({content:[{type:'text',text:renderSkillContent(skill)}],
   source:{kind:'skill-invocation',name:skill.name,form:'instructions'}}));
 }
 const methods={
  async create(params){
   const sessionId=requestString(params,'sessionId'),route=companion().routeFor(params,sessionId);
   await companion().evictBefore(sessionId);
   const existing=handles.get(sessionId);if(existing)return {sessionId,header:existing.agent.session.header};
   const cwd=requestString(params,'cwd'),requested=optionalObject(params.model)??services.agentDefaultModel?.currentSelection?.();
   const selection=requested?await resolveSelection(requested):undefined,permissionPreset=optionalString(params.permissionPreset);
   const handle=await open({sessionId,cwd,selection,requestedPreset:optionalString(params.agentPreset),resume:false,route});
   handles.set(String(handle.agent.id),handle);
   if(permissionPreset){
    try{
     if(!services.permissionPresets)throw bridgeError('unsupported','Selected DSH Profile does not publish Permission Presets');
     services.permissionPresets.set(handle.agent.session,permissionPreset);await ctx.sessions.flush(handle.agent.session);
    }catch(error){await handle.dispose();handles.delete(String(handle.agent.id));throw error;}
   }
   await ctx.sessions.flush(handle.agent.session);
   return {sessionId:String(handle.agent.id),header:handle.agent.session.header};
  },
  async resume(params){
   const sessionId=requestString(params,'sessionId'),route=companion().routeFor(params,sessionId);
   await companion().evictBefore(sessionId);
   const existing=handles.get(sessionId);if(existing)return {sessionId,header:existing.agent.session.header};
   const inspection=await inspectNativeSession(ctx.sessionPersistence,sessionId);
   const requestedPreset=resolveSessionPreset?resolveSessionPreset({header:inspection.meta,events:inspection.events})
    :optionalString([...inspection.events].reverse().find(event=>event.type==='agent-preset/selected')?.data?.agentPreset)??optionalString(inspection.meta?.agentPreset);
   const handle=await open({sessionId,selection:undefined,requestedPreset,resume:true,route});
   handles.set(String(handle.agent.id),handle);
   return {sessionId:String(handle.agent.id),header:handle.agent.session.header};
  },
  async prompt(params){
   const handle=owned(params),inputId=requestString(params,'inputId'),business=companion();
   const accepted=business.acceptedInput(handle.agent,inputId);if(accepted)return {inputId,messageId:accepted};
   const text=requestString(params,'text',true),imageRefs=await imagesFor(handle,params),skillName=optionalString(params.skillName);
   if(skillName)await injectSkill(handle,skillName);
   const voiceSource=business.voiceInputSource(handle.agent,inputId,params.whalenestSource);
   const content=await business.preparePrompt(String(handle.agent.id),inputId,text,[
    {type:'text',text},...imageRefs.map(attachment=>({type:'image',attachment})),
   ]);
   const message=createUserMessage({content,source:{kind:'user',connectInputId:inputId,...voiceSource,
    ...(['client','clawchat'].includes(params.inputOrigin)?{connectInputOrigin:params.inputOrigin}:{}),
    ...(optionalString(params.clawchatTurnContext)?{clawchatTurnContext:params.clawchatTurnContext}:{})}});
   if(params.mode==='steer')handle.agent.steer(message);else handle.agent.followup(message);
   await ctx.sessions.flush(handle.agent.session);
   return {inputId,messageId:String(message.id)};
  },
  async cancel(params){
   const handle=owned(params);handle.agent.cancel({kind:'user'},{keepInbox:true});
   await handle.agent.whenIdle();await ctx.sessions.flush(handle.agent.session);
   const terminal=nativeSessionEvents(handle.agent.session).reverse().find(event=>event.type==='turn/end');
   return {reason:terminal?.data?.reason?.kind??null,idle:handle.agent.status==='idle'};
  },
  async selectModel(params){
   const handle=owned(params),selection=await resolveSelection(optionalObject(params.model));
   const hasImage=[...handle.agent.inbox.nextTurn,...handle.agent.inbox.nextStep].some(message=>contentHasImage(message.content))
    ||handle.agent.session.deriveMessages().some(message=>contentHasImage(message.content));
   if(hasImage){
    const model=await ctx.llm.resolveModelInfo(selection.provider,selection.model);
    if(!model.inputModalities?.includes('image'))throw bridgeError('model-unavailable',`DSH model "${selection.model}" does not accept this Session's image history`);
   }
   if(typeof handle.agent.model?.select==='function')handle.agent.model.select(selection);else handle.modelSelection.current=selection;
   await ctx.sessions.flush(handle.agent.session);return {...selection};
  },
  async history(params){
   const id=requestString(params,'sessionId'),handle=handles.get(id);
   const snapshot=handle?{meta:handle.agent.session.header,events:nativeSessionEvents(handle.agent.session)}
    :await inspectNativeSession(ctx.sessionPersistence,id);
   return {header:snapshot.meta,...pageHistoryEvents([...snapshot.events],params)};
  },
  async discover(){
   const headers=await ctx.sessionPersistence.list(),archived=new Set(services.workspaceRegistry?.archivedSessionIds.map(String)??[]);
   return await Promise.all(headers.map(async snapshot=>{
    const header=snapshot.header??snapshot;let events=[];
    try{events=[...(await inspectNativeSession(ctx.sessionPersistence,header.id)).events];}catch{/* Report corrupt histories on explicit read. */}
    const title=events.findLast(event=>event.type==='session/title')?.data?.title;
    return {header,owned:handles.has(String(header.id)),archived:archived.has(String(header.id)),
     title:typeof title==='string'?title:null,updatedAt:events.at(-1)?.time??header.createdAt};
   }));
  },
  async archive(params){
   await companion().settled();
   const sessionId=requestString(params,'sessionId'),registry=services.workspaceRegistry;
   if(!registry)throw bridgeError('unsupported','Selected DSH Profile does not publish Workspace archive services');
   if(registry.archivedSessionIds.map(String).includes(sessionId))return {archived:true};
   const handle=handles.get(sessionId);
   if(handle?.agent.status!=='idle')throw bridgeError('conflict','An active DSH Session cannot be archived');
   if(handle){await handle.dispose();handles.delete(sessionId);}
   await registry.archiveSession(sessionId);return {archived:true};
  },
  async models(){
   const defaults=services.agentDefaultModel?.currentSelection?.(),{attachments}=services;
   const groups=await Promise.all(ctx.llm.listProviders().map(async provider=>{
    const models=await ctx.llm.listModels(provider.id);
    return await Promise.all(models.map(async model=>{
     let resolved;try{resolved=await ctx.llm.resolveModelInfo(provider.id,model.id);}catch{resolved=model;}
     return {provider:provider.id,id:model.id,name:model.name,...(model.description?{description:model.description}:{}),
      ...(defaults?.provider===provider.id&&defaults.model===model.id?{isDefault:true}:{}),
      ...(resolved.inputModalities?{inputModalities:[...resolved.inputModalities]}:{}),
      ...(resolved.context?.contextWindow?{contextWindow:resolved.context.contextWindow}:{}),
      ...(resolved.defaultMaxTokens?{defaultMaxTokens:resolved.defaultMaxTokens}:{}),
      ...(attachments&&resolved.inputModalities?.includes('image')?{imageLimits:{maxImageBytes:attachments.imageLimits.maxImageBytes,
       maxImagesPerMessage:attachments.imageLimits.maxImagesPerMessage,maxMessageImageBytes:attachments.imageLimits.maxMessageImageBytes,
       mediaTypes:[...attachments.imageLimits.mediaTypes]}}:{}),
      ...(resolved.reasoning?{reasoning:{efforts:resolved.reasoning.efforts.map(effort=>({...effort})),
       ...(resolved.reasoning.defaultEffort?{defaultEffort:resolved.reasoning.defaultEffort}:{})}}:{}),
     };
    }));
   }));return groups.flat();
  },
  async presets(){
   const presets=ctx.root.get('agentPresets');if(!presets)throw bridgeError('unsupported','Selected DSH Profile does not publish Agent Presets');
   return {defaultId:presets.defaultId,presets:(await presets.list()).filter(preset=>!preset.id.startsWith('aurabot-')).map(preset=>({id:preset.id,
    ...(preset.name?{name:preset.name}:{}),...(preset.description?{description:preset.description}:{}),...(preset.broken?{broken:preset.broken}:{})}))};
  },
  async permissionPresets(){
   const presets=services.permissionPresets;if(!presets)throw bridgeError('unsupported','Selected DSH Profile does not publish Permission Presets');
   return {defaultId:presets.defaultPreset,presets:presets.names.map(id=>{const option=presets.optionOf(id);
    return {id,name:option.name,...(option.description?{description:option.description}:{})};})};
  },
  async skills(params){
   const skills=ctx.root.get('skills');if(!skills)throw bridgeError('unsupported','Selected DSH Profile does not publish Skills');
   const cwd=requestString(params,'cwd'),id=optionalString(params.sessionId),handle=id?handles.get(id):undefined;
   return (await skills.list({cwd,...(handle?{scope:handle.agent}:{})})).map(skill=>({name:skill.name,description:skill.description,userInvocable:skill.invocation.userInvocable}));
  },
  async commands(params){
   const commands=ctx.root.get('commands');if(!commands)throw bridgeError('unsupported','Selected DSH Profile does not publish Commands');
   return commands.list(owned(params).agent).map(command=>({name:command.name,description:command.description}));
  },
  async command(params){
   const commands=ctx.root.get('commands');if(!commands)throw bridgeError('unsupported','Selected DSH Profile does not publish Commands');
   const handle=owned(params),controller=new AbortController();
   const execution=await commands.execute(handle.agent,requestString(params,'line'),[],controller.signal);
   if(!execution)throw bridgeError('command-not-found','DSH Command is no longer available');
   await ctx.sessions.flush(handle.agent.session);return execution;
  },
 };
 return {handles,methods,captureServices,closeAll,
  capabilities(questions){return {promptQueue:true,promptSteer:true,cancel:true,durableReceipt:true,history:true,
   approvals:Boolean(ctx.root.get('approval')),questions,models:true,presets:Boolean(services.agentPresets),
   permissionPresets:Boolean(services.permissionPresets),skills:Boolean(ctx.root.get('skills')&&renderSkillContent),
   commands:Boolean(ctx.root.get('commands')),imageInput:Boolean(services.attachments),localProducedFilePresentation:false,
   portableArtifactOutput:false,archive:Boolean(services.workspaceRegistry),restore:false,delete:false,crossProcessSessionOwnership:false};},
 };
}
