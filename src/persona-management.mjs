import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listPersonas, readPersona, savePersona, deletePersona } from '../vendor/aurabot/src/persona/personas.js';
import { defineTool, str } from '../vendor/aurabot/src/tools/tools.js';
import { readState, writeState } from './state.mjs';
import { requireManualOwnerTurn } from './native-tool.mjs';

export const originalPersonaId = 'dafeiyu-original';

/** The original card library, with one instance-wide selection and a per-turn
 * in-memory prompt. Platform/owner authentication stays in the host. */
export function createPersonaManagement(options, reference, selection) {
  const file = join(options.dataDir, 'persona-state.json');
  const fresh = !existsSync(file);
  const state = selection ? { schema: 1, instanceId: options.instanceId, currentId: selection.get() }
    : readState(file, { schema: 1, instanceId: options.instanceId, currentId: originalPersonaId });
  assert.equal(state.schema, 1, 'Unsupported persona state');
  assert.equal(state.instanceId, options.instanceId, 'Persona selection belongs to another instance');
  const pins = new WeakMap();
  const idOf = id => {
    assert.ok(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(id), '人格ID须为1–40位字母、数字、下划线或短横线');
    return id;
  };
  const read = id => {
    const card = readPersona(idOf(id));
    assert.ok(card?.body?.trim(), '人格不存在或正文为空');
    return card;
  };
  const currentId = () => selection ? selection.get() : state.currentId;
  if (fresh || selection) {
    if (!readPersona(originalPersonaId)) savePersona(originalPersonaId, { name: '大肥鱼', tags: ['原始'], body: reference });
    read(currentId());
    if (!selection) writeState(file, state);
  } else read(state.currentId);

  function perform(args = {}) {
    const action = args.action ?? 'list';
    if (action === 'list') return { ok: true, currentId: currentId(),
      items: listPersonas().sort((a, b) => Number(b.id === originalPersonaId) - Number(a.id === originalPersonaId) || a.id.localeCompare(b.id)) };
    if (action === 'get') return { ok: true, currentId: currentId(), persona: read(args.id ?? currentId()) };
    const id = idOf(args.id);
    if (action === 'use') {
      read(id);
      const next = { ...state, currentId: id };
      // Native config is authoritative; retain a compatibility projection
      // for rollback to the previous runtime, never a second active picker.
      if (selection) selection.set(id);
      writeState(file, next);
      Object.assign(state, next);
      return { ok: true, currentId: id, effectiveFrom: 'next-turn', message: '已切换，下一轮起生效。' };
    }
    if (action === 'delete') {
      assert.notEqual(id, currentId(), '正在使用的人格不能删除');
      read(id);
      deletePersona(id);
      assert.equal(readPersona(id), null, '人格删除失败');
      return { ok: true, deleted: id, currentId: currentId() };
    }
    assert.ok(action === 'create' || action === 'update', '未知人格操作');
    const previous = readPersona(id);
    if (action === 'create') assert.equal(previous, null, '人格ID已存在，请使用编辑或选择其他ID');
    else assert.ok(previous, '人格不存在');
    const name = args.name ?? previous?.name ?? id;
    const tags = args.tags ?? previous?.tags ?? [];
    const body = args.body ?? previous?.body;
    assert.ok(typeof name === 'string' && name.trim() && name.length <= 80 && !/[\r\n]/.test(name), '人格名称须为1–80字符且不含换行');
    assert.ok(Array.isArray(tags) && tags.length <= 10 && tags.every(t => typeof t === 'string' && t.length > 0 && t.length <= 40 && !/[\r\n,，\[\]]/.test(t)), '人格标签格式无效');
    assert.ok(typeof body === 'string' && body.trim() && body.length <= 32000, '人格正文须为1–32000字符');
    savePersona(id, { name: name.trim(), tags, body });
    const saved = read(id);
    assert.equal(saved.body, body.trim(), '人格保存后读回不一致');
    return { ok: true, persona: saved, currentId: currentId(),
      effectiveFrom: id === currentId() ? 'next-turn' : 'when-selected' };
  }

  return {
    perform,
    current: () => read(currentId()),
    status: () => ({ currentId: currentId(), name: read(currentId()).name }),
    forTurn(session) {
      let start;
      for (let n = session.seq; n >= 0; n--) {
        const event = session.eventAt(n);
        if (event?.type === 'turn/end') break;
        if (event?.type === 'turn/start') { start = n; break; }
      }
      if (start === undefined) return read(currentId()).body;
      let pin = pins.get(session);
      if (pin?.start !== start) { pin = { start, body: read(currentId()).body }; pins.set(session, pin); }
      return pin.body;
    },
    tool() {
      return defineTool({ name: 'companion_persona',
        description: '主人的人格管理：list列出、get查看、create新建、update编辑、delete删除、use切换。id为1–40位字母数字_-；新建需body，可选name/tags。保存不自动启用，当前人格不能删，编辑或切换下一轮起生效。切换不会清空聊天、记忆和心情。只有真实操作成功才声称已修改。',
        properties: { action: str('list/get/create/update/delete/use，默认list'), id: str('人格ID，get默认当前人格'),
          name: str('显示名称'), tags: { type: 'array', items: { type: 'string' } }, body: str('完整人格正文') },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        execute(args, ctx) { requireManualOwnerTurn(ctx); return perform(args); },
      });
    },
  };
}
