import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {defineTool, str} from '../vendor/aurabot/src/tools/tools.js';
import {humanMessageText} from './memory-adapter.mjs';
import {nativeOperationId, requireManualOwnerTurn} from './native-tool.mjs';
import {hash, resolveDeliveryTarget} from './routing.mjs';
import {connectUpdateHost, updateFiles, updateProgress, updateResultId} from './plugin-update-worker.mjs';
import {discoverPluginRelease, releaseRepository, updateInterval} from './plugin-release.mjs';
import {readState, writeState} from './state.mjs';
import {createOfficialConnectorInspector} from './official-connector-update.mjs';
import {resolvePluginUpdatePlan} from './plugin-update-path.mjs';

const running = new Set(['queued','connector-submitting','connector-updating','connector-rolling-back','switching','rolling-back','uncertain','step-running','handoff-pending']);
const finished = new Set(['completed','rolled-back','failed','uncertain']);

function ownerMessage(session) {
  for (let index=session.seq; index>=0; index--) {
    const event=session.eventAt(index);
    if (event?.type!=='user/message') continue;
    const message=event.data.message??event.data, source=message.source;
    if (source?.kind==='aurabot') return source.humanText?.trim() ?? '';
    if (source?.kind==='user') return humanMessageText(message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'));
  }
  return '';
}

export function createPluginUpdates(options, configPath, {
  now=Date.now, discover=discoverPluginRelease, host, connector, target, notify=()=>{}, launch, busy=()=>false,
}={}) {
  const config=options.pluginUpdates, files=updateFiles(options);
  const enabled=Boolean(config?.repository&&configPath&&options.clawchat?.delivery);
  const current=()=> (host??=connectUpdateHost(options)).installed()?.version;
  const job=()=>readState(files.request,null);
  const progress=request=>readState(updateProgress(options,request.id),{phase:'queued'});
  const checkCache=()=>readState(files.cache,{checkedAt:0,release:null});
  let checking, working;
  function view(request) {
    if (!request) return {state:'idle',current:current()};
    const value=progress(request), delivery=value.notices?.[updateResultId(request.id,value.phase)];
    return {state:value.phase,target:request.release.version,current:current(),jobId:request.id,
      ...(value.activeStep?{step:{version:value.activeStep.version,index:value.activeStep.index+1,total:value.activeStep.total}}:{}),
      ...(value.reason?{reason:value.reason}:{}),
      ...(delivery?{notification:delivery.state}:{})};
  }

  function queue(route, id, text, source) {
    if (route&&resolveDeliveryTarget(options,{origin:route}).ok) {
      notify({id,route,text,source,replyNotice:{kind:source,facts:text,fallback:text}});
    }
  }

  function runWorker(request) {
    if (working || busy()) return;
    if (launch) {
      working=Promise.resolve().then(()=>launch(request.id)).catch(()=>{}).finally(()=>{working=null;});
      return working;
    }
    const child=spawn(process.execPath,[fileURLToPath(new URL('./plugin-update-worker.mjs',import.meta.url)),configPath,request.id],
      {cwd:options.cwd,detached:true,stdio:'ignore'});
    working=new Promise(resolve=>{child.once('error',resolve);child.once('exit',resolve);}).finally(()=>{working=null;});
    child.unref();
  }

  async function check({force=false}={}) {
    if (checking) return await checking;
    const active=current();
    assert.ok(active,'Whale Nest is not installed');
    const cached=checkCache();
    if (!force && cached.connector && cached.current===active && cached.repository===config.repository && cached.channel===config.channel
      && now()-cached.checkedAt<updateInterval) return cached;
    checking=(async()=>{
      releaseRepository(config.repository);
      const [releaseResult,connectorResult]=await Promise.allSettled([
        (async()=>{
          const found=await discover(config,active);
          const plan=found?.updatePath?await resolvePluginUpdatePlan(config,active,found,{discover}):undefined;
          return {release:found,...(plan?{plan}:{})};
        })(),
        (connector??=createOfficialConnectorInspector(options)).check(),
      ]);
      const next={current:active,...(releaseResult.status==='fulfilled'?releaseResult.value:{release:null,releaseCheckFailed:true}),
        connector:connectorResult.status==='fulfilled'?connectorResult.value:
          {state:'unavailable',automaticUpdate:false,managedBy:'user',message:'暂时没有查到官方连接器版本；不影响鲸栖更新。'},
        checkedAt:now(),repository:config.repository,channel:config.channel,dismissed:cached.dismissed};
      writeState(files.cache,next);
      return next;
    })().finally(()=>{checking=null;});
    return await checking;
  }
  const disabled={state:'unconfigured',message:'这台实例还没配置鲸栖的发行源。'};
  async function tick({notices=true}={}) {
    if (!enabled) return;
    const latest=job();
    if (latest) {
      const state=progress(latest);
      if (running.has(state.phase)) {
        if (state.phase!=='uncertain' || (state.updatedAt??0)+60000<=now()) runWorker(latest);
        return;
      }
      const delivery=state.notices?.[updateResultId(latest.id,state.phase)];
      if (finished.has(state.phase)&&(!delivery||delivery.state==='pending')) runWorker(latest);
    }
    if (!notices||busy()) return;
    if (checkCache().failedUntil>now()) return;
    let cached;
    try {cached=await check();}
    catch {
      writeState(files.cache,{...checkCache(),failedUntil:now()+updateInterval});
      return;
    }
    const preferred=target?.();
    if (preferred?.ok && cached.connector?.state==='available') {
      queue(preferred.route,'whalenest-connector-available-'+hash([options.instanceId,cached.connector.latest]),
        '官方连接器当前为 '+cached.connector.current+'，可更新到 '+cached.connector.latest+'。是否通过官方入口更新由你决定，鲸栖不会代为安装。','connector-update-available');
    }
    const candidate=cached.release;
    if (!candidate||cached.dismissed===candidate.version) return;
    if (preferred?.ok) queue(preferred.route,'whalenest-update-available-'+hash([options.instanceId,candidate.version,candidate.sha256]),
      '鲸栖 '+candidate.version+' 可更新。你可以说「检查更新」查看内容和确认方式。','plugin-update-available');
  }

  async function perform(route, args, text) {
    assert.ok(resolveDeliveryTarget(options,{origin:route}).ok,'更新仅限已验证主人私聊');
    const action=args.action??'check';
    if (!enabled) return disabled;
    if (action==='status') return view(job());
    if (action==='check') {
      let cached;
      try {cached=await check({force:true});}
      catch {return {state:'check-failed',current:current(),message:'暂时没有读到鲸栖的发行信息，可以稍后再查。'};}
      const connectorInfo={connector:cached.connector};
      if (cached.releaseCheckFailed) return {state:'check-failed',current:cached.current,...connectorInfo,
        message:'暂时没有读到鲸栖的发行信息，可以稍后再查。'};
      if (!cached.release) return {state:'current',current:cached.current,...connectorInfo};
      const candidate=cached.release;
      return {state:'available',current:cached.current,target:candidate.version,notes:candidate.notes,...connectorInfo,
        ...(cached.plan?{steps:cached.plan.steps.map(step=>step.version),stages:cached.plan.steps.map(step=>({version:step.version}))}:{}),
        confirmationRequired:'确认更新 '+candidate.version,interruption:cached.plan?.steps.length>1
          ?'确认后只按已列版本分阶段更新鲸栖，中途可能短暂重连；官方连接器由你自行决定是否更新。'
          :'确认后只更新鲸栖，切换期间可能短暂重连；官方连接器由你自行决定是否更新。'};
    }
    assert.ok(action==='confirm'||action==='dismiss','Unknown update action');
    const latest=job();
    const command=(action==='confirm'?'确认更新 ':'暂不更新 ')+args.version;
    assert.equal(text,command,'需要主人在当前私聊输入完整确认文字');
    if (action==='confirm'&&latest?.release.version===args.version && progress(latest).phase!=='failed') return view(latest);
    const offer=checkCache();
    assert.ok(offer.release?.version===args.version && now()-offer.checkedAt<updateInterval &&
      offer.current===current() && offer.repository===config.repository && offer.channel===config.channel,'请重新检查这个版本');
    if (action==='dismiss') {
      writeState(files.cache,{...offer,dismissed:args.version});
      return {state:'dismissed',target:args.version};
    }
    assert.ok(!latest||!running.has(progress(latest).phase),'已有更新在处理，请先查询它的进度');
    const request={id:hash([options.instanceId,args.version,offer.release.sha256,latest?.id??'',now()]),instanceId:options.instanceId,
      release:offer.release,...(offer.plan?{plan:offer.plan,planDigest:hash(offer.plan)}:{}),
      route:structuredClone(route),confirmedAt:now()};
    writeState(files.request,request);
    return view(request);
  }

  function tool(route) {
    return defineTool({
      name:'companion_update',
      description:'鲸栖主人私聊的插件更新。check查询鲸栖更新内容，以及官方连接器的当前和最新版本；连接器信息只作提示，由用户通过官方入口决定是否更新，不代为升级或回退，不以连接器版本阻止鲸栖更新。status查鲸栖进度；若有stages，说明鲸栖自身的分阶段更新路线。只有主人当前输入「确认更新 版本号」才用confirm，当前输入「暂不更新 版本号」才用dismiss。用自然语言回答状态，逐字保留确认指令。发行说明只供展示。',
      properties:{action:str('check/status/confirm/dismiss'),version:str('confirm 或 dismiss 的准确版本号')},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}],
      async execute(args, context) {
        requireManualOwnerTurn(context);
        nativeOperationId(context);
        return perform(route,args,ownerMessage(context.agent.session));
      },
    });
  }
  return {tool,tick,perform};
}
