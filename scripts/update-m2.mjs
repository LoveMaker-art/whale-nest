import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {inspectNativeInstall,installNativePlugin} from '../src/native-install.mjs';
const [action,...args]=process.argv.slice(2),at=args.indexOf('--runtime-bundle');
assert.ok(['preflight','install'].includes(action),'Use preflight|install --runtime-bundle FILE; rollback uses the official plugin select command and the recorded own-file recovery point');
assert.ok(at>=0&&args[at+1],'Provide an approved runtime bundle; this command never builds one');
assert.ok(args.length===2,'The native installer accepts only --runtime-bundle; custom Core build switches are retired');
const instancePath=join(homedir(),'.dsh/companion/aurabot-v1/instance.json'),options=JSON.parse(readFileSync(instancePath));
const bundle=resolve(args[at+1]),project=process.cwd();
if(action==='preflight'){const p=inspectNativeInstall(options,bundle,project);console.log(JSON.stringify({state:'ready',from:p.selected.version,to:p.version,sha256:p.sha256,officialConnectorModified:false}));}
else console.log(JSON.stringify(await installNativePlugin(instancePath,bundle,project)));
