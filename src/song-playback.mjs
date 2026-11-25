import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {constants,createReadStream} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createSongClient} from './song-client.mjs';
import {readBoundClawChatAgentId} from './clawchat-state.mjs';
import {resolveDeliveryTarget} from './routing.mjs';
import {readState} from './state.mjs';
import {createSongStudio,isArchivedSong,shareId,songAudience,songIdPattern,songProject,songVersion} from './song-studio.mjs';
import {createSongAlignment} from './song-alignment.mjs';
import nativeTags from '../vendor/platform-liveware/songsmith/tags.json' with {type:'json'};

const songPath = /^\/(whalenest-song-[a-f0-9]{64})(?:\/(stream|score|lyrics))?$/;
const formats = {'audio/wav':'wav','audio/mpeg':'mp3','audio/flac':'flac'};
const songsmith = new URL('../vendor/platform-liveware/songsmith/',import.meta.url);
const scoreScript = new URL('../vendor/abcjs/abcjs-basic-min.js',import.meta.url);
const rangeLimit = 512 * 1024;
const tagPatterns = nativeTags.map(rows=>rows.map(([pattern,key])=>[new RegExp(pattern),key]));
const tagDims = ['dimLang','dimGenre','dimVocal','dimMood','dimTempo'].map((name,i)=>({name,
  tags:i===4?['tempo.slow','tempo.mid','tempo.fast']:tagPatterns[i].map(([,key])=>key)}));
const calendar = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});

function songTags(style) {
  const lower = typeof style === 'string' ? style.toLowerCase() : '';
  const language = tagPatterns[0].map(([rx,key])=>[lower.search(rx),key]).filter(([at])=>at>=0).sort(([a],[b])=>a-b)[0]?.[1];
  const inOrder = (dimension,max=1)=>[...new Set(tagPatterns[dimension].filter(([rx])=>rx.test(lower)).map(([,key])=>key))].slice(0,max);
  const bpm = Number(/(\d{2,3})\s*bpm/.exec(lower)?.[1]);
  const tempo = bpm ? (bpm<80?'tempo.slow':bpm<120?'tempo.mid':'tempo.fast') : inOrder(4)[0];
  return [language,...inOrder(1),...inOrder(2),...inOrder(3,2),tempo].filter(Boolean);
}

function lyricsData(lyrics) {
  if (typeof lyrics !== 'string' || !lyrics.trim()) return undefined;
  const sections = [{tag:'',lines:[]}];
  for (const line of lyrics.trim().split(/\r?\n/)) {
    const tag = /^\[([^\[\]]+)\]$/.exec(line.trim())?.[1];
    if (tag) sections.push({tag,lines:[]});
    else if (line.trim()) sections.at(-1).lines.push(line.trim());
  }
  return {snapshot:true,sections:sections.filter(section=>section.lines.some(line=>line.trim()))};
}

function songTake(song, state, alignment) {
  const id = song.requestId;
  const shared = state?.shares[id];
  const ms = song.durationMs;
  const secs = Math.floor(ms/1000);
  const lyrics = lyricsData(song.parameters?.lyrics);
  return {id,note:song.parameters?.title,v:songVersion(song),parent:song.parentId,ms,
    dur:Number.isFinite(secs) ? Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0') : undefined,
    bytes:song.artifact.size,audio:'/song/'+id+'/stream',score:'/song/'+id+'/score',
    lyrics,shared:!!shared,sharedTitle:shared?.title,sharedDesc:shared?.desc,tags:song.tags??songTags(song.parameters?.style),
    ...alignment?.view(song,lyrics?.sections),
    melody:song.composition?.melodyKind,melody_mode:song.composition?.melodyMode,
    melody_section:song.melodySection,
    created:Date.parse(song.createdAt)/1000 || undefined};
}

