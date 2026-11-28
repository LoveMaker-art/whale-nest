import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';

function runnerFixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'whalenest-test-runner-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
  for (const dir of ['src', 'scripts', 'test', 'deploy', 'integration', 'vendor/aurabot', 'vendor/qrcode-generator', 'vendor/platform-liveware']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(new URL('../scripts/test.mjs', import.meta.url), join(root, 'scripts/test.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, 'vendor/aurabot.provenance.json'), '{}');
  writeFileSync(join(root, 'persona.txt'), 'fixture persona');
  writeFileSync(join(root, 'upstream.lock.json'), JSON.stringify({ personaReference: { localFile: 'persona.txt' } }));
 return root;
}

test('test reuse ignores generated metadata and invalidates when vendored code changes', t => {
  const root = runnerFixture(t);
  const dependency = join(root, 'vendor/aurabot/feature.js');
  writeFileSync(dependency, 'export const value=1;');
  const qrDependency = join(root, 'vendor/qrcode-generator/qrcode.cjs');
  writeFileSync(qrDependency, 'module.exports=1;');
  const voiceDependency = join(root, 'vendor/platform-liveware/gateway.py');
  writeFileSync(voiceDependency, 'port = 8897');
  writeFileSync(join(root, 'test/example.test.mjs'), [
    "import test from 'node:test'; import {appendFileSync} from 'node:fs';",
    "test('fixture',()=>appendFileSync('executions.txt','executed\\n'));",
  ].join('\n'));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT; // The child exercises a separate CLI, not this node:test worker.
  const run = () => execFileSync(process.execPath, ['scripts/test.mjs', '--reuse', 'test/example.test.mjs'], { cwd: root, encoding: 'utf8', env: childEnv });
  run();
  writeFileSync(join(root, 'vendor/platform-liveware/._gateway.py'), 'generated metadata');
  assert.match(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 1);
  writeFileSync(dependency, 'export const value=2;');
  assert.doesNotMatch(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 2);
  writeFileSync(qrDependency, 'module.exports=2;');
  assert.doesNotMatch(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 3);
  writeFileSync(voiceDependency, 'port = 8899');
  assert.doesNotMatch(run(), /Reused passing verification/);
  assert.equal(readFileSync(join(root, 'executions.txt'), 'utf8').trim().split('\n').length, 4);
});

test('default source checks cannot build a distribution; packaging and upstream suites require separate explicit selection',t=>{
 const root=runnerFixture(t),env={...process.env};delete env.NODE_TEST_CONTEXT;
 const unit="import test from 'node:test';import {appendFileSync} from 'node:fs';test('source',()=>appendFileSync('source.txt','ran\\n'));";
 const packaged="import test from 'node:test';import {appendFileSync} from 'node:fs';test('package fixture',()=>appendFileSync('package.txt','ran\\n'));";
 writeFileSync(join(root,'test/source.test.mjs'),unit);writeFileSync(join(root,'test/distribution.test.mjs'),packaged);
 const invoke=args=>spawnSync(process.execPath,['scripts/test.mjs',...args],{cwd:root,env,encoding:'utf8',timeout:10000});
 assert.equal(invoke([]).status,0);assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'ran\n');
 assert.throws(()=>readFileSync(join(root,'package.txt')),/ENOENT/);
 assert.equal(JSON.parse(readFileSync(join(root,'.whale-nest/verification/core-latest.json'))).suite,'source');
 const blocked=invoke(['test/distribution.test.mjs']);assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/require --distribution/);
 assert.throws(()=>readFileSync(join(root,'package.txt')),/ENOENT/);
 assert.equal(invoke(['--distribution']).status,0);assert.equal(readFileSync(join(root,'package.txt'),'utf8'),'ran\n');
 assert.deepEqual(JSON.parse(readFileSync(join(root,'.whale-nest/verification/distribution-latest.json'))).selectedFiles,['test/distribution.test.mjs']);
 assert.notEqual(invoke(['--distribution','test/source.test.mjs']).status,0);
 assert.notEqual(invoke(['--distribution','--upstream']).status,0);
});
