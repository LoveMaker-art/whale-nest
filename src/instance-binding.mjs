import {join} from 'node:path';
import {readState} from './state.mjs';

/** The platform supplies the instance identity. A copied local account record
 * must not authorize our services on a different platform instance. */
export function requireCurrentInstanceBinding(options,platformInstanceId=process.env.CLAWNEST_INSTANCE_ID){
  if(options.clawchat?.firstBinding!==true)return;
  const record=readState(join(options.dataDir,'first-binding.json'),null);
  if(!platformInstanceId&&!record?.platformInstanceId)return; // pre-marker installation
  const route=options.clawchat.route,identity=record?.identity;
  if(!platformInstanceId||record?.platformInstanceId!==platformInstanceId||!identity
    ||identity.account!==route?.account||identity.owner!==route?.sender||identity.conversation!==route?.conversation)
    throw Object.assign(Error('Instance awaits its verified Connect binding'),{code:'FIRST_BINDING_PENDING'});
}