function busySong(song) {
  const active = ['submitting','queued','running','ready'].includes(song.state) && !song.pollingHeld;
  const failed = song.state === 'failed' || song.state === 'uncertain' || !!song.pollingHeld && song.state !== 'saved';
  if (!active && !failed) return null;
  const stage = song.state === 'ready' ? 'saving' : song.phase === 'plan' ? 'planning' : song.stage;
  return {slug:songProject(song),seed:song.requestId,version:songVersion(song),stage,failed,error:failed?song.error:null,
    queued:['submitting','queued'].includes(song.state),note:song.parameters?.title};
}

function songsmithData(records, dataDir, mode, {agentId, studio, viewer, owner, audience, actionToken, alignment}) {
  const state = studio.read();
  const cover = id => state.covers[id] ? '/cover/'+id+'?v='+state.covers[id] : undefined;
  const projects = new Map(), shared = [];
  const songs = records.filter(song=>song && songIdPattern.test(song.requestId) &&
    (mode === 'demo' || !state.archived[song.requestId]));
  const roots = new Map(records.filter(Boolean).map(song=>[song.requestId,song]));
  const busy = [];
  for (const song of songs) {
    const id = song.requestId, slug = songProject(song);
    const saved = savedSong(song,dataDir);
    const pending = mode === 'owner' ? busySong(song) : null;
    if (!saved && !pending) continue;
    // A demo chooses one recording and never exposes private project metadata.
    const root = mode === 'demo' ? song : roots.get(slug) ?? song;
    const title = root.parameters?.title || '未命名歌曲';
    const visibleSlug = mode === 'demo' ? id : slug;
    const take = saved ? songTake(song,mode === 'demo' ? null : state, mode === 'demo' ? null : alignment) : null;
    if (take && mode === 'demo') { take.v = 1; delete take.parent; }
    if (mode !== 'guest') {
      const project = projects.get(visibleSlug) ?? {slug:visibleSlug,title,brief:root.parameters?.style,
        cover:mode === 'owner' ? cover(slug) : undefined,takes:[],busy:[]};
      if (take) project.takes.push(take);
      if (pending) { project.busy.push(pending); busy.push(pending); }
      projects.set(visibleSlug,project);
    }
    const entry = mode === 'demo' ? null : state.shares[id];
    if (take && entry) {
      const likes = (state.likes[id] ?? []).filter(by=>by===owner || audience.has(by));
      const comments = (state.commentsOn === false ? [] : state.comments[id] ?? []).filter(row=>row.by===owner || audience.has(row.by))
        .map(row=>({id:row.id,text:row.text,at:row.at/1000,byName:row.by===owner?'主人':undefined,
          canDel:mode==='owner'||row.by===viewer}));
      const {audio,lyrics,dur,v,bytes,ms,tags,timing,align} = take;
      const sharedTitle = entry.title||title;
      shared.push({audio,lyrics,dur,v,bytes,ms,tags,timing,align,sid:shareId(id),
        title:sharedTitle,desc:entry.desc,project:mode==='guest'?sharedTitle:title,cover:cover(slug),
        by:mode==='owner'?viewer:'owner',byName:'主人',liked:likes.includes(viewer),likes:likes.length,comments,at:entry.at/1000});
    }
  }
  for (const project of projects.values()) project.takes.sort((a,b)=>a.v-b.v);
  shared.sort((a,b)=>b.at-a.at);
  const data = {title:'鲸栖歌曲',whalenest:true,demo:mode==='demo',guest:mode==='guest',agentId,
    me:mode==='owner'?viewer:undefined,isOwner:mode==='owner',commentsOn:mode!=='demo' && state.commentsOn!==false,hasAudience:audience.size>0,
    actionToken,projects:[...projects.values()],shared,busy,tagDims};
  return {...data,v:createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,16)};
}

function savedSong(song, dataDir) {
  const artifact = song?.artifact;
  const extension = artifact && formats[artifact.mime];
  return song?.state === 'saved' && songIdPattern.test(song.requestId) && extension
    && Number.isSafeInteger(artifact.size) && artifact.size > 0
    && artifact.path === join(dataDir,'media/outgoing/songs',song.requestId + '.' + extension);
}

