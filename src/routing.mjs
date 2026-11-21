import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const routeKey = route => JSON.stringify([route.channel, route.account, route.kind, route.conversation]);
export const senderKey = route => JSON.stringify([route.channel, route.account, route.sender]);
// owners are linked accounts of the one instance owner, not separate people.
// The key survives an IM switch or a later, explicitly migrated QQ association.
export const ownerScope = options => hash([options.instanceId, 'companion-owner']);

export function resolveDeliveryTarget(options, { explicit, origin, automatic = false,
  preferred = 'clawchat', available = () => true } = {}) {
  const basis = explicit ? 'explicit' : !automatic ? 'origin' : 'preference';
  let route = explicit ?? (!automatic ? origin : null);
  if (!route && automatic) {
    if (preferred === 'clawchat') route = options.clawchat?.route;
    else if (preferred === 'qq') {
      const owner = options.owners?.find(o => o.channel === 'qq');
      if (owner) route = { ...owner, kind: 'private', conversation: owner.sender };
    }
  }
  if (!route) return { ok: false, reason: 'owner-route-unavailable', basis };
  const owner = options.owners?.some(o => senderKey(o) === senderKey(route));
  const cc = options.clawchat?.route;
  const trustedConversation = route.channel === 'qq' ? route.conversation === route.sender
    : cc && routeKey(cc) === routeKey(route) && senderKey(cc) === senderKey(route);
  if (!owner || route.kind !== 'private' || !trustedConversation)
    return { ok: false, reason: 'unverified-owner-route', basis };
  const target = structuredClone(route);
  return available(target) ? { ok: true, route: target, basis }
    : { ok: false, reason: 'channel-unavailable', route: target, basis };
}
// Numeric surrogate keys keep upstream memory's person matching intact. They are
// internal identifiers, never QQ account numbers or platform authorization.
export const personId = (route, owners) => owners.some(o => senderKey(o) === senderKey(route))
  ? '1' : (BigInt('0x' + hash(senderKey(route)).slice(0, 32)) + 2n).toString();

export function normalizeInput(input) {
  assert.ok(input && typeof input === 'object', 'Trusted input envelope required');
  const r = input.route;
  assert.ok(r && ['clawchat', 'qq'].includes(r.channel), 'Unsupported channel');
  for (const key of ['account', 'conversation', 'sender']) {
    assert.ok(typeof r[key] === 'string' && r[key].trim() && r[key].length <= 256, `Invalid route.${key}`);
  }
  assert.ok(['private', 'group'].includes(r.kind), 'Invalid conversation kind');
  assert.ok(typeof input.id === 'string' && input.id && input.id.length <= 256, 'Message ID required');
  assert.ok(typeof input.text === 'string' && input.text.trim() && input.text.length <= 32000, 'Text required (max 32000 characters)');
  assert.ok(['user', 'schedule'].includes(input.source ?? 'user'), 'Unsupported input source');
  return { id: input.id, route: { channel: r.channel, account: r.account, conversation: r.conversation,
    sender: r.sender, kind: r.kind }, text: input.text, source: input.source ?? 'user' };
}

export function chatFor(route, owners, ownerId = '1') {
  const owner=owners.some(o=>senderKey(o)===senderKey(route));
  const userId = owner ? ownerId : personId(route, owners);
  return { kind: route.kind, userId, nickname: owner ? '主人' : '对方',
    chatId: route.kind === 'private' ? `private:${userId}` : `group:${BigInt('0x' + hash(routeKey(route)).slice(0, 32))}` };
}
