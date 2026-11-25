import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {sniffMedia} from './media.mjs';
import {readState,writeState} from './state.mjs';
import {analyzeSongMelody} from './song-melody.mjs';

export const songIdPattern = /^whalenest-song-[a-f0-9]{64}$/;
const audioPattern = /^\/song\/(whalenest-song-[a-f0-9]{64})\/stream$/;
const melodyPattern = /^(hum|draw)-[a-f0-9]{32}$/;
const viewerPattern = /^usr_[\w-]{1,128}$/;
const hash = data=>createHash('sha256').update(data).digest('hex');
const bounded = (value, limit)=>typeof value === 'string' ? value.trim().slice(0,limit) : '';

export const songProject = record => record.projectId ?? record.requestId;
export const songVersion = record => record.version ?? 1;
export const shareId = id => hash(id).slice(0,24);

export function songAudience(options) {
  const list = options.singing?.playback?.audience ?? [];
  assert.ok(Array.isArray(list) && list.length <= 100 && list.every(id=>typeof id === 'string' && viewerPattern.test(id)),
    'Song Liveware audience must contain verified ClawChat user IDs');
  return new Set(list);
}

export function validMelody(abc) {
  return typeof abc === 'string' && Buffer.byteLength(abc) <= 128 * 1024
    && /^X:\s*\d+/m.test(abc) && /^K:\s*\S/m.test(abc)
    && abc.split('\n').some(line=>!/^(?:%|[A-Za-z]:)/.test(line.trim()) &&
      /[A-Ga-g]/.test(line.replace(/\[[^\]]*\]|"[^"]*"/g,'')));
}

/** Resolve only references in the authenticated user's own chat turn. */
export async function songRequestMaterial(dataDir, client, text, inspection={}) {
  const melody = /〔旋律:((?:hum|draw)-[a-f0-9]{32})(?::(whole|graft))?〕/.exec(text);
  const melodyId = melody?.[1];
  const revision = /〔版本:(whalenest-song-[a-f0-9]{64}):(keep|change)〕/.exec(text);
  assert.ok((!text.includes('〔旋律:') || melodyId) && (!text.includes('〔版本:') || revision),
    '创作草稿的乐谱或作品编号已损坏，请从作品页重新打开');
  assert.ok(!melodyId || !revision,'一次写歌只能使用一份旋律');
  assert.ok((text.match(/〔(?:旋律|版本):/g)??[]).length<=1,'一次写歌只能引用一份旋律或原版本');
  if (melodyId) {
    const stored = readState(join(dataDir,'media/song-melodies',melodyId+'.json'),null);
    assert.ok(stored?.id === melodyId && validMelody(stored.abc),'找不到该旋律，请从创作页重新保存');
    const details=await analyzeSongMelody(stored.abc,inspection);
    return {abc:stored.abc, melodyId, melodyKind:melodyId.split('-')[0], melodyMode:melody[2] ?? 'graft',melody:details};
  }
  if (!revision) return {};
  const previous = client.inspect(revision[1]);
  assert.ok(previous?.state === 'saved' && !isArchivedSong(dataDir,previous),'找不到这一版作品');
  const projectId = songProject(previous);
  const history = client.list().filter(record=>songProject(record) === projectId);
  const version = Math.max(1,...history.map(songVersion)) + 1;
  if (revision[2] === 'change') return {projectId, parentId:previous.requestId, version};
  const abc = await client.score(previous.requestId);
  assert.ok(validMelody(abc),'这一版的原乐谱暂不可读取');
  return {projectId, parentId:previous.requestId, version, abc,melody:await analyzeSongMelody(abc,inspection),
    ...(previous.composition?.melodyMode==='whole'?{}:{lyricTemplate:previous.parameters.lyrics})};
}

const studioPath = dataDir => join(dataDir,'media/song-studio.json');
const studioState = dataDir => readState(studioPath(dataDir),
  {archived:{},covers:{},shares:{},likes:{},comments:{}});
const archived = (state, record) => !!state.archived[record.requestId];

export function isArchivedSong(dataDir, record) {
  return archived(studioState(dataDir),record);
}

function coverRecord(dataDir, id, key) {
  return readState(join(dataDir,'media/song-covers',id+'-'+key+'.json'),null);
}

export function createSongStudio(dataDir, listSaved, inspection={}) {
  const staged = new Map();
  const read = () => studioState(dataDir);
  const lookup = (state, id) => songIdPattern.test(id ?? '') ?
    listSaved().find(record=>record.requestId === id && !archived(state,record)) : undefined;
  const audioId = value => audioPattern.exec(value ?? '')?.[1];

  async function upload(path, key, query, commit) {
    const op = query.get('op'), transfer = query.get('id');
    if (!/^[a-z0-9_-]{6,32}$/i.test(transfer ?? '')) return null;
    const now = Date.now();
    for (const [id, part] of staged) if (now - part.at > 600_000) staged.delete(id);
    const id = path + ':' + key + ':' + transfer;
    if (op === 'abort') { staged.delete(id); return {ok:true}; }
    const max = path === '/api/hum' ? 32 * 1024 : 200 * 1024;
    if (op === 'chunk') {
      const encoded = query.get('data') ?? '';
      const offset = Number(query.get('off'));
      const bytes = Buffer.from(encoded,'base64');
      if (!/^(?:[A-Za-z0-9+/]+={0,2})$/.test(encoded) || bytes.toString('base64') !== encoded ||
        !Number.isSafeInteger(offset) || offset < 0 || !bytes.length || offset + bytes.length > max ||
        !staged.has(id) && staged.size >= 8) return null;
      const part = staged.get(id) ?? {parts:new Map(),at:now,size:0};
      const size = part.size - (part.parts.get(offset)?.length ?? 0) + bytes.length;
      if (size > max) return null;
      part.parts.set(offset,bytes);
      part.at = now;
      part.size = size;
      staged.set(id,part);
      return {ok:true,n:bytes.length,at:offset+bytes.length};
    }
    if (op !== 'commit') return null;
    const part = staged.get(id);
    if (!part) return null;
    let size = 0;
    const chunks = [];
    for (const [offset, bytes] of [...part.parts.entries()].sort(([a],[b])=>a-b)) {
      if (size !== offset) return null;
      chunks.push(bytes);
      size += bytes.length;
    }
    const result = await commit(Buffer.concat(chunks));
    staged.delete(id);
    return result;
  }

  async function mutate(path, query, viewer, owner) {
    const state = read();
    const op = query.get('op');
    if (path === '/api/admin') {
      const on = query.get('on');
      if (!owner || op!=='set' || query.get('key')!=='comments' || !['0','1'].includes(on)) return null;
      state.commentsOn = on==='1';
      writeState(studioPath(dataDir),state);
      return {admin:true};
    }
    if (path === '/api/comment' && state.commentsOn === false) return null;
    const id = audioId(query.get('audio'));
    const song = lookup(state,id);
    const project = query.get('project');
    if (path === '/api/hum' && owner) return upload(path,viewer,query,async bytes=>{
      const abc = bytes.toString('utf8');
      if (!validMelody(abc) || !Buffer.from(abc).equals(bytes)) return null;
      const kind = query.get('kind');
      if (!['hum','draw'].includes(kind)) return null;
      const id = kind + '-' + hash(abc).slice(0,32);
      assert.match(id,melodyPattern);
      const file = join(dataDir,'media/song-melodies',id+'.json');
      let details,meta;
      try {
        const value=query.get('meta');
        if (value && value.length>8192) return null;
        meta=value ? JSON.parse(value) : undefined;
        details=await analyzeSongMelody(abc,{...inspection,meta});
      } catch { return null; }
      const old=readState(file,null);
      const quality=meta?.quality && typeof meta.quality==='object' && JSON.stringify(meta.quality).length<=2048 ? meta.quality : undefined;
      writeState(file,{id,kind,abc,createdAt:old?.createdAt??new Date().toISOString(),...details,...(quality?{quality}: {})});
      return {ok:true,id,kind,notes:details.notes,sections:details.sections,seconds:details.seconds};
    });
    if (path === '/api/cover' && owner && songIdPattern.test(project ?? '') &&
        listSaved().some(record=>songProject(record) === project && !archived(state,record))) {
      return upload(path,project,query,bytes=>{
        const mime = sniffMedia(bytes);
        if (!['image/jpeg','image/png','image/webp'].includes(mime)) return null;
        const key = hash(bytes);
        writeState(join(dataDir,'media/song-covers',project+'-'+key+'.json'),{key,mime,base64:bytes.toString('base64')});
        state.covers[project] = key;
        writeState(studioPath(dataDir),state);
        return {ok:true,cover:'/cover/'+project+'?v='+key};
      });
    }
    if (path === '/api/share' && owner && song && ['set','unset'].includes(op)) {
      if (op === 'set') state.shares[id] = {title:bounded(query.get('title'),80),desc:bounded(query.get('desc'),200),at:state.shares[id]?.at ?? Date.now()};
      else delete state.shares[id];
    } else if (path === '/api/like' && song && state.shares[id] && ['set','unset'].includes(op)) {
      const likes = new Set(state.likes[id] ?? []);
      if (op === 'set') likes.add(viewer);
      else likes.delete(viewer);
      state.likes[id] = [...likes];
    } else if (path === '/api/comment' && op === 'add' && song && state.shares[id]) {
      const text = bounded(query.get('text'),80);
      if (!text) return null;
      const rows = state.comments[id] ?? [];
      if (rows.length >= 250) return null;
      const nonce = query.get('request');
      if (!/^[a-f0-9-]{16,64}$/i.test(nonce ?? '')) return null;
      const key = hash(viewer+':'+nonce).slice(0,24);
      if (!rows.some(row=>row.id===key))
        state.comments[id] = [...rows,{id:key,by:viewer,text,at:Date.now()}];
    } else if (path === '/api/comment' && op === 'del') {
      const key = query.get('id');
      const entry = Object.entries(state.comments).find(([id, rows])=>state.shares[id] &&
        rows.some(row=>row.id === key && (owner || row.by === viewer)));
      if (!entry) return null;
      state.comments[entry[0]] = entry[1].filter(row=>row.id !== key);
    } else if (path === '/api/delete' && owner && ['take','project'].includes(op)) {
      const affected = op === 'take' ? (song ? [song] : []) :
        listSaved().filter(record=>songProject(record) === project && !archived(state,record));
      if (!affected.length) return null;
      for (const record of affected) {
        state.archived[record.requestId] = Date.now();
        delete state.shares[record.requestId];
      }
    } else return null;
    writeState(studioPath(dataDir),state);
    return {ok:true,data:true};
  }

  return {read,mutate,coverRecord:(id,key)=>coverRecord(dataDir,id,key)};
}
