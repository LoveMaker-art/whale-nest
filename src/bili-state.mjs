import assert from 'node:assert/strict';
import {hash,ownerScope,routeKey,senderKey} from './routing.mjs';
import {readState,writeState} from './state.mjs';

/** Migrate the existing Bili files; routes authorize access, never partition it. */
export function loadBiliOwnerState(options,route,file,initial){
 const trusted=r=>r?.kind==='private'&&options.owners.some(o=>senderKey(o)===senderKey(r))
  &&(r.channel==='qq'?r.conversation===r.sender:!options.clawchat?.route||routeKey(r)===routeKey(options.clawchat.route));
 assert.ok(trusted(route),'Owner private route required: trusted owner；当前会话或账号归属不符');
 const scope=ownerScope(options),known=[route,options.clawchat?.route].filter(trusted)
  .map(r=>hash([options.instanceId,routeKey(r),senderKey(r)]));
 const state=readState(file,{...initial,schema:2,scope});
 assert.ok(state.scope===scope||state.schema===1&&known.includes(state.scope),'B站数据不属于当前主人');
 const aliases=[...new Set([...(state.legacyScopes??[]),...known,...(state.scope!==scope?[state.scope]:[])])];
 assert.ok(aliases.every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)),'Invalid legacy Bili scope');
 state.schema=2;state.scope=scope;state.legacyScopes=aliases;
 // Keep the old request namespace stable; ownership is shared, IDs are not
 // regenerated during upgrade, restart, IM changes, or a compatible rollback.
 state.identityScope??=known.at(-1)??scope;
 assert.ok(state.identityScope===scope||aliases.includes(state.identityScope),'Unknown Bili request namespace');
 const save=()=>writeState(file,state);
 const scopedId=(prefix,parts,exists)=>[state.identityScope,scope,...aliases].map(s=>prefix+hash([s,...parts])).find(exists)??prefix+hash([state.identityScope,...parts]);
 return {state,scope,aliases,save,scopedId};
}
