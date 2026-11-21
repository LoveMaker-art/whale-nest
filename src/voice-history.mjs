import {join} from 'node:path';
import {readState} from './state.mjs';

const voiceInput = /^whalenest-call-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
export const isVoiceInput = value => typeof value === 'string' && voiceInput.test(value);
export const voiceLabel = '【实时通话】';

function voiceMessageId(event) {
  if (event.type !== 'user/message') return undefined;
  const source = (event.data.message ?? event.data).source;
  return source?.kind === 'user' && isVoiceInput(source.connectInputId)
    ? voiceInput.exec(source.connectInputId)[1] : undefined;
}

// Preserve the native journal and only hide its call turns in the chat-facing projection.
export function visibleChatEvents(events) {
  const hidden = new Set();
  let turn;
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (turn !== undefined && voiceMessageId(event)) hidden.add(turn);
    if (event.type === 'turn/end') turn = undefined;
  }
  turn = undefined;
  return events.filter(event => {
    if (event.type === 'turn/start') turn = event.data.turn;
    // Native compaction can append a replacement result for a previous turn.
    const hide = hidden.has(turn) || hidden.has(event.data?.turn) || Boolean(voiceMessageId(event));
    if (event.type === 'turn/end') turn = undefined;
    return !hide;
  });
}

export function callPlaybackContext(session, dataDir) {
  const receipts = [];
  for (let seq = session.seq; seq >= 0 && seq > session.seq - 800 && receipts.length < 6; seq--) {
    const event = session.eventAt(seq);
    const id = event && voiceMessageId(event);
    if (!id) continue;
    let record;
    try {record = readState(join(dataDir, 'realtime/platform-turns', id+'.json'), null);}
    catch { /* A damaged receipt must not stop ordinary conversation. */ }
    const heard = record?.sessionId === String(session.id) && typeof record.played === 'string';
    if (heard && record.state === 'played' && record.played === record.generated) continue;
    receipts.unshift({
      发言: (heard && typeof record.heard === 'string' ? record.heard : '').slice(0,160),
      已播: heard ? record.played.slice(0,600) : '',
      状态: heard && record.state === 'interrupted' ? '打断' : '播放未全部确认',
    });
  }
  return receipts.length
    ? '近期实时通话的播放记录如下。已播字段才表示主人听过的回复，其余生成文字可供理解，但不能当成已经说给主人听：'+JSON.stringify(receipts)
    : '';
}
