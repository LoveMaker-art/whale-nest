import assert from 'node:assert/strict';
import {join} from 'node:path';
import {defineTool} from '../vendor/aurabot/src/tools/tools.js';
import {nativeOperationId,requireManualOwnerTurn} from './native-tool.mjs';
import {resolveDeliveryTarget} from './routing.mjs';
import {readState} from './state.mjs';
import {stickerTurn} from './sticker-material.mjs';
import {isVoiceInput} from './voice-history.mjs';

export function realtimeCallUrl(options, route = options.clawchat?.route) {
  if (!options.realtime?.enabled || route?.channel !== 'clawchat'
    || !resolveDeliveryTarget(options,{origin:route}).ok) return null;
  try {
    const entry = readState(join(options.dataDir,'call-liveware.json'),null);
    if (entry && (entry.binding !== route.account || entry.owner !== route.sender)) return null;
    const url = new URL(entry?.url ?? options.realtime.publicOrigin);
    if (url.protocol !== 'https:' || !/^app-[a-z0-9-]+\.apps\.clawling\.io$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return null;
    if (entry?.appId && entry.appId !== url.hostname.split('.')[0]) return null;
    return url.href;
  } catch { return null; }
}

export function realtimeCallTool(options, route, sessionId) {
  return defineTool({
    name:'open_realtime_call',
    description:'主人在当前 ClawChat 私聊明确要求打电话、语音通话或打开通话入口时，获取该实例已登记的私有通话卡片链接。返回后把原链接放在最终消息的独立一行，让主人点击进入并开始通话。普通语音消息用 send_voice。',
    properties:{},
    render:(_args,result)=>[{type:'text',text:result.url?result.message+'\n'+result.url:result.message}],
    execute(_args, exec) {
      nativeOperationId(exec);
      requireManualOwnerTurn(exec);
      assert.equal(String(exec.agent.id),String(sessionId),'通话入口需要当前私聊');
      const turn = stickerTurn(exec,options,route,sessionId);
      const text = turn.text.replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g,'');
      assert.ok(!isVoiceInput(turn.message.source?.connectInputId)
        && !/(?:不要|不用|别|先不)[^，。！？\n]{0,10}(?:通话|打电话|打个电话|呼叫)|\b(?:don't|do not) (?:call|start)\b/i.test(text)
        && /(?:^|[。！？：\n])\s*(?:语音通话|实时通话|通话|打电话)\s*(?:$|[。！？!?])|打个电话|通话入口|(?:开始|打开|发起|想|来|能|可以).{0,6}(?:通话|打电话)|\b(?:voice call|call me)\b/i.test(text),
        '仅主人当前要求时提供通话入口');
      const url = realtimeCallUrl(options,route);
      return url ? {ok:true,url,message:'点开鲸栖通话卡片后，按页面里的通话按钮。'}
        : {ok:false,message:'私有通话入口暂未就绪。'};
    },
  });
}
