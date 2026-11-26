import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool, str } from '../vendor/aurabot/src/tools/tools.js';
import { matchesMemoryKeyword } from '../vendor/aurabot/src/features/memory.js';
import {withCompanionDefaults} from './companion-defaults.mjs';
import { readState, writeState } from './state.mjs';
import { chatFor, hash, senderKey } from './routing.mjs';
import { persistedEvents } from './native-replay.mjs';
import { requireManualOwnerTurn } from './native-tool.mjs';

export const memoryCallContext = new AsyncLocalStorage();
export const humanMessageText = text => text.replace(/^<clawchat_turn_context>\r?\n[\s\S]*?<\/clawchat_turn_context>\s*/, '').trim();
const dayKey = at => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Supplies the original synchronous chatlog Interface. Only authenticated new
 * ClawChat owner inputs are captured; a durable native user event admits them.
 * The original memory module remains the sole fact/recall implementation. */
export function createMemoryAdapter(ctx, options, policy) {
  options=withCompanionDefaults(options);
  const directory = join(options.dataDir, 'aurabot', 'chatlog');
  const stateFile = join(options.dataDir, 'memory-history.json');
  const state = readState(stateFile, { schema: 1, instanceId: options.instanceId, pending: {}, cursors: {} });
  assert.equal(state.schema, 1, 'Unsupported memory history state');
  assert.equal(state.instanceId, options.instanceId, 'Memory history belongs to another instance');
  let memory, closed = false, tail = Promise.resolve(), scheduledFlight, lastError;
  assert.ok(options.memory?.automatic === undefined || typeof options.memory.automatic === 'boolean', 'memory.automatic must be boolean');
  const automatic = options.memory?.automatic === true;
  const ownerId=options.memoryPersonId??'1';
  const save = () => writeState(stateFile, state);
  const eligible = route => route?.channel === 'clawchat' && route.kind === 'private'
    && options.owners.some(o => senderKey(o) === senderKey(route));
  const pathFor = day => {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day), 'Invalid chatlog day');
    return join(directory, day + '.jsonl');
  };
  const days = () => existsSync(directory) ? readdirSync(directory).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map(n => n.slice(0, 10)).sort() : [];
  const rows = day => {
    const file = pathFor(day);
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  function rewrite(day, records) {
    const file = pathFor(day), tmp = file + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  }
  function forgetChatLog(person, query) {
    let count = 0;
    for (const day of days()) {
      let changed = false;
      const records = rows(day).map(row => {
        if (row.chatId === `private:${person}` && row.who !== 'bot' && !row.forgottenAt && matchesMemoryKeyword(row.text, query)) {
          count++; changed = true; return { ...row, forgottenAt: Date.now() };
        }
        return row;
      });
      if (changed) rewrite(day, records);
    }
    return count;
  }
  const hub = {
    chatLogDays: days, chatLogOf: rows, forgetChatLog,
    deleteChatLog(day) { const file = pathFor(day); if (existsSync(file)) unlinkSync(file); },
  };
  function exclusive(fn) {
    const next = tail.then(() => { assert.ok(!closed, 'Memory adapter is closed'); return fn(); });
    tail = next.catch(() => {});
    return next;
  }
  async function refresh() {
    let added = 0;
    const sessions = [...new Set(Object.values(state.pending).map(p => p.sessionId))];
    for (const sessionId of sessions) {
      const events = await persistedEvents(ctx.sessionPersistence, sessionId);
      const cursor = state.cursors[sessionId] ?? -1;
      assert.ok(cursor <= (events.at(-1)?.seq ?? -1), 'Native journal moved behind memory cursor');
      for (const event of events) {
        if (event.seq <= cursor || event.type !== 'user/message') continue;
        const message = event.data.message ?? event.data;
        if (message.source?.kind !== 'user') continue;
        const found = Object.entries(state.pending).find(([, p]) => p.sessionId === sessionId
          && (p.messageId === String(message.id) || p.inputId === message.source.connectInputId));
        if (!found) continue;
        const [key, pending] = found;
        if (eligible(pending.route)) {
          const text = humanMessageText(pending.text);
          if (text && !text.includes('运维自测')) {
            const chat = chatFor(pending.route, options.owners,ownerId), day = dayKey(pending.at);
            const existing = new Set(rows(day).map(r => r.sourceId));
            const characters = Array.from(text), append = [];
            for (let offset = 0; offset < characters.length; offset += 500) {
              const sourceId = hash([sessionId, event.seq, offset]);
              if (!existing.has(sourceId)) append.push({ t: pending.at, chatId: chat.chatId, who: '主人', uid: chat.userId,
                text: characters.slice(offset, offset + 500).join(''), via: 'clawchat', sourceId });
            }
            if (append.length) {
              mkdirSync(directory, { recursive: true, mode: 0o700 });
              appendFileSync(pathFor(day), append.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
              added += append.length;
            }
          }
        }
        delete state.pending[key];
      }
      state.cursors[sessionId] = events.at(-1)?.seq ?? cursor;
      save();
    }
    lastError = undefined;
    return { ok: true, added };
  }
  async function run(fn) {
    if (!automatic) return { ok: false, state: 'blocked', reason: 'memory-automatic-disabled' };
    const blocked = policy.maintenanceReason();
    if (blocked) return { ok: false, state: 'blocked', reason: blocked };
    return exclusive(async () => {
      await refresh();
      return memoryCallContext.run({ kind: 'memory', runId: 'memory-' + randomUUID(),
        allowed: () => !closed && automatic }, fn);
    });
  }
  const status = () => ({ automatic, historyDays: days(), pendingInputs: Object.keys(state.pending).length,
    blockedReason: !automatic ? 'memory-automatic-disabled' : policy.maintenanceReason(),
    dailyModelRequestLimit: policy.status().dailyModelRequestLimit, usage: policy.status().usage,
    ...(lastError ? { lastError } : {}),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  function manage(args = {}) {
    assert.ok(memory, 'Memory module is not ready');
    const action = args.action ?? 'list';
    if (action === 'status') return { ok: true, ...status() };
    if (action === 'list') return { ok: true, items: memory.list(String(args.query ?? '')).slice(0, 100) };
    if (action === 'forget') {
      const query = String(args.query ?? '').trim();
      assert.ok(query && query.length <= 200, '遗忘查询须为1–200字符');
      const result = memory.handleCommand({ kind: 'private', userId: ownerId, chatId: 'private:'+ownerId, nickname: '主人' }, '忘记 ' + query);
      if (result) return result;
      const matches = memory.list('').filter(m => String(m.about) === ownerId && matchesMemoryKeyword(m.text, query));
      const marked = forgetChatLog(ownerId, query);
      for (const item of matches) memory.remove(item.id);
      return { ok: true, forgotten: matches.length, marked };
    }
    assert.ok(typeof args.id === 'string' && args.id, '需要记忆ID');
    const item = memory.list('').find(m => m.id === args.id);
    assert.ok(item, '记忆不存在');
    if (action === 'get') return { ok: true, item };
    assert.ok(action === 'update' || action === 'delete', '未知记忆操作');
    if (action === 'update') {
      assert.ok(typeof args.text === 'string' && args.text.trim() && args.text.length <= 200, '记忆正文须为1–200字符');
      // Retire matching old source rows before changing the fact. A later
      // consolidation must not turn the same transcript back into the old fact.
      forgetChatLog(item.about || ownerId, item.text);
      return memory.update(item.id, { text: args.text.trim() });
    }
    forgetChatLog(item.about || ownerId, item.text);
    return memory.remove(item.id);
  }
  return {
    hub, status, exclusive, manage: args => exclusive(() => manage(args)),
    attach(value) { memory = value; },
    capture({ sessionId, inputId, messageId, text, route, source = 'user' }) {
      if (closed || source !== 'user' || !eligible(route) || humanMessageText(text).includes('运维自测')) return;
      const key = hash([sessionId, inputId]);
      const previous = state.pending[key];
      if (previous) { assert.equal(previous.text, text, 'Memory input identity changed'); return; }
      state.pending[key] = { sessionId: String(sessionId), inputId, ...(messageId ? { messageId: String(messageId) } : {}),
        text, route: structuredClone(route), at: Date.now() };
      save();
    },
    refresh: () => exclusive(refresh).catch(error => {
      lastError = error.message;
      return { ok: false, message: error.message };
    }),
    consolidate: () => run(() => memory.consolidate({ includeToday: true })),
    wrapModule(definition) {
      return { ...definition, setup(api, ...args) {
        return definition.setup({ ...api, every(ms, fn, label) {
          return api.every(ms, () => {
            if (scheduledFlight || closed) return;
            scheduledFlight = run(fn).finally(() => { scheduledFlight = undefined; });
            return scheduledFlight;
          }, label);
        } }, ...args);
      } };
    },
    tool() {
      return defineTool({ name: 'companion_memory',
        description: '主人长期记忆管理：list/get查询原记忆、update纠正、delete删除、forget按关键词遗忘、status查看自动整理状态。修改需明确记忆ID和新正文；原聊天记录独立保留。记事和相关查询也可用remember/recall_memory。后台不能修改管理设置或删除。',
        properties: { action: str('list/get/update/delete/forget/status，默认list'), id: str('记忆ID'), query: str('查询或遗忘关键词'), text: str('纠正后的完整事实，最多200字符') },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        execute(args, exec) { requireManualOwnerTurn(exec); return exclusive(() => manage(args)); },
      });
    },
    async close() { closed = true; await tail; },
  };
}