function publication(options) {
  const owner = options.clawchat?.route;
  try {
    const entry = readState(join(options.dataDir,'song-liveware.json'),null);
    if (!entry || !owner || entry.binding !== owner.account || entry.owner !== owner.sender) return null;
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || !/^app-[a-z0-9-]+\.apps\.clawling\.io$/.test(url.hostname)
        || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') return null;
    if (entry.publicDemoWorkId !== undefined && !songIdPattern.test(entry.publicDemoWorkId)) return null;
    return {url, demo:entry.publicDemoWorkId};
  } catch { return null; }
}

export function songPlaybackUrl(options, record) {
  if (record?.state!=='saved') return null;
  return songProjectUrl(options,record);
}

export function songProjectUrl(options, record) {
  if (!options.singing?.playback?.enabled || !record || !songIdPattern.test(record.requestId) ||
      (options.dataDir && isArchivedSong(options.dataDir,record))) return null;
  const app = publication(options);
  if (!app || app.demo && (app.demo !== record.requestId || !record.selftest)) return null;
  app.url.pathname = '/song/' + record.requestId;
  return app.url.href;
}

function byteRange(header, size) {
  const match = typeof header === 'string' && /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0,size - Number(match[2]));
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return {start,end:Math.min(end,size - 1,start + rangeLimit - 1)};
}

