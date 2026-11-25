import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);

/** The official platform command owns its account lookup. Its current output
 * is scoped to the `dsh` binding and is too coarse for first-binding readiness. */
export async function readClawChatPlatformState({connectBin,configPath}, {run=exec}={}) {
  assert.ok(typeof connectBin === 'string' && isAbsolute(connectBin),
    'An absolute configured Connect executable is required');
  assert.ok(typeof configPath === 'string' && isAbsolute(configPath),
    'An absolute Connect configuration is required');
  const {stdout}=await run(connectBin,['__clawnest-state','--config',configPath],{
    encoding:'utf8',timeout:8000,maxBuffer:1024*1024,
    // The official platform entry reads this variable rather than --config.
    env:{...process.env,CLAWCHAT_CONNECT_CONFIG:configPath},
  });
  const state=JSON.parse(stdout);
  assert.ok(state && typeof state === 'object' && !Array.isArray(state),'Invalid public Connect state');
  return state;
}

/** Read one existing Core receipt without creating a request or opening a
 * writable Core store. The private SQLite schema is confined to this adapter. */
export function readClawChatToolStatus(configPath, account, toolName, requestId) {
  assert.ok(typeof configPath === 'string' && isAbsolute(configPath));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.ok(typeof account === 'string' && account && Object.hasOwn(config.agents ?? {}, account),
    'An exact configured Connect binding is required');
  assert.ok(typeof toolName === 'string' && toolName && typeof requestId === 'string' && requestId,
    'An exact tool name and request ID are required');
  assert.ok(typeof config.stateDbPath === 'string' && isAbsolute(config.stateDbPath),
    'An explicit Connect state database is required');
  const db = new DatabaseSync(config.stateDbPath, {readOnly:true, timeout:1500});
  try {
    const row = db.prepare(`SELECT state, result_json, error FROM tool_requests
      WHERE binding_id = ? AND tool_name = ? AND request_id = ?`).get(account, toolName, requestId);
    return {requestId, status:row?.state ?? 'not_found',
      ...(row?.result_json ? {result:JSON.parse(row.result_json)} : {}),
      ...(row?.error ? {error:row.error} : {})};
  } finally { db.close(); }
}

export function clawchatBindingState(configPath, selectedAccount) {
  assert.ok(isAbsolute(configPath));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const account = selectedAccount ?? config.defaultAgent ?? (Object.keys(config.agents ?? {}).length === 1
    ? Object.keys(config.agents)[0] : null);
  assert.ok(account && (selectedAccount !== undefined || Object.hasOwn(config.agents ?? {}, account)),
    'First binding needs an unambiguous Connect agent');
  assert.ok(isAbsolute(config.stateDbPath), 'An explicit Connect state database is required');
  const query = read => {
    const db = new DatabaseSync(config.stateDbPath, {readOnly:true, timeout:1500});
    try { return read(db); } finally { db.close(); }
  };
  const activation = db => db.prepare(`SELECT a.user_id AS agent, a.owner_user_id AS owner,
      a.conversation_id AS conversation, a.activated_at AS at
    FROM activations AS a JOIN installation_owner AS i ON i.id = 1 AND i.owner_user_id = a.owner_user_id
    WHERE a.platform = 'clawchat-connect' AND a.local_agent_id = ?
      AND a.access_token <> '' AND a.conversation_id <> ''`).get(account);
  const authorized = (db, binding) => {
    const row = activation(db);
    assert.ok(row?.agent === binding.agent && row.owner === binding.owner && row.conversation === binding.conversation,
      'Connect identity changed during first binding');
    return row;
  };
  return {
    account, dbPath:config.stateDbPath,
    current:() => query(activation),
    verify:binding => query(db => authorized(db, binding)),
    ready:binding => query(db => {
      const row = authorized(db, binding);
      const status = db.prepare(`SELECT websocket_connected, runtime_availability, updated_at
        FROM runtime_statuses WHERE agent_id = ?`).get(account);
      return status?.websocket_connected === 1 && status.runtime_availability !== 'startup-unavailable' && status.updated_at >= row.at;
    }),
    receipt:(binding, name, id) => query(db => {
      authorized(db, binding);
      const row = db.prepare(`SELECT state, result_json FROM tool_requests
        WHERE binding_id = ? AND tool_name = ? AND request_id = ?`).get(account, name, id);
      return row && {state:row.state, result:row.result_json ? JSON.parse(row.result_json) : null};
    }),
  };
}

export async function readBoundClawChatAgentId(clawchat, {readPlatformState=readClawChatPlatformState}={}) {
  const {delivery,route}=clawchat;
  const configPath = delivery?.configPath;
  if (!route || typeof configPath !== 'string' || !isAbsolute(configPath)) return null;
  const selected={account:route.account,owner:route.sender,conversation:route.conversation,connectBin:delivery.connectBin};
  try {
    // Public platform state is fixed to dsh. Other binding names retain the
    // existing read-only adapter until the official query accepts a binding.
    let current;
    if(selected.account==='dsh') {
      const state=await readPlatformState(delivery);
      current=state && {agent:state.userId,owner:state.ownerId,conversation:state.conversationId};
    } else current=clawchatBindingState(configPath, selected.account).current();
    if(clawchat.delivery!==delivery || clawchat.route!==route || delivery.configPath!==configPath
        || delivery.connectBin!==selected.connectBin || route.account!==selected.account
        || route.sender!==selected.owner || route.conversation!==selected.conversation) return null;
    if (current?.owner === selected.owner && current.conversation === selected.conversation
        && typeof current.agent === 'string') return current.agent || null;
  } catch { /* A private page can offer a copyable draft while Core is unavailable. */ }
  return null;
}
