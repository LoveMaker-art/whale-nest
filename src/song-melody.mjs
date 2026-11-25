import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {inspectSongScore} from './song-score.mjs';

// Use the original SongSmith phrase splitter, including rests and long phrases.
const context = {};
runInNewContext(await readFile(new URL('../vendor/platform-liveware/songsmith/static/melody.js',import.meta.url),'utf8'),context);
const cache = new Map();
const fraction = value => { const [a,b=1] = String(value).split('/').map(Number); return a/b; };
const tag = value => String(value ?? '').trim().toLowerCase().replace(/\s+\d+$/,'');

export async function analyzeSongMelody(abc, {meta,python,signal} = {}) {
  assert.ok(typeof abc==='string' && Buffer.byteLength(abc)<=128*1024,'乐谱为空或过大');
  const key = createHash('sha256').update(abc).digest('hex');
  let result = cache.get(key);
  if (!result) {
    const score = await inspectSongScore(abc,{python,signal});
    const vocal = score.voices.Vocal;
    assert.ok(vocal?.sounding_notes && vocal.sounding_notes<=4096,'乐谱需要有效的演唱声部');
    const notes = vocal.notes.map(n=>[fraction(n.onset_quarters)*4,fraction(n.duration_quarters)*4,n.midi_pitch]);
    const sections = [];
    let offset = 0;
    for (const group of score.groups.filter(g=>g.voice==='Vocal')) {
      const first = offset;
      offset += group.bars.length;
      const start = fraction(vocal.bars[first]?.[0])*4;
      const last = vocal.bars[offset-1];
      assert.ok(last,'乐谱小节结构不完整');
      const end = (fraction(last[0])+fraction(last[1]))*4;
      const current = sections.at(-1);
      if (current && current.sourceTag===group.section) current.to=end,current.bars[1]=offset;
      else sections.push({tag:tag(group.section),sourceTag:group.section,bars:[first+1,offset],from:start,to:end});
    }
    assert.equal(offset,vocal.measures,'无法确定乐谱段落');
    result = {bpm:score.bpm,key:vocal.keys[0]?.[1],bars:vocal.measures,
      seconds:score.nominal_duration_seconds,notes:vocal.sounding_notes,
      timeline:notes.map(([on,dur])=>[on/4*60/score.bpm,dur/4*60/score.bpm]),
      sections:sections.map(s=>({tag:s.tag,bars:s.bars,
        phrases:Array.from(context.Melody.phrasesOf(notes.filter(n=>n[0]>=s.from && n[0]<s.to)),p=>({notes:p.notes,bars:Array.from(p.bars)}))}))
        .filter(s=>s.phrases.length)};
    assert.ok(result.sections.length && result.sections.every(s=>s.tag),'乐谱缺少演唱段落标记');
    cache.set(key,result);
    if (cache.size>64) cache.delete(cache.keys().next().value);
  }
  if (meta!==undefined) {
    assert.ok(meta && typeof meta==='object' && !Array.isArray(meta),'旋律资料无效');
    if (meta.sections!==undefined) {
      assert.ok(Array.isArray(meta.sections),'乐句资料无效');
      const plan = rows=>rows.map(s=>({tag:tag(s.tag),phrases:(s.phrases??[]).map(p=>p.notes)}));
      assert.deepEqual(plan(meta.sections),plan(result.sections),'乐句音符数与保存的原谱不一致');
    }
    if (meta.bpm!==undefined) assert.equal(meta.bpm,result.bpm,'旋律速度与原谱不一致');
    if (meta.bars!==undefined) assert.equal(meta.bars,result.bars,'旋律小节数与原谱不一致');
    if (meta.key!==undefined) assert.equal(meta.key,result.key,'旋律调性与原谱不一致');
  }
  return structuredClone(result);
}

// Port of SongSmith serve.py sing_units: CJK units and an English syllable estimate.
export function singingUnits(line) {
  const units = [];
  const small = new Set('ゃゅょゎぁぃぅぇぉャュョヮァィゥェォ');
  const skip = new Set('っッ');
  const source = String(line ?? '').trim();
  for (let i=0;i<source.length;) {
    const c=source[i];
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(c)) {
      if (!skip.has(c) && !(small.has(c)&&units.length)) units.push(c);
      i++;continue;
    }
    if (c==='ー'&&units.length) {i++;continue;}
    const word=/^[A-Za-zÀ-ÖØ-öø-ÿ']+/.exec(source.slice(i))?.[0];
    if (word) {
      const t=word.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
      let n=(t.match(/[aeiouy]+/g)??[]).length;
      if (t.endsWith('e')&&n>1&&!/(le|ee|ye)$/.test(t)) n--;
      units.push(...Array(Math.max(n,1)).fill(word));i+=word.length;continue;
    }
    i++;
  }
  return units;
}

export function songLyricSections(lyrics) {
  const sections=[];
  for (const line of String(lyrics??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)) {
    const heading=/^\[([^\[\]]+)\]$/.exec(line);
    if (heading) sections.push({tag:tag(heading[1]),lines:[]});
    else { if (!sections.length) sections.push({tag:'',lines:[]}); sections.at(-1).lines.push(line); }
  }
  return sections.filter(s=>s.lines.length);
}

export function validateSongLyrics(lyrics, melody) {
  const sections=songLyricSections(lyrics),expected=melody.sections;
  const plan=expected.map(s=>'['+s.tag+'] '+s.phrases.map(p=>p.notes).join('/')).join(' · ');
  assert.equal(sections.length,expected.length,'歌词段落必须与原谱对应：'+plan+'；不能额外添加段落。');
  for (const [i,section] of sections.entries()) {
    const target=expected[i];
    assert.equal(section.tag,target.tag,'歌词段落顺序必须与原谱对应：'+plan);
    assert.equal(section.lines.length,target.phrases.length,'['+target.tag+'] 需要 '+target.phrases.length+' 个乐句，每句按音符数填词：'+plan);
    for (const [j,line] of section.lines.entries()) {
      const actual=singingUnits(line).length,wanted=target.phrases[j].notes;
      const estimated=/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(line);
      assert.ok(estimated ? actual>=Math.ceil(wanted*.8)&&actual<=Math.floor(wanted*1.25) : actual===wanted,
        '['+target.tag+'] 第 '+(j+1)+' 句需要 '+wanted+' 个发音单位，当前'+(estimated?'估算':'')+'为 '+actual+'；请修改歌词，原谱保持不变。');
    }
  }
  return {ok:true,plan,units:sections.flatMap(s=>s.lines.map(l=>singingUnits(l).length))};
}

export function revisionLyricPlan(lyrics) {
  return {sections:songLyricSections(lyrics).map(s=>({tag:s.tag,phrases:s.lines.map(line=>({notes:singingUnits(line).length}))}))};
}

export function songMelodyFacts(material) {
  if (!material?.abc) return undefined;
  const {timeline,...details}=material.melody??{};
  return {id:material.melodyId??null,kind:material.melodyKind??'version',
    mode:material.melodyMode??'keep',attached:true,...details,
    ...(material.scoreEdit?{edit:material.scoreEdit}: {}),
    ...(material.melodyMode==='graft'?{attached:false,planned:true}: {})};
}
