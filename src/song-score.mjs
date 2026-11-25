import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const tools = fileURLToPath(new URL('../vendor/platform-liveware/songsmith/abc_tools.py',import.meta.url));

export async function inspectSongScore(abc, {python = 'python3', signal} = {}) {
  const work = await mkdtemp(join(tmpdir(),'whalenest-score-inspection-'));
  const input = join(work,'input.abc');
  try {
    await writeFile(input,abc,{mode:0o600});
    const program = 'import sys,json;sys.path.insert(0,sys.argv[1]);import abc_tools;'
      + 'text=open(sys.argv[2],encoding="utf-8").read();score=abc_tools.parse(text);'
      + 'result=abc_tools.report(score);result["groups"]=abc_tools.music_groups(text);print(json.dumps(result,default=abc_tools.json_value))';
    const {stdout} = await run(python,['-B','-c',program,fileURLToPath(new URL('../vendor/platform-liveware/songsmith/',import.meta.url)),input],
      {cwd:work,signal,timeout:10000,maxBuffer:2*1024*1024});
    return JSON.parse(stdout);
  } catch(error) {
    if(signal?.aborted)throw error;
    throw new Error('原谱结构无法读取，请核对乐谱及实例 Python 配置；没有提交生成任务。',{cause:error});
  } finally { await rm(work,{recursive:true,force:true}); }
}

export async function verifySongScoreEdit(before, after, {mode,startBar,endBar,python,signal}={}) {
  assert.ok(['tempo','arrangement','phrase','structure'].includes(mode),'需要明确乐谱修改类型');
  const original=await inspectSongScore(before,{python,signal});
  const edited=await inspectSongScore(after,{python,signal});
  const equal=(a,b,message)=>assert.deepEqual(a,b,message);
  if(mode!=='tempo')equal(original.bpm,edited.bpm,'本次修改不能改变原谱速度');
  if(mode!=='structure')for(const name of ['Vocal','Ins'])equal(original.voices[name].bars,edited.voices[name].bars,'本次修改不能改变原谱的小节与拍号');
  if(mode==='tempo'||mode==='arrangement')for(const name of ['Vocal','Ins'])equal(original.voices[name].notes,edited.voices[name].notes,'本次修改必须保留原谱的音高、起点和时值');
  if(mode==='phrase'){
    const voice=original.voices.Vocal;
    assert.ok(Number.isInteger(startBar)&&Number.isInteger(endBar)&&startBar>=1&&endBar>=startBar&&endBar<=voice.measures,'请指定实际修改的小节范围');
    const value=v=>{const [a,b=1]=String(v).split('/').map(Number);return a/b;};
    const from=value(voice.bars[startBar-1][0]);
    const final=voice.bars[endBar-1],to=value(final[0])+value(final[1]);
    const outside=notes=>notes.filter(n=>value(n.onset_quarters)<from||value(n.onset_quarters)+value(n.duration_quarters)>to||value(n.onset_quarters)>=to);
    equal(outside(original.voices.Vocal.notes),outside(edited.voices.Vocal.notes),'指定小节以外的演唱旋律必须保持不变');
    equal(original.voices.Ins.notes,edited.voices.Ins.notes,'局部演唱旋律修改不能改变原伴奏音符');
  }
  return {mode,verified:true,...(mode==='phrase'?{startBar,endBar}: {}),
    preserved:mode==='tempo'||mode==='arrangement'?'all-sounding-notes':mode==='phrase'?'notes-outside-selected-bars':'validated-score-structure'};
}

export async function graftSongScore(plan, motif, {python = 'python3', signal} = {}) {
  const work = await mkdtemp(join(tmpdir(),'whalenest-song-score-'));
  const input = join(work,'plan.abc'), phrase = join(work,'phrase.abc');
  const grafted = join(work,'grafted.abc'), output = join(work,'result.abc');
  const exec = (args) => run(python,['-B',tools,...args],{timeout:10000,maxBuffer:64*1024,signal,cwd:work});
  try {
    await Promise.all([writeFile(input,plan,{mode:0o600}),writeFile(phrase,motif,{mode:0o600})]);
    const {stdout} = await exec(['graft',input,phrase,grafted,'--section','chorus']);
    await exec(['strip-chords',grafted,output]);
    const {section,times} = JSON.parse(stdout);
    return {abc:await readFile(output,'utf8'),section,times};
  } finally {
    await rm(work,{recursive:true,force:true});
  }
}
