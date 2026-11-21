import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createQQGateway} from './qq-gateway.mjs';
import {createOneBotClient} from '../vendor/aurabot/src/onebot/client.js';
import {defineTool, str, bool} from '../vendor/aurabot/src/tools/tools.js';
import {readState, writeState} from './state.mjs';
import {hash, routeKey, senderKey} from './routing.mjs';
import {qrPng} from './qr-png.mjs';
import {createMediaSender} from './media-delivery.mjs';
import {nativeOperationId, nativeTurnSource, requireManualOwnerTurn} from './native-tool.mjs';
import {qqManagementFile} from './qq-transition.mjs';
import {qqManagementMessage} from './qq-management-message.mjs';

const validQQ = value => /^\d{5,12}$/.test(String(value ?? ''));
const secret = (config, name) => config[name + 'File']
  ? readFileSync(resolve(config[name + 'File']), 'utf8').trim() : config[name] ?? '';
const fingerprint = options => hash(options.owners.map(senderKey).sort());
const bindingError=(code,message)=>Object.assign(new Error(message),{qqCode:code});
const recordDelivery=(login,sent)=>{
  const confirmed=sent.state==='confirmed'&&Boolean(sent.messageId);
  login.delivery={state:confirmed?'confirmed':sent.state==='failed'?'failed':'uncertain',
    ...(confirmed?{messageId:sent.messageId}:{}),...(sent.requestId?{requestId:sent.requestId}:{})};
  return confirmed?'delivered':sent.state==='failed'?'send-failed':'unconfirmed';
};

/** One login/link controller, independent of the two message adapters.
 * Long-lived gateway credentials are read from operator configuration only. */
