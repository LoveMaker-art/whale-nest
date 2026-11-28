import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));

export async function buildRuntimeBase(destination,{portable=false}={}) {
  destination=resolve(destination);await mkdir(destination,{recursive:true});
  const manifest=JSON.parse(await readFile(join(root,'integration/clawchat/SOURCE.json')));
  const source=join(root,'integration/clawchat/base/linux-x64.mjs');
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),manifest.files['base/linux-x64.mjs']);
  await copyFile(source,join(destination,'official-runtime-provider.mjs'));
  const adapter=portable?'./whalenest/src/runtime-provider.mjs':pathToFileURL(join(root,'src/runtime-provider.mjs')).href;
  const entry=`import {fileURLToPath} from 'node:url';
import {createDeepSeekHarnessOfficialPluginEntry as officialFactory} from './official-runtime-provider.mjs';
import {createWhaleRuntimeEntry} from ${JSON.stringify(adapter)};
export const createDeepSeekHarnessOfficialPluginEntry=(options={})=>createWhaleRuntimeEntry(officialFactory,{...options,runtimeAdapter:{...options.runtimeAdapter,
 bridgePath:options.runtimeAdapter?.bridgePath??fileURLToPath(new URL('./deepseek-harness-bridge.mjs',import.meta.url))}});
export default createDeepSeekHarnessOfficialPluginEntry();
`;
  const file=join(destination,'linux-x64-base.mjs');await writeFile(file,entry,{mode:0o600});return file;
}
