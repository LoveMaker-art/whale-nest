import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {platformOperations} from './platform-operations.mjs';

const execute = promisify(execFile);

/** Public Connect commands only. The connector retains credentials, request
 * journaling, account selection, and all platform requests. */
export function livewareCommands(options, {run = execute} = {}) {
  const {connectBin, configPath} = options.clawchat?.delivery ?? {};
  const account = options.clawchat?.route?.account;
  assert.ok(isAbsolute(connectBin ?? '') && isAbsolute(configPath ?? '') && account,
    'Liveware needs the configured Connect executable and binding');
  async function command(args, {requestId = 'whalenest-liveware-read-' + randomUUID(), signal} = {}) {
    let stdout;
    try {
      ({stdout} = await run(connectBin, [...args, '--agent', account,
        '--request-id', requestId, '--config', configPath], {timeout:45000,maxBuffer:1024*1024,signal,env:{...process.env,WHALENEST_SOURCE_INSTANCE:'',CLAWCHAT_CONNECT_CONFIG:configPath}}));
    } catch (error) {
      // Official CLI emits a terminal failure receipt on stdout and exits 1.
      // A process timeout without such a receipt remains indeterminate.
      if (!error.stdout) throw error;
      stdout = error.stdout;
    }
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.requestId ?? requestId,requestId,'Connect returned a different Liveware request');
    if (receipt.status !== 'succeeded') {
      const error = Error('Connect Liveware command did not return a successful receipt');
      error.receipt = receipt;
      throw error;
    }
    return receipt.result;
  }
  const operations=platformOperations(options,{run:run===execute?undefined:run});
  const write=async(name,input,control={})=>{
    const receipt=await operations.submit(name,control.requestId??'whalenest-liveware-'+randomUUID(),input,control);
    if(receipt.status!=='succeeded')throw Object.assign(Error('Connect Liveware command did not return a successful receipt'),{receipt});
    return receipt.result;
  };
  return {
    readReceipt:(name,id)=>operations.inspect(name,id),
    listApps: control => command(['liveware','app','list'],control),
    inspectApp: (appId, control) => command(['liveware','app','inspect','--app-id',appId],control),
    createApp:(name,control)=>write('liveware_app_create',{name,policy:'private'},control),
    bindTunnel:(appId,upstream,control)=>write('liveware_tunnel_bind',{'app-id':appId,upstream},control),
    listLaunchers:control=>command(['tool','call','clawchat_list_apps','--input-json','{}'],control),
    unregisterLauncher: (appId, control) => write('clawchat_unregister_app',{appId},control),
    registerLauncher: (app, control) => write('clawchat_register_app',{
      appId:app.appId,name:app.name,url:app.url,
    },control),
  };
}
