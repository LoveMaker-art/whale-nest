import assert from 'node:assert/strict';

/** Call only under the instance's serialized writer. Uncertain delivery is a
 * durable terminal hold until a platform-specific reconciliation is available.
 */
export async function deliverIntent(state, id, adapter, save) {
  const intent = state.outbox[id];
  assert.ok(intent, 'Unknown intent');
  if (intent.state !== 'pending') return structuredClone(intent);
  intent.state = 'uncertain'; save();
  try {
    const receipt = await adapter.sendText(structuredClone(intent));
    assert.ok(typeof receipt?.messageId === 'string' && receipt.messageId, 'Platform acknowledgement required');
    intent.state = 'confirmed'; intent.messageId = receipt.messageId; save();
  } catch (error) {
    if (error.definitelyNotSent === true) intent.state = 'pending';
    save(); throw error;
  }
  return structuredClone(intent);
}
