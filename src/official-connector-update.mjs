import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {comparePluginVersions} from './plugin-release.mjs';

const exec=promisify(execFile);
const numeric=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const version=value=>typeof value==='string'&&value.length<60&&numeric.test(value)?value:undefined;

/** Advisory only. This adapter exposes no installation or rollback operation. */
export function createOfficialConnectorInspector(options,{run=exec}={}) {
  const executable=options.pluginUpdates?.connectorExecutable??'/usr/local/bin/clawchat-dsh';
  assert.ok(isAbsolute(executable),'An absolute official executable is required');
  async function command(action,timeout) {
    const {stdout}=await run(executable,['plugin',action],{cwd:options.cwd,timeout,maxBuffer:1024*1024});
    const value=JSON.parse(stdout);
    assert.ok(value && typeof value==='object' && !Array.isArray(value),'Invalid official version response');
    return value;
  }
  return {
    async check() {
      const [status,latest]=await Promise.allSettled([command('status',15000),command('check',30000)]);
      const current=status.status==='fulfilled'?version(status.value.running?.version):undefined;
      const checked=latest.status==='fulfilled'?latest.value:undefined;
      const official=checked?.release;
      const available=['current','update_available'].includes(checked?.status)&&
        official?.runtime==='deepseek-harness'&&official?.plugin==='clawchat-connect'
        ?version(official.version):undefined;
      const known=Boolean(current&&available);
      const state=known?(comparePluginVersions(available,current)>0?'available':'current'):'unavailable';
      return {state,...(current?{current}:{}),...(available?{latest:available}:{}),
        automaticUpdate:false,managedBy:'user',
        message:state==='available'?'官方连接器有新版本，是否通过官方入口更新由你决定；鲸栖不会代为更新。'
          :state==='current'?'官方连接器版本已核对，鲸栖不会代为更新。'
          :'暂时未能完整核对官方连接器版本；这不作为鲸栖更新的版本限制。'};
    },
  };
}
