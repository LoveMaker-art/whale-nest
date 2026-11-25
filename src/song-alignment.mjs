import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {openAsBlob} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {readState,writeState} from './state.mjs';
import {singingUnits} from './song-melody.mjs';

const run = promisify(execFile);
const pathFor = (dataDir,id)=>join(dataDir,'media/song-timing',id+'.json');

function scoreAlignment(song,sections) {
  const score=song.scoreTiming ?? (song.composition?.melodyMode==='graft'?null:song.composition?.melody);
  const timeline=score?.timeline;
  if(!timeline?.length)return {};
  const scale=song.durationMs>0&&score.seconds>0?song.durationMs/1000/score.seconds:1;
  const notes=timeline.map(([start,duration])=>[start*scale,duration*scale]);
  const starts=notes.filter((n,i)=>!i||n[0]-(notes[i-1][0]+notes[i-1][1])>=.35).map(n=>n[0]);
  const lengths=sections.flatMap(s=>s.lines.map(l=>singingUnits(l).length));
  const total=lengths.reduce((sum,n)=>sum+n,0);
  if(!total)return {};
  let passed=0,index=0;
  const roundIndex=value=>{const lo=Math.floor(value);return value-lo===.5 ? lo+(lo%2) : Math.round(value);};
  const rounded=value=>Math.max(0,Math.round(value*10)/10);
  const align=sections.map(s=>{
    const lineT1=[];
    const lineT=s.lines.map(()=>{
      const units=lengths[index++];
      if(!units){lineT1.push(null);return null;}
      const note=notes[Math.min(notes.length-1,roundIndex(passed/total*notes.length))];
      passed+=units;
      const end=notes[Math.min(notes.length-1,roundIndex(passed/total*notes.length))];
      const nearest=starts.reduce((a,b)=>Math.abs(b-note[0])<Math.abs(a-note[0])?b:a,starts[0]);
      lineT1.push(rounded(end[0]+end[1]-1));
      return rounded((Math.abs(nearest-note[0])<=1.5?nearest:note[0])-1);
    });
    return {...s,lineT,lineT1,t0:lineT.find(t=>t!==null),t1:Math.max(...lineT1.filter(t=>t!==null))};
  });
  const fit=total/notes.length;
  return {align,timing:{kind:fit>=.8&&fit<=1.25?'score':'loose',fit:Math.round(fit*100)/100,lead:1}};
}

export function createSongAlignment(options,{fetchImpl=fetch}={}) {
  const config = options.singing?.playback?.alignment;
  if (config) assert.ok(typeof config.configPath === 'string' && isAbsolute(config.configPath),
    'Song alignment requires an absolute configuration path');
  const active = new Map();
  const read = id=>readState(pathFor(options.dataDir,id),null);

  async function measure(song, sections, signal) {
    const {baseUrl,apiKey} = JSON.parse(await readFile(config.configPath,'utf8'));
    const url = new URL(baseUrl);
    assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && typeof apiKey === 'string' && apiKey.trim(),'Invalid SongSmith alignment configuration');
    url.pathname = url.pathname.replace(/\/$/,'')+'/api/align';
    const lines = sections.flatMap(section=>section.lines);
    const work = await mkdtemp(join(tmpdir(),'whalenest-song-alignment-'));
    const compressed = join(work,'audio.mp3');
    try {
      let media;
      try {
        await run(config.ffmpeg ?? 'ffmpeg',['-nostdin','-loglevel','error','-protocol_whitelist','file,pipe','-i',song.artifact.path,
          '-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','32k',compressed],
        {cwd:work,timeout:120000,maxBuffer:32*1024,signal});
        media = await openAsBlob(compressed,{type:'audio/mpeg'});
      } catch (error) {
        if (signal.aborted || error.code !== 'ENOENT') throw error;
        media = await openAsBlob(song.artifact.path,{type:song.artifact.mime});
      }
      const form = new FormData();
      form.set('lines',JSON.stringify(lines));
      form.set('audio',media,'recording');
      const response = await fetchImpl(url,{method:'POST',headers:{Authorization:'Bearer '+apiKey.trim()},
        body:form,signal,redirect:'error'});
      if (!response.ok) { await response.body?.cancel(); throw new Error('Alignment request failed'); }
      const output = await response.json();
      assert.ok(output?.ok && Array.isArray(output.lines),'Alignment response is invalid');
      const duration = song.durationMs/1000 || 86400;
      const accepted = new Map();
      for (const line of output.lines) {
        if (line.source === 'asr' && Number.isInteger(line.index) && line.index >= 0 && line.index < lines.length
            && Number.isFinite(line.start) && line.start >= 0 && line.start < duration) accepted.set(line.index,line.start);
      }
      const anchors = [...accepted].sort(([a],[b])=>a-b);
      assert.ok(anchors.length && anchors.every(([,time],index)=>!index || time >= anchors[index-1][1]),
        'Alignment returned no usable timing');
      writeState(pathFor(options.dataDir,song.requestId),{anchors,covered:anchors.length/lines.length});
    } finally { await rm(work,{recursive:true,force:true}); }
  }

  function start(song, sections) {
    if (!config || !sections?.length) return false;
    if (active.has(song.requestId) || read(song.requestId)) return true;
    if (active.size) return false;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal,AbortSignal.timeout(250_000)]);
    const task = measure(song,sections,signal).catch(()=>{}).finally(()=>active.delete(song.requestId));
    active.set(song.requestId,{stop,task});
    return true;
  }

  function view(song, sections) {
    if (!sections?.length) return {};
    const result = read(song.requestId);
    const refining = active.has(song.requestId);
    const resultFields = {canRefine:!!config && !result && !refining, refining};
    if (!result) return {...resultFields,...scoreAlignment(song,sections)};
    const anchors = new Map(result.anchors);
    const total = sections.reduce((n,section)=>n+section.lines.length,0);
    const limit = song.durationMs/1000 || Math.max(...anchors.values())+5;
    const points = [[-1,0],...anchors,[total,limit]];
    let index = 0, right = 1;
    const align = sections.map(section=>{
      const lineT = section.lines.map(()=>{
        while (points[right][0] < index) right++;
        const [from,t0] = points[right-1], [to,t1] = points[right];
        return t0+(t1-t0)*(index++-from)/(to-from);
      });
      return {...section,lineT,t0:lineT[0]};
    });
    return {...resultFields,align,timing:{kind:'measured',covered:result.covered}};
  }

  return {start,view,async close(){
    const running = [...active.values()];
    for (const entry of running) entry.stop.abort();
    await Promise.all(running.map(entry=>entry.task));
  }};
}
