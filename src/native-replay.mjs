/** Read the native owner's durable journal without acquiring a writer handle. */
export async function persistedEvents(persistence, sessionId) {
  if (typeof persistence.inspect === 'function') return (await persistence.inspect(sessionId)).events;
  const handle = await persistence.open(sessionId, 'read');
  try { return (await handle.read(0)).events; }
  finally { await handle.close(); }
}

/** Return terminal turns, including foreground/failed turns as checkpoints.
 * Open turns are never promoted to deliveries. Tool calls are not final output.
 */
export function terminalTurns(events, cursor) {
  const result = [];
  let turn;
  for (const event of events) {
    if (event.type === 'turn/start') turn = { ids: [], normal: false, text: '' };
    if (!turn) continue;
    if (event.type === 'user/message') {
      const message = event.data.message ?? event.data;
      if (message.source?.kind === 'schedule') turn.ids.push(String(message.id));
      if (message.source?.kind === 'user') turn.normal = true;
    }
    if (event.type === 'assistant/message' && !event.data.interrupted
      && !event.data.message.content.some(b => b.type === 'tool-call')) {
      turn.text = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    }
    if (event.type === 'turn/end') {
      if (event.seq > cursor) result.push({ ...turn, seq: event.seq,completed:event.data.reason.kind==='completed',
        eligible: turn.ids.length > 0 && !turn.normal && event.data.reason.kind === 'completed' });
      turn = undefined;
    }
  }
  return result;
}
