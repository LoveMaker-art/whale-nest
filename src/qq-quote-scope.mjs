/** Scoped history is only used to enrich a quote already verified by get_msg. */
export function quoteInConversation(message, target, botQQ, {scopedHistory = false} = {}) {
  if (!message || !target?.id) return false;
  const kind = String(message.message_type ?? '');
  if (kind !== target.kind && (kind || !scopedHistory)) return false;

  const group = String(message.group_id ?? '');
  const reportsGroup = Boolean(group && group !== '0');
  if (target.kind === 'group') return reportsGroup ? group === target.id : scopedHistory;
  if (target.kind !== 'private' || reportsGroup || !botQQ) return false;

  const sender = String(message.sender?.user_id ?? message.user_id ?? '');
  const recipient = String(message.target_id ?? '');
  const reportsRecipient = Boolean(recipient && recipient !== '0');
  if (sender === botQQ) return reportsRecipient ? recipient === target.id : scopedHistory;
  return sender === target.id && (!reportsRecipient || recipient === botQQ);
}