export async function startSongPlayback(options, {client = createSongClient(options), alignment = createSongAlignment(options), readAgentId = readBoundClawChatAgentId} = {}) {
  const owner = options.clawchat?.route;
  assert.ok(client.enabled && owner && resolveDeliveryTarget(options,{origin:owner}).ok,'Song Liveware needs a verified ClawChat owner');
  const port = options.singing.playback.port ?? 8898;
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535,'Invalid song Liveware port');
  const [template,admin,translations,abc,melody] = await Promise.all([
    readFile(new URL('app.html',songsmith),'utf8'),readFile(new URL('admin.html',songsmith),'utf8'),
    readFile(new URL('static/i18n.js',songsmith)),readFile(scoreScript),
    readFile(new URL('static/melody.js',songsmith)),
  ]);
  const hash = bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,12);
  const translationPath = '/static/songsmith-i18n-'+hash(translations)+'.js';
  const abcPath = '/static/abcjs-'+hash(abc)+'.js';
  const melodyPath = '/static/songsmith-melody-'+hash(melody)+'.js';
  const assets = new Map([[translationPath,translations],[abcPath,abc],[melodyPath,melody]]);
  const {dataDir} = options;
  const audience = songAudience(options);
  audience.delete(owner.sender);
  const studio = createSongStudio(dataDir,()=>client.list().filter(song=>savedSong(song,dataDir)),{python:options.singing?.python});
  const token = randomBytes(24).toString('hex');

  async function libraryData(demo, mode, viewer) {
    const records = demo ? [client.inspect(demo)].filter(song=>song?.selftest) : client.list();
    const songs=records.map(song=>({...song,scoreTiming:client.scoreDetails?.(song.requestId)??song.scoreTiming}));
    const agentId = mode === 'owner' ? await readAgentId(options.clawchat) : null;
    return songsmithData(songs,dataDir,mode,{agentId,studio,viewer,owner:owner.sender,
      audience,actionToken:demo?undefined:token,alignment});
  }

  function renderPage(data, route, res, respond) {
    respondHtml(template,'DATA',JSON.stringify({...data, route}),data.title,res,respond);
  }

  function respondHtml(page, dataKey, data, title, res, respond) {
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'nonce-"+nonce+"'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const fields = {[dataKey]:data.replaceAll('<','\\u003c'),TITLE:title,HTMLLANG:'zh',
      I18N:'<script src="'+translationPath+'"></script>',V:'1.0.6'};
    const html = page.replace('<script>','<script nonce="'+nonce+'">')
      .replace('/static/abcjs-basic-min.js?v=__V__',abcPath)
      .replace('/static/melody.js?v=__MV__',melodyPath)
      .replace(/__(DATA|ADMIN|TITLE|HTMLLANG|I18N|V)__/g,(_,key)=>fields[key]);
    respond('text/html; charset=utf-8',html);
  }

  function administration() {
    const state = studio.read();
    const records = client.list().filter(record=>savedSong(record,dataDir) && !state.archived[record.requestId]);
    const now = Date.now(), dayMs = 24 * 60 * 60 * 1000;
    const recent = new Map();
    for (const record of records) {
      const at = Date.parse(record.createdAt);
      if (Number.isFinite(at)) {
        const day = calendar.format(at);
        recent.set(day,(recent.get(day)??0)+1);
      }
    }
    const days = Array.from({length:30},(_,i)=>{
      const date = calendar.format(now - i*dayMs);
      const total = recent.get(date) ?? 0;
      return {date,total,owner:total,guests:0};
    });
    const count = rows=>rows.reduce((sum,day)=>sum+day.total,0);
    return {actionToken:token,server_time:now,conf:{comments:state.commentsOn!==false},
      friends:{count:audience.size,list:[...audience].map(id=>({id}))},
      production:{total:records.length,owner_total:records.length,guest_total:0,guests:0,
        projects:new Set(records.map(songProject)).size,today_total:days[0].total,
        last7:count(days.slice(0,7)),last30:count(days),days:days.slice(0,14).reverse()}};
  }

  const server = createServer((req,res) => {
    handle(req,res).catch(() => {
      if (!res.headersSent && !res.destroyed) res.writeHead(503).end();
      else res.destroy();
    });
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;

  async function handle(req,res) {
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (readOnly && req.url === '/healthz') { res.writeHead(200,{'Content-Type':'text/plain'}).end('ok'); return; }
    const {pathname:path,searchParams:query} = new URL(req.url,'http://localhost');
    const demo = publication(options)?.demo;
    // A public test app serves only its explicitly selected test work, even
    // when the request carries an owner header.
    const viewer = req.headers['x-clawchat-user-id'];
    const mode = demo ? 'demo' : viewer === owner.sender ? 'owner' : audience.has(viewer) ? 'guest' : null;
    if (!mode) { res.writeHead(404).end(); return; }
    const respond = (type, body) => {
      res.writeHead(200,{'Content-Type':type});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = value => respond('application/json; charset=utf-8',JSON.stringify(value));
    if (!readOnly) {
      if (req.method !== 'POST' || mode === 'demo' || query.get('token') !== token ||
          req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(405,{Allow:'GET, HEAD'}).end(); return; }
      let result;
      if (mode==='owner' && path==='/api/refine') {
        const match = /^\/song\/(whalenest-song-[a-f0-9]{64})\/stream$/.exec(query.get('audio')??'');
        const song = match && client.inspect(match[1]);
        if (savedSong(song,dataDir) && !studio.read().archived[song.requestId]
            && alignment.start(song,lyricsData(song.parameters?.lyrics)?.sections)) result = {data:true};
      } else result = await studio.mutate(path,query,viewer,mode==='owner');
      if (!result) { res.writeHead(400,{'Content-Type':'application/json'}).end('{"ok":false}'); return; }
      json(result.admin ? administration() : result.data ? await libraryData(demo,mode,viewer) : result);
      return;
    }
    if (path === '/admin' || path === '/api/admin') {
      if (mode !== 'owner') { res.writeHead(404).end(); return; }
      const data = administration();
      if (path === '/admin') respondHtml(admin,'ADMIN',JSON.stringify(data),'鲸栖歌曲后台',res,respond);
      else json(data);
      return;
    }
    if (path === '/') {
      const data = await libraryData(demo,mode,viewer);
      if (demo && data.projects.length) res.writeHead(302,{Location:'/song/' + demo}).end();
      else renderPage(data, demo ? '#/mine' : mode==='guest' ? '#/discover' : '#/', res, respond);
      return;
    }
    const asset = path === melodyPath && mode !== 'owner' ? null : assets.get(path);
    if (asset) {
      respond('text/javascript; charset=utf-8',asset);
      return;
    }
    if (path === '/api/data') {
      const data = await libraryData(demo,mode,viewer);
      json(query.get('v') === data.v ? {unchanged:true} : data);
      return;
    }
    if (path === '/api/busy' && mode === 'owner') {
      json({busy:(await libraryData(demo,mode,viewer)).busy}); return;
    }
    const coverId = path.startsWith('/cover/') && path.slice(7);
    if (mode !== 'demo' && songIdPattern.test(coverId || '')) {
      const data = await libraryData(demo,mode,viewer);
      const key = query.get('v');
      const visible = /^[a-f0-9]{64}$/.test(key??'') && [...data.projects,...data.shared].some(row=>row.cover===path+'?v='+key);
      const cover = visible && studio.coverRecord(coverId,key);
      if (cover) { respond(cover.mime,Buffer.from(cover.base64,'base64')); return; }
    }
    const match = path.startsWith('/song/') && songPath.exec(path.slice(5));
    if (demo && match?.[1] !== demo) { res.writeHead(404).end(); return; }
    const record = match && client.inspect(match[1]);
    const state = demo ? null : studio.read();
    if (mode==='owner' && record && !match[2] && !state?.archived[record.requestId] && busySong(record)) {
      renderPage(await libraryData(demo,mode,viewer),'#/p/'+songProject(record)+'/v'+songVersion(record),res,respond); return;
    }
    if (!savedSong(record,dataDir) || demo && !record.selftest || state?.archived[record.requestId] ||
        mode === 'guest' && !state.shares[record.requestId]) {
      res.writeHead(404).end(); return;
    }
    if (match[2] === 'lyrics') {
      if (mode !== 'owner' || typeof record.parameters?.lyrics !== 'string') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Disposition','attachment; filename="lyrics.txt"');
      respond('text/plain; charset=utf-8',record.parameters.lyrics); return;
    }
    if (match[2] === 'score') {
      if (mode === 'guest') { res.writeHead(404).end(); return; }
      if (mode === 'owner' && query.get('download') === '1') res.setHeader('Content-Disposition','attachment; filename="score.abc"');
      if (req.method === 'HEAD') { respond('text/plain; charset=utf-8',''); return; }
      const score = await client.score(record.requestId);
      if (score === null) { res.writeHead(404).end(); return; }
      respond('text/plain; charset=utf-8',score); return;
    }
    if (match[2] !== 'stream') {
      const data = await libraryData(demo,mode,viewer);
      const route = mode==='guest' ? '#/s/'+shareId(record.requestId) :
        '#/p/'+(demo?record.requestId:songProject(record))+'/v'+(demo?1:songVersion(record));
      renderPage(data,route,res,respond); return;
    }
    const artifact = record.artifact;
    const handle = await open(artifact.path,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== artifact.size) { res.writeHead(404).end(); return; }
      res.setHeader('Accept-Ranges','bytes');
      res.setHeader('Content-Type',artifact.mime);
      if (mode==='owner' && query.get('download') === '1') {
        res.setHeader('Content-Disposition','attachment; filename="song.'+formats[artifact.mime]+'"');
      }
      const range = req.headers.range ? byteRange(req.headers.range,info.size) : null;
      if (req.headers.range && !range) { res.writeHead(416,{'Content-Range':`bytes */${info.size}`}).end(); return; }
      if (range) res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${info.size}`);
      res.setHeader('Content-Length',range ? range.end - range.start + 1 : info.size);
      res.writeHead(range ? 206 : 200);
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(createReadStream(null,{fd:handle.fd,autoClose:false,...range}),res);
    } finally { await handle.close(); }
  }
  await new Promise((ok,no) => {server.once('error',no);server.listen(port,'127.0.0.1',ok);});
  return {port:server.address().port, async close(){
    await new Promise(ok => {server.close(ok);server.closeAllConnections();});
    await alignment.close();
  }};
}
