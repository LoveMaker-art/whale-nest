import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fixtureDirectory,boot,input} from './host-helper.mjs';
import {workspaceInstructionsSource} from '../src/workspace-instructions.mjs';

test('native DSH loads the managed AGENTS.md once, retains user notes on restart and keeps the selected persona unchanged', {timeout:60000},async t=>{
  const f=await fixtureDirectory();let host;
  t.after(async()=>{await host?.close();await rm(f.root,{recursive:true,force:true});});
  const path=join(f.options.cwd,'AGENTS.md');await writeFile(path,'NATIVE_USER_RULE_BEFORE\n');
  host=await boot(f);
  assert.equal((await host.request('status')).workspaceInstructions.state,'managed');
  await host.request('receive',{input:input('managed-agents-first','hello')});
  const traces=async()=>(await readFile(join(f.root,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const first=(await traces()).at(-1),text=JSON.stringify({system:first.system,messages:first.messages});
  const overview=JSON.stringify(workspaceInstructionsSource().template.trimEnd()).slice(1,-1);
  assert.ok(text.includes(overview));assert.match(text,/NATIVE_USER_RULE_BEFORE/);
  assert.equal(text.split(overview).length-1,1,'the managed overview enters through native file loading only');
  assert.ok(first.messages.some(m=>m.source?.kind==='agent-instructions'),'actual native instruction projection is present');
  const personaPath=join(f.options.dataDir,'aurabot/personas/dafeiyu-original.md'),persona=await readFile(personaPath,'utf8');
  await host.close();host=null;await appendFile(path,'\nNATIVE_USER_RULE_AFTER\n');
  host=await boot(f);await host.request('receive',{input:input('managed-agents-restart','hello again')});
  const last=(await traces()).at(-1),next=JSON.stringify({system:last.system,messages:last.messages});
  assert.match(next,/NATIVE_USER_RULE_AFTER/);assert.ok(next.includes(overview));
  assert.equal(await readFile(personaPath,'utf8'),persona);
});