export function createQQConnection(options, {
  configPath, getNative, queueNotification, fetchImpl, now = Date.now,
  mediaSender, requestReload, makeOneBot = createOneBotClient,
} = {}) {
  const file = qqManagementFile(options), ownerRoute = options.clawchat?.route;
  let client, proofClient, timer, closed = false, pollQueued = false, tail = Promise.resolve();
  let connectionWatch,connectionSince;
  const initial = {schema: 1, instanceId: options.instanceId};
  const read = () => {
    const state = readState(file, initial);
    assert.equal(state.schema, 1, 'QQ管理数据版本不受支持');
    assert.equal(state.instanceId, options.instanceId, 'QQ管理数据属于其他实例');
    return state;
  };
  const save = state => writeState(file, state);
  const exclusive = fn => {
    const next = tail.then(() => { assert.ok(!closed, 'QQ连接管理已停止'); return fn(); });
    tail = next.catch(() => {}); return next;
  };
  const binding = () => options.owners.find(owner => owner.channel === 'qq') ?? null;
  const senderFor = actor => mediaSender?.(actor)??createMediaSender(options,actor.route,{sessionId:actor.sessionId});
  function gateway() {
    const config = options.qq?.gateway;
    assert.ok(config, 'QQ网关尚未由平台配置，当前ClawChat聊天继续可用');
    return client ??= createQQGateway({...config, token: secret(config, 'token')}, {fetchImpl, now});
  }
  function onebot() {
    const value = options.qq?.gateway?.onebot;
    assert.ok(value && typeof value.wsUrl === 'string', '平台尚未配置OneBot消息接口');
    for (const [key, protocols] of [['wsUrl', ['ws:', 'wss:']], ['httpUrl', ['http:', 'https:']]]) {
      if (!value[key]) continue;
      const url = new URL(value[key]);
      assert.ok(protocols.includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
        'OneBot地址必须由平台配置，凭据单独保存');
    }
    const token = secret(value, 'token');
    return {wsUrl: value.wsUrl, httpUrl: value.httpUrl ?? '',
      httpToken: secret(value, 'httpToken') || token, wsToken: secret(value, 'wsToken') || token};
  }
  function view(state = read(), liveLogin) {
    const linked = binding(), cfg = getNative?.()?.getConfig?.();
    const checked=getNative?.()?.qqConnectionState?.();
    const transport=getNative?.()?.onebot?.state??'stopped';
    const verified=options.qq?.enabled===true&&cfg?.enabled===true&&checked?.verified===true;
    const historicalOnline=Boolean(linked&&!verified&&state.login?.state==='online');
    const loginPhase=liveLogin?.state??(historicalOnline?'unverified':state.login?.state);
    return {ok: true, configured: Boolean(options.qq?.gateway),
      binding: linked ? {botQQ: linked.account, ownerQQ: linked.sender} : null,
      connection: options.qq?.enabled && cfg?.enabled ? checked?.wrongAccount ? 'wrong-account'
        : transport==='connected'&&!checked?.verified ? 'verifying' : transport : 'disabled',
      verified,
      ...(loginPhase ? {login: {id: state.login?.id, state: loginPhase, expiresAt: state.login?.expiresAt,
        ...(historicalOnline&&loginPhase!=='online'?{lastKnownState:'online'}:{}),
        ...(liveLogin?.botQQ||state.login?.botQQ ? {botQQ: liveLogin?.botQQ??state.login.botQQ} : {}),
        ...(!historicalOnline&&state.login?.delivery ? {delivery: state.login.delivery} : {}),
        ...(state.login?.problem ? {problem:state.login.problem}:{}),...(state.login?.failureStage?{failureStage:state.login.failureStage}:{}),
        ...(state.login?.attentionDelivery?{attentionDelivery:state.login.attentionDelivery}:{})}} : {}),
      ...(state.challenge ? {association: {id: state.challenge.id, state: state.challenge.state,
        botQQ: state.challenge.botQQ, ownerQQ: state.challenge.ownerQQ, expiresAt: state.challenge.expiresAt,
        remainingSeconds:Math.max(0,Math.ceil(((state.challenge.expiresAt??now())-now())/1000)),
        ...(state.challenge.problem?{problem:state.challenge.problem}:{})}} : {}),
      ...(state.transition ? {change: {id: state.transition.id, action: state.transition.action, state: state.transition.state,
        reload: state.transition.reloadState ?? 'not-requested'}} : {})};
  }
  function assertActor(actor) {
    assert.ok(ownerRoute && actor?.route?.channel === 'clawchat' && actor.route.kind === 'private'
      && senderKey(actor.route) === senderKey(ownerRoute) && routeKey(actor.route) === routeKey(ownerRoute)
      && options.owners.some(owner => senderKey(owner) === senderKey(actor.route)), 'QQ账号管理仅允许当前ClawChat主人私聊');
    assert.ok(actor.sessionId && actor.operationId, '缺少可信QQ管理操作标识');
  }
  function clearImage(login) {
    if (login?.imagePath && existsSync(login.imagePath)) unlinkSync(login.imagePath);
  }
  async function notice(login, text, phase = login.state) {
    if (!queueNotification || login.notifiedStates?.includes(phase)
      || login.notified&&!login.notifiedStates) return;
    await queueNotification({id: 'whalenest-qq-notice-' + hash([login.id, phase]),
      route: ownerRoute, text,replyNotice:{kind:"qq-login:"+phase,fallback:text}});
    const latest = read();
    if (latest.login?.id === login.id) {
      latest.login.notifiedStates=[...new Set([...(latest.login.notifiedStates??[]),phase])];
      if(latest.login.state===phase)latest.login.notified=true;
      save(latest);
    }
  }
  function noticeOnline(login) {
    if(binding()?.account!==login.botQQ)
      return notice(login,'我的QQ已登录，账号是 '+login.botQQ+'。扫码登录已完成；首次使用还需关联主人的QQ号。');
    if(!Number.isFinite(login.gatewayVerifiedAt))return;
    const current=view();
    if(current.verified&&current.connection==='connected')
      return notice(login,'QQ聊天已恢复。用原来关联的QQ私聊我即可。','chat-ready');
    if(current.connection==='disabled')
      return notice(login,'原来的机器人QQ已重新登录，主人关联仍有效。需要恢复QQ聊天时可以让我继续连接。');
    return notice(login,'原来的机器人QQ已重新登录，主人关联仍有效。我会继续核实QQ聊天通道。');
  }
  async function attentionImage(login, image) {
    if(!image||!login.sessionId||login.attentionDelivery)return;
    const directory=join(options.dataDir,'media/outgoing/qq-login');mkdirSync(directory,{recursive:true,mode:0o700});
    const filePath=join(directory,login.id+'-attention.png');writeFileSync(filePath,image,{mode:0o600});
    const actor={route:ownerRoute,sessionId:login.sessionId};
    const sender=senderFor(actor);
    const latest=read();if(latest.login?.id!==login.id)return;
    // Persist the attempt before submitting: an interrupted upload is not retried
    // as a new message. Its original media receipt remains the recovery source.
    latest.login.attentionDelivery={state:'uncertain'};save(latest);
    try {
      const sent=await sender.send({requestId:login.id+':attention',filePath});
      const after=read();if(after.login?.id===login.id){after.login.attentionDelivery={state:sent.state,...(sent.messageId?{messageId:sent.messageId}:{}),...(sent.requestId?{requestId:sent.requestId}:{})};save(after);}
    } catch {}
  }
  async function poll() {
    const state = read(), login = state.login;
    const watched=['waiting','scanned','offline','restarting','reconnecting','attention-required','security-restricted','expired','timed-out','failed','uncertain'];
    if(login?.state==='online') {
      if(view(state).login.state==='online')await noticeOnline(login);
      return view();
    }
    if (!login || !watched.includes(login.state)||now()>(login.observeUntil??login.expiresAt+5*60_000)) return view(state);
    if (login.lastPollAt && now() - login.lastPollAt < 3000) return view(state);
    login.lastPollAt = now(); save(state);
    let result;
    try {result=await gateway().status();}
    catch {
      const latest=read();if(latest.login?.id!==login.id)return view(latest);
      latest.login.gatewayErrorSince??=now();
      if(latest.login.state!=='reconnecting')latest.login.notified=false;
      latest.login.state='reconnecting';latest.login.problem='QQ网关暂时无法核实登录，正在自动重试。';save(latest);
      if(now()-latest.login.gatewayErrorSince>=15000)await notice(latest.login,'我暂时还确认不了QQ有没有登上，会继续检查。你可以照常在这里聊天。');
      return view();
    }
    const latest = read();
    if (latest.login?.id !== login.id) return view(latest);
    const phase=['waiting','offline','restarting','reconnecting'].includes(result.state)&&now()>=login.expiresAt?'timed-out':result.state;
    if(latest.login.state!==phase)latest.login.notified=false;
    delete latest.login.gatewayErrorSince;delete latest.login.problem;
    Object.assign(latest.login, {state: phase, ...(result.botQQ ? {botQQ: result.botQQ} : {})});
    if (result.state === 'online' && login.expectedBotQQ && result.botQQ !== login.expectedBotQQ)
      latest.login.state = 'wrong-account';
    if (!['waiting','scanned','restarting','reconnecting'].includes(latest.login.state)) clearImage(latest.login);
    save(latest);
    if (latest.login.state === 'online') {
      delete latest.login.failureStage;
      latest.login.gatewayVerifiedAt=now();save(latest);
      clearImage(latest.login);
      await noticeOnline(latest.login);
    } else if (latest.login.state === 'wrong-account') {
      clearImage(latest.login);
      await notice(latest.login, '本次登录号与指定机器人号不一致，未启用QQ通道，请检查扫码账号。');
    } else if(latest.login.state==='scanned') {
      await notice(latest.login,'QQ已识别扫码，正在等待手机QQ允许登录；请完成手机确认，我会自动核验结果。无需重新扫码。');
    } else if(latest.login.state==='security-restricted') {
      await notice(latest.login,'QQ提示账号近期存在安全风险、部分功能受限，本次登录未完成。请在最新版手机QQ按提示恢复账号使用，再说“重新连接QQ”；我会清理旧失败页面并重新准备二维码，不会自动反复尝试。');
    } else if(latest.login.state==='timed-out') {
      await notice(latest.login,'本次QQ登录等待已超时，尚未核实成功；这不代表二维码一定过期。手机仍在验证时我会继续核验，需要重新开始请说“刷新QQ登录二维码”。');
    } else if(latest.login.state==='expired') {
      await notice(latest.login,'QQ登录二维码已过期，尚未核实登录成功。需要继续时请说“刷新QQ登录二维码”；如果手机仍在验证，我会继续自动核验。');
    } else if(latest.login.state==='attention-required') {
      await attentionImage(latest.login,result.attentionImage);
      const delivery=read().login?.attentionDelivery;
      const confirmed=delivery?.state==='confirmed'&&delivery.messageId;
      const imageStatus=confirmed?'已发送当前 QQ 登录画面。':'';
      await notice(latest.login,'我暂时无法确认 QQ 停在哪一步。'+imageStatus+'如果手机 QQ 仍在确认，可以继续完成，我会核实结果。');
    } else if(latest.login.state==='failed') {
      await notice(latest.login,'QQ登录还没完成。你可以先看看手机QQ的提示，或者让我刷新二维码。');
    }
    return view(read(),{...result,state:latest.login.state});
  }
  async function login(actor, args, observed) {
    const state = read(), id = 'whalenest-qq-login-' + hash(actor.operationId);
    if (state.login?.id === id) return view(state);
    if(!options.qq?.gateway)return {...view(state),ok:false,errorCode:'gateway-not-configured',detail:'当前实例还未开通QQ网关，ClawChat可以照常使用。'};
    const status = observed??await gateway().status().catch(()=>null);
    if(!status)return {...view(state),ok:false,errorCode:'gateway-unavailable',detail:'暂时无法核实QQ登录状态，请稍后重试。'};
    const linked=binding(), expected=String(args.botQQ??linked?.account??'');
    assert.ok(!expected||validQQ(expected),'机器人QQ号格式不正确');
    if (status.state === 'online') {
      const phase=expected&&status.botQQ!==expected?'wrong-account':'online';
      if(state.login?.state===phase&&state.login.botQQ===status.botQQ)return view(state,{...status,state:phase});
      state.login = {id,state:phase,botQQ:status.botQQ,expiresAt:now(),actor:actor.route};
      save(state);
      return view(state,{...status,state:state.login.state});
    }
    const refreshText=actor.text??'';
    const explicitRefresh=/刷新|重新扫码|换.{0,5}(二维码|扫码)/.test(refreshText)
      &&!/(别|不要|不用|不必|不需要|先不|无需).{0,8}(刷新|重新扫码|换)/.test(refreshText);
    const forceNew=args.action==='refresh_login'&&(status.state!=='scanned'||explicitRefresh);
    const previous=state.login;
    const freshAttempt={id,state:'uncertain',expiresAt:now()+5*60_000,observeUntil:now()+10*60_000,
      actor:actor.route,sessionId:actor.sessionId,notifiedStates:[],...(expected?{expectedBotQQ:expected}:{})};
    if(status.state==='scanned'&&!forceNew) {
      state.login=previous&&!['cancelled','security-restricted','failed','wrong-account','online'].includes(previous.state)
        ? previous : freshAttempt;
      state.login.state='scanned';
      if(expected&&!state.login.expectedBotQQ)state.login.expectedBotQQ=expected;
      if(now()>=(state.login.observeUntil??state.login.expiresAt+5*60_000))state.login.observeUntil=freshAttempt.observeUntil;
      clearImage(state.login);save(state);
      return view(state,status);
    }
    if(status.state==='waiting'&&!forceNew&&previous?.state==='waiting'&&now()<previous.expiresAt
      &&(!expected||!previous.expectedBotQQ||expected===previous.expectedBotQQ)) {
      const receipt=previous.delivery;
      if(previous.sessionId&&(receipt?.state==='uncertain'||!receipt&&previous.imagePath)) {
        try {
          const sender=senderFor({route:actor.route,sessionId:previous.sessionId});
          const sent=receipt?.requestId?await sender.check(receipt.requestId):await sender.checkRequest(previous.id);
          recordDelivery(previous,sent);save(state);
        } catch {}
      }
      if(previous.delivery?.state==='confirmed')return {...view(state,status),reused:true};
      if(previous.delivery?.state==='uncertain'||(!previous.delivery&&previous.imagePath))
        return {...view(state,status),ok:false,qrDelivery:'unconfirmed',reused:true};
    }
    clearImage(previous);
    state.login = freshAttempt;
    save(state);
    let result;
    try {result=await gateway().qr({refresh:forceNew});}
    catch {
      const latest=read();
      if(latest.login?.id===id){
        latest.login.state='failed';latest.login.failureStage='qr-preparation';latest.login.delivery={state:'not-submitted'};save(latest);
      }
      return {...view(),ok:false,qrDelivery:'preparation-failed'};
    }
    const latest = read(); assert.equal(latest.login.id, id, 'QQ登录请求已被替换');
    latest.login.state = result.state;
    if(result.state==='online') {
      latest.login.botQQ=result.botQQ;
      if(latest.login.expectedBotQQ&&result.botQQ!==latest.login.expectedBotQQ)latest.login.state='wrong-account';
      else latest.login.gatewayVerifiedAt=now();
    }
    if (result.url || result.image) {
      const directory = join(options.dataDir, 'media/outgoing/qq-login');
      mkdirSync(directory, {recursive: true, mode: 0o700});
      latest.login.imagePath = join(directory, id + '.png');
      writeFileSync(latest.login.imagePath, result.image ?? qrPng(result.url), {mode: 0o600});
      save(latest);
      const sent=await Promise.resolve().then(()=>senderFor(actor).send({requestId:id,filePath:latest.login.imagePath}))
        .catch(()=>({state:'uncertain'}));
      const after = read();
      assert.equal(after.login?.id,id,'QQ登录请求已被替换');
      const qrDelivery=recordDelivery(after.login,sent);
      save(after);
      return {...view(), ok: qrDelivery === 'delivered', qrDelivery, reused: result.reused === true};
    }
    if (result.state==='attention-required') {
      latest.login.failureStage='qr-preparation';
      latest.login.delivery={state:'not-submitted'};
      save(latest);
      return {...view(latest),ok:false,qrDelivery:'preparation-failed'};
    }
    save(latest);
    return view(latest);
  }
  function stopProof() { proofClient?.stop(); proofClient = undefined; }
  async function bindingNotice(field,record,phase,text) {
    if(!queueNotification||record.notifiedStates?.includes(phase))return;
    const commands=field==='challenge'&&phase==='verified'?['确认关联 '+record.ownerQQ]:[];
    const facts=commands.length?'QQ身份验证通过。还剩 '+Math.max(0,Math.ceil((record.expiresAt-now())/1000))+' 秒，请主人回当前对话发送程序附带的确认口令。':text;
    await queueNotification({id:'whalenest-qq-binding-'+hash([record.id,phase]),route:ownerRoute,text,
      ...(commands.length?{noticeDeadline:record.expiresAt}:{}),replyNotice:{kind:'qq-binding:'+phase,fallback:text,facts,commands}});
    const latest=read();if(latest[field]?.id!==record.id)return;
    latest[field].notifiedStates=[...new Set([...(latest[field].notifiedStates??[]),phase])];save(latest);
  }
  async function pollBinding() {
    let state=read(),proof=state.challenge;
    if(proof&&['waiting','verified'].includes(proof.state)&&now()>=proof.expiresAt) {
      proof.state='expired';delete proof.codeHash;save(state);stopProof();
    }
    if(proof&&['verified','expired','interrupted'].includes(proof.state))
      await bindingNotice('challenge',proof,proof.state,qqManagementMessage({association:view().association}));
    if(proof&&['preparing','waiting','verified'].includes(proof.state))return;
    state=read();const job=state.transition;
    if(!job||!['confirmed','failed'].includes(job.state))return;
    if(job.state==='failed') {
      await bindingNotice('transition',job,'failed','QQ设置未能完成应用。ClawChat和原有数据已保留，请查询QQ状态后重试。');return;
    }
    if(!['link','connect'].includes(job.action)) {
      await bindingNotice('transition',job,job.action,job.action==='unlink'?'QQ主人关联已解除，QQ聊天已停用。ClawChat和原有数据保留。':'QQ聊天已断开，主人关联和原有数据保留。ClawChat可以继续使用。');return;
    }
    const current=view(state),native=getNative?.();
    if(current.binding?.botQQ!==job.botQQ||current.binding?.ownerQQ!==job.ownerQQ)return;
    if(connectionWatch!==job.id){connectionWatch=job.id;connectionSince=now();}
    if(current.verified&&current.connection==='connected') {
      job.reloadState='applied';save(state);
      await bindingNotice('transition',job,'connected',qqManagementMessage(current));return;
    }
    const elapsed=now()-connectionSince;
    if(native?.qqConnectionState?.()?.wrongAccount) {
      await bindingNotice('transition',job,'wrong-account','QQ当前登录号与绑定账号不一致，聊天通道未启用。请核对大肥鱼的QQ登录账号。');
    } else if(elapsed>=60000) {
      await bindingNotice('transition',job,'connection-timeout','QQ关联已保存，但连接暂未核实成功。我会继续检查；你也可以查询QQ状态，ClawChat仍可使用。');
    } else if(elapsed>=15000) {
      await bindingNotice('transition',job,'connecting','QQ关联已保存，正在连接聊天通道。连接完成后我会自动通知你。');
    }
  }
  function handleEvent(event) {
    const state = read(), challenge = state.challenge;
    if (!challenge || challenge.state !== 'waiting' || now() >= challenge.expiresAt) return false;
    const text = typeof event.message === 'string' ? event.message
      : (Array.isArray(event.message) ? event.message : []).filter(part => part.type === 'text').map(part => part.data?.text ?? '').join('');
    if (event.post_type !== 'message' || event.message_type !== 'private'
      || String(event.self_id) !== challenge.botQQ || String(event.user_id) !== challenge.ownerQQ
      || hash(text.trim()) !== challenge.codeHash) return false;
    challenge.state = 'verified'; challenge.verifiedAt = now(); challenge.messageId = String(event.message_id);
    delete challenge.codeHash; save(state); stopProof();
    void exclusive(pollBinding).catch(()=>{});return true;
  }
  async function beginLink(actor, args) {
    if(!validQQ(args.ownerQQ))throw bindingError('invalid-owner','请提供有效的个人QQ号，也就是你用来和大肥鱼聊天的账号。');
    let online;try{online=await gateway().status();}catch{throw bindingError('gateway-unavailable','暂时无法核实大肥鱼QQ的登录状态，请稍后查询；本次绑定尚未开始。');}
    const botQQ=String(args.botQQ??online.botQQ??'');
    if(!validQQ(botQQ)||botQQ===String(args.ownerQQ))throw bindingError('invalid-accounts','你的个人QQ需要与大肥鱼登录的QQ号不同，请核对两个账号。');
    if(online.state!=='online'||online.botQQ!==botQQ)throw bindingError('not-online','大肥鱼的QQ尚未核实在线，请先完成QQ登录。');
    const prior=read().challenge;
    if(prior?.id==='whalenest-qq-link-'+hash(actor.operationId))return {...view(),verificationReused:true};
    if(binding()?.account===botQQ&&binding()?.sender===String(args.ownerQQ))return view();
    const active=prior&&['waiting','verified'].includes(prior.state)&&now()<prior.expiresAt;
    const regenerate=args.restart===true&&/重新.*(绑定|关联|验证|生成|获取)|换.*验证/.test(actor.text??'');
    if(active&&!regenerate) {
      if(prior.botQQ!==botQQ||prior.ownerQQ!==String(args.ownerQQ))
        throw bindingError('different-binding','另一个QQ绑定验证仍有效。请先取消当前验证，或明确要求重新绑定。');
      return {...view(),verificationReused:true};
    }
    if(args.restart===true&&!regenerate)throw bindingError('restart-confirmation','请明确说“重新生成绑定验证码”，再替换当前验证。');
    stopProof();
    const state=read();
    state.challenge={id:'whalenest-qq-link-'+hash(actor.operationId),state:'preparing',
      actor:actor.route,botQQ,ownerQQ:String(args.ownerQQ),notifiedStates:[]};
    save(state);
    try {
    const native = getNative?.();
    if (native?.onebot?.state === 'connected' && native.getConfig().botQQ === online.botQQ) {
      const info = await native.onebot.call('get_login_info', {}, {timeoutMs: 8000, retries: 0});
      assert.equal(String(info.user_id), online.botQQ, 'OneBot登录号不一致');
    } else {
      await new Promise((resolveReady, reject) => {
        const timeout = setTimeout(() => { stopProof(); reject(new Error('OneBot主人验证连接超时')); }, 10000);
        proofClient = makeOneBot({endpoint: onebot, onEvent: handleEvent,
          log: {info() {}, warn() {}, debug() {}}, retryDelays: [],
          onState(value) {
            if (value !== 'connected') return;
            void proofClient.call('get_login_info', {}, {timeoutMs: 8000, retries: 0}).then(info => {
              assert.equal(String(info.user_id), online.botQQ, 'OneBot登录号不一致');
              clearTimeout(timeout); resolveReady();
            }).catch(() => { clearTimeout(timeout); stopProof(); reject(new Error('OneBot机器人身份未通过核验')); });
          }});
        proofClient.start();
      });
    }
    } catch {
      const latest=read();latest.challenge.state='failed';latest.challenge.problem='QQ验证通道尚未准备好，本次验证未开始。请稍后重新绑定QQ。';save(latest);stopProof();
      throw bindingError('preparation-failed',latest.challenge.problem);
    }
    const code='鲸栖关联 '+randomBytes(16).toString('hex'),latest=read();
    Object.assign(latest.challenge,{state:'waiting',expiresAt:now()+5*60_000,codeHash:hash(code)});save(latest);
    return {...view(),verificationText:code,verificationReplaced:!!prior,
      confirmationRequired:'确认关联 '+args.ownerQQ};
  }
  function stage(actor, action, values = {}) {
    assert.ok(configPath, '当前宿主尚未提供QQ配置重载入口');
    const state = read(), id = 'whalenest-qq-change-' + hash(actor.operationId);
    if (state.transition?.id === id) return view(state);
    assert.ok(!state.transition || ['confirmed', 'failed'].includes(state.transition.state), '已有QQ账号变更待完成，请先查询状态');
    const cfg = getNative().getConfig();
    state.transition = {id, state: 'queued', action, instanceId: options.instanceId, actor: actor.route,
      afterSession: actor.sessionId, configPath: resolve(configPath), beforeFingerprint: fingerprint(options),
      previousOwnerId: cfg.ownerQQ, ...values};
    save(state); stopProof();
    return view(state);
  }
  async function perform(args, actor) {
    assertActor(actor);
    const action = args.action ?? 'status';
    if (action === 'status') {
      await pollBinding();
      const state=read(), saved=view(state);
      if(saved.login?.lastKnownState!=='online'||!saved.configured)return saved;
      const live=await gateway().status().catch(()=>null);
      if(live?.state==='online'&&saved.connection!=='disabled'&&live.botQQ!==saved.binding.botQQ)live.state='wrong-account';
      return live?view(state,live):saved;
    }
    if (action === 'poll') {await pollBinding();return poll();}
    const pending=read().transition;
    if (pending?.id === 'whalenest-qq-change-' + hash(actor.operationId)) return view();
    if(pending&&['queued','applying','data-applied'].includes(pending.state)&&['begin_link','confirm_link'].includes(action))
      return view();
    assert.ok(!pending || !['queued','applying','data-applied'].includes(pending.state), 'QQ账号变更尚未完成，请先查询状态');
    if (['start_login', 'refresh_login'].includes(action)) return login(actor, args);
    if (action === 'cancel_login') {
      const state = read(); if (state.login) { state.login.state = 'cancelled'; clearImage(state.login); }
      if (state.challenge) state.challenge.state = 'cancelled';
      save(state); stopProof();
      return {...view(state), loginCancelled:true, loggedOut:false};
    }
    if (action === 'switch_bot') {
      assert.ok(!getNative?.()?.getConfig?.().enabled, '更换机器人号前请先确认断开QQ，待原宿主重载完成');
      if (args.confirm !== true || !actor.text.includes('确认更换机器人QQ'))
        return {...view(), confirmationRequired: '确认更换机器人QQ'};
      const state = read();
      const switchId='whalenest-qq-switch-'+hash(actor.operationId);
      if (state.switch?.id===switchId) return {...view(),switchState:state.switch.state};
      if (state.challenge) state.challenge.state = 'cancelled';
      clearImage(state.login); state.login = {id: switchId, state: 'uncertain', expiresAt: now()};
      state.switch={id:switchId,state:'submitting'};
      save(state); stopProof();
      try {
        await gateway().logout();
        const result=await login({...actor, operationId: actor.operationId + ':new-login'}, {...args, action: 'start_login'});
        const latest=read();latest.switch.state='completed';save(latest);return result;
      } catch(error) {const latest=read();latest.switch.state='uncertain';save(latest);throw error;}
    }
    if (action === 'begin_link') return beginLink(actor, args);
    if (action === 'confirm_link') {
      const state = read(), proof = state.challenge;
      if(!proof)throw bindingError('not-started','尚未发起QQ绑定验证，请先告诉我你的个人QQ号。');
      if(proof.state==='interrupted')throw bindingError('interrupted','本次绑定验证已中断，请重新绑定QQ获取新的验证文字。');
      if(proof.state==='failed'||proof.state==='preparing')throw bindingError('not-ready',proof.problem??'QQ验证通道尚未准备好，请等待准备结果。');
      if(proof.state==='cancelled')throw bindingError('cancelled','本次绑定验证已取消，请重新发起绑定。');
      if(['expired','waiting','verified'].includes(proof.state)&&now()>=proof.expiresAt) {
        proof.state='expired';delete proof.codeHash;save(state);stopProof();
        throw bindingError('expired','本次绑定验证已过期，旧验证文字已失效。请重新绑定QQ，获取新的验证文字。');
      }
      if(proof.state==='consumed')return view();
      if(proof.state!=='verified')throw bindingError('waiting','尚未收到有效的QQ验证。请先用指定个人QQ私聊大肥鱼，原样发送验证文字，再回这里确认。');
      assert.equal(senderKey(proof.actor), senderKey(actor.route), '关联发起主人不一致');
      if(!(args.confirm===true&&actor.text.includes('确认关联')&&actor.text.includes(proof.ownerQQ)))
        throw bindingError('confirmation-required','请由主人在ClawChat明确发送“确认关联 '+proof.ownerQQ+'”。');
      const online = await gateway().status();
      if(!(online.state==='online'&&online.botQQ===proof.botQQ))throw bindingError('account-changed','大肥鱼QQ的在线状态或账号已改变，本次关联未应用。请核对QQ登录后重新发起绑定。');
      const result = stage(actor, 'link', {botQQ: proof.botQQ, ownerQQ: proof.ownerQQ, onebot: onebot()});
      const latest = read(); latest.challenge.state = 'consumed'; save(latest); return result;
    }
    assert.ok(['connect', 'disconnect', 'unlink'].includes(action), '未知QQ管理操作');
    const linked = binding();
    if (action === 'connect') {
      if(!options.qq?.gateway)return login(actor,args);
      const online=await gateway().status().catch(()=>null);
      if(!online)return {...view(),ok:false,errorCode:'gateway-unavailable',detail:'暂时无法核实QQ登录状态，请稍后重试。'};
      const state=read(), current=view(state,online);
      const expected=linked?.account??args.botQQ??state.login?.expectedBotQQ;
      if(online.state==='online'&&expected&&online.botQQ!==String(expected))
        return {...view(state,{...online,state:'wrong-account'}),ok:false,errorCode:'account-changed',detail:'当前登录的QQ号与预期的机器人不同，请核对扫码账号。'};
      if(online.state==='online'&&!linked) {
        const proof=state.challenge;
        const active=proof?.botQQ===online.botQQ&&['waiting','verified'].includes(proof.state)&&now()<proof.expiresAt;
        return {...current,nextAction:active?'continue-owner-verification':'provide-owner-qq'};
      }
      if(['security-restricted','restarting','reconnecting'].includes(online.state))return current;
      if(online.state!=='online')return login(actor,{action:'start_login',botQQ:linked?.account??args.botQQ},online);
      if(current.verified&&current.connection==='connected')return current;
      if(['connecting','disconnected','verifying'].includes(current.connection))
        return {...current,nextAction:'wait-for-channel'};
    }
    if (!linked) return {...view(),ok:false,errorCode:'no-binding'};
    const phrase = {connect: '确认连接QQ', disconnect: '确认断开QQ', unlink: '确认解绑QQ'}[action];
    if (args.confirm !== true || !actor.text.includes(phrase))
      return {...view(), confirmationRequired: phrase};
    if (action === 'connect') return stage(actor, action, {botQQ: linked.account, ownerQQ: linked.sender, onebot: onebot()});
    return stage(actor, action);
  }
  async function afterTurn(sessionId) {
    const state = read(), job = state.transition;
    if (!job || job.state !== 'queued' || job.afterSession !== sessionId || job.reloadRequested) return;
    job.reloadRequested = true; save(state);
    try {
      if (requestReload) await requestReload(job);
      else {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./qq-reload.mjs', import.meta.url)), job.configPath, job.id],
          {cwd: options.cwd, detached: true, stdio: 'ignore'});
        child.on('error', () => {
          const latest = read(); if (latest.transition?.id !== job.id) return;
          latest.transition.state = 'failed'; latest.transition.reloadState = 'spawn-failed'; save(latest);
        });
        child.unref();
      }
    } catch {
      const latest = read(); if (latest.transition?.id === job.id) {
        latest.transition.state = 'failed'; latest.transition.reloadState = 'request-failed'; save(latest);
      }
    }
  }
  timer = setInterval(() => {
    if (closed || pollQueued) return;
    pollQueued = true;
    void exclusive(async () => {
        const pending = read().transition;
        if (pending && ['queued', 'applying', 'data-applied'].includes(pending.state)) return;
        await pollBinding();await poll();
      }).catch(() => {}).finally(()=>{pollQueued=false;});
  }, 3000);
  timer.unref();
  const execute = (args, actor) => exclusive(async () => {
    const result = await perform(args, actor);
    const action = args.action ?? 'status';
    const proof = result.association;
    const waitingForConfirmation = (['status', 'poll', 'begin_link'].includes(action)||result.nextAction==='continue-owner-verification')
      && proof?.state === 'verified' && proof.remainingSeconds > 0;
    return {...result, action,
      ...(waitingForConfirmation ? {confirmationRequired:'确认关联 '+proof.ownerQQ} : {})};
  });
  return {status: view, handleEvent, afterTurn,
    runtimeReady() {
      const state = read(), job = state.transition;
      if (['preparing','waiting'].includes(state.challenge?.state)) {
        state.challenge.state='interrupted'; delete state.challenge.codeHash; save(state);
      }
      if(job?.state==='confirmed'&&job.reloadState==='accepted-awaiting-runtime'){job.reloadState='applied';save(state);}
      void exclusive(pollBinding).catch(()=>{});
    },
    execute,
    tool(route, sessionId) {
      assert.equal(routeKey(route), routeKey(ownerRoute)); assert.equal(senderKey(route), senderKey(ownerRoute));
      return defineTool({name: 'companion_qq',
        description: 'ClawChat主人管理同一伙伴的QQ。首次连接和恢复连接都用 connect，只问进度用 status。扫码与主人关联分别核验；nextAction=provide-owner-qq 时需要主人个人QQ号，wait-for-channel 时继续核验聊天通道。只有主人明确要求换码时用 refresh_login。其他操作有 start_login、poll、cancel_login、begin_link、confirm_link、disconnect、unlink、switch_bot。仅按实时状态及送达回执说明进度；lastKnownState 是历史记录。确认关联须由主人原话“确认关联 主人QQ号”，实际连接变更按工具返回的口令确认。更换机器人前先断开QQ，再按网关实际退出能力重新扫码。平台预置网关，不向用户索取网关密码。',
        properties: {action: str('QQ管理操作，默认status'), botQQ: str('大肥鱼QQ号；绑定时省略则读取实际在线账号'), ownerQQ: str('主人个人QQ号'), confirm: bool('仅在主人明确确认后为true'),restart:bool('仅主人明确要求重新生成有效绑定验证时为true')},
        render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}],
        execute(args, exec) {
          requireManualOwnerTurn(exec); assert.equal(nativeTurnSource(exec.agent.session)?.kind, 'user', 'QQ关联只在ClawChat主人手动会话操作');
          assert.equal(String(exec.agent.session.id), sessionId, 'QQ管理会话不匹配');
          let text = '';
          for (let i = exec.agent.session.seq; i >= 0; i--) {
            const event = exec.agent.session.eventAt(i); if (event?.type !== 'user/message') continue;
            text = ((event.data.message ?? event.data).content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'); break;
          }
          return execute(args,{route,sessionId,text,operationId:nativeOperationId(exec)}).catch(error=>{
            const value=view(), proof=value.association;
            const canConfirm=error.qqCode==='confirmation-required'&&proof?.state==='verified'&&proof.remainingSeconds>0;
            return {...value,ok:false,action:args.action??'status',errorCode:error.qqCode??'operation-failed',
              ...(error.qqCode?{detail:error.message}:{}),
              ...(canConfirm?{confirmationRequired:'确认关联 '+proof.ownerQQ}:{})};
          });
        }});
    },
    async close() { if (closed) return; closed = true; clearInterval(timer); stopProof(); await tail; },
  };
}
