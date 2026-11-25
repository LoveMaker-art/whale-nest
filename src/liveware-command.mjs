import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';

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
        '--request-id', requestId, '--config', configPath], {timeout:45000,maxBuffer:1024*1024,signal}));
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
  const tool = (name, input, control) => command(['tool','call',name,'--input-json',JSON.stringify(input)],control);
  return {
    listApps: control => command(['liveware','app','list'],control),
    inspectApp: (appId, control) => command(['liveware','app','inspect','--app-id',appId],control),
    createApp: (name, control) => command(['liveware','app','create','--name',name,'--policy','private'],control),
    bindTunnel: (appId, upstream, control) => command(['liveware','tunnel','bind','--app-id',appId,'--upstream',upstream],control),
    listLaunchers: control => tool('clawchat_list_apps',{},control),
    unregisterLauncher: (appId, control) => tool('clawchat_unregister_app',{appId},control),
    registerLauncher: (app, control) => tool('clawchat_register_app',{
      appId:app.appId,name:app.name,url:app.url,
    },control),
  };
}
