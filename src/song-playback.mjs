import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {constants,createReadStream} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createSongClient} from './song-client.mjs';
import {resolveDeliveryTarget} from './routing.mjs';
import {readState} from './state.mjs';

const workId = /^whalenest-song-[a-f0-9]{64}$/;
const songPath = /^\/(whalenest-song-[a-f0-9]{64})(?:\/(stream|score))?$/;
const formats = {'audio/wav':'wav','audio/mpeg':'mp3','audio/flac':'flac'};
const songsmith = new URL('../vendor/platform-liveware/songsmith/',import.meta.url);
const scoreScript = new URL('../vendor/abcjs/abcjs-basic-min.js',import.meta.url);
const rangeLimit = 512 * 1024;

function lyricsData(lyrics) {
  if (typeof lyrics !== 'string' || !lyrics.trim()) return undefined;
  const sections = [{tag:'',lines:[]}];
  for (const line of lyrics.trim().split(/\r?\n/)) {
    const tag = /^\[([^\[\]]+)\]$/.exec(line.trim())?.[1];
    if (tag) sections.push({tag,lines:[]});
    else sections.at(-1).lines.push(line);
  }
  return {snapshot:true,sections:sections.filter(section=>section.lines.some(line=>line.trim()))};
}

function songsmithData(songs) {
  const data = {title:'鲸栖歌曲',projects:songs.map(song=>{
    const id = song.requestId;
    const title = song.parameters?.title || '未命名歌曲';
    const ms = song.durationMs;
    const seconds = Math.floor(ms / 1000);
    return {slug:id,title,brief:song.parameters?.style, takes:[{id,note:title,v:1,ms,
      dur:Number.isFinite(seconds) ? Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0') : undefined,
      bytes:song.artifact.size, audio:'/song/'+id+'/stream', score:'/song/'+id+'/score',
      lyrics:lyricsData(song.parameters?.lyrics)}]};
  })};
  return {...data,v:createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,16)};
}

function savedSong(song, dataDir) {
  const artifact = song?.artifact;
  const extension = artifact && formats[artifact.mime];
  return song?.state === 'saved' && workId.test(song.requestId) && extension
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
    if (entry.publicDemoWorkId !== undefined && !workId.test(entry.publicDemoWorkId)) return null;
    return {url, demo:entry.publicDemoWorkId};
  } catch { return null; }
}

export function songPlaybackUrl(options, record) {
  if (!options.singing?.playback?.enabled || record?.state !== 'saved' || !workId.test(record.requestId)) return null;
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

export async function startSongPlayback(options, {client = createSongClient(options)} = {}) {
  const owner = options.clawchat?.route;
  assert.ok(client.enabled && owner && resolveDeliveryTarget(options,{origin:owner}).ok,'Song Liveware needs a verified ClawChat owner');
  const port = options.singing.playback.port ?? 8898;
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535,'Invalid song Liveware port');
  const [template,translations,abc] = await Promise.all([
    readFile(new URL('app.html',songsmith),'utf8'),readFile(new URL('static/i18n.js',songsmith)),readFile(scoreScript),
  ]);
  const hash = bytes=>createHash('sha256').update(bytes).digest('hex').slice(0,12);
  const translationPath = '/static/songsmith-i18n-'+hash(translations)+'.js';
  const abcPath = '/static/abcjs-'+hash(abc)+'.js';

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
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405,{Allow:'GET, HEAD'}).end(); return; }
    if (req.url === '/healthz') { res.writeHead(200,{'Content-Type':'text/plain'}).end('ok'); return; }
    const path = (req.url ?? '').split('?')[0];
    const demo = publication(options)?.demo;
    // A public test app serves only its explicitly selected test work, even
    // when the request carries an owner header.
    if (!demo && req.headers['x-clawchat-user-id'] !== owner.sender) { res.writeHead(404).end(); return; }
    const respond = (type, body) => {
      res.writeHead(200,{'Content-Type':type});
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (path === '/') {
      const latest = demo ? client.inspect(demo) : client.list().find(song => savedSong(song,options.dataDir));
      if (savedSong(latest,options.dataDir) && (!demo || latest.selftest)) res.writeHead(302,{Location:'/song/' + latest.requestId}).end();
      else respond('text/plain; charset=utf-8','这里还没有歌曲。');
      return;
    }
    if (path === translationPath || path === abcPath) {
      respond('text/javascript; charset=utf-8',path === translationPath ? translations : abc);
      return;
    }
    if (path === '/api/data') {
      const songs = demo ? [client.inspect(demo)].filter(song=>song?.selftest) : client.list();
      const data = songsmithData(songs.filter(song=>savedSong(song,options.dataDir)));
      const version = new URL(req.url,'http://localhost').searchParams.get('v');
      respond('application/json; charset=utf-8',JSON.stringify(version === data.v ? {unchanged:true} : data));
      return;
    }
    const match = path.startsWith('/song/') && songPath.exec(path.slice(5));
    if (demo && match?.[1] !== demo) { res.writeHead(404).end(); return; }
    const record = match && client.inspect(match[1]);
    if (!savedSong(record,options.dataDir) || demo && !record.selftest) {
      res.writeHead(404).end(); return;
    }
    if (match[2] === 'score') {
      if (req.method === 'HEAD') { respond('text/plain; charset=utf-8',''); return; }
      const score = await client.score(record.requestId);
      if (score === null) { res.writeHead(404).end(); return; }
      respond('text/plain; charset=utf-8',score); return;
    }
    if (match[2] !== 'stream') {
      const songs = demo ? [record] : client.list().filter(song => savedSong(song,options.dataDir));
      const data = {...songsmithData(songs),route:'#/p/'+record.requestId+'/v1'};
      const nonce = randomBytes(18).toString('base64');
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'nonce-"+nonce+"'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      const fields = {DATA:JSON.stringify(data).replaceAll('<','\\u003c'),TITLE:data.title,HTMLLANG:'zh',
        I18N:'<script src="'+translationPath+'"></script>',V:'1.0.6'};
      const html = template.replace('<script>','<script nonce="'+nonce+'">')
        .replace('/static/abcjs-basic-min.js?v=__V__',abcPath)
        .replace(/__(DATA|TITLE|HTMLLANG|I18N|V)__/g,(_,key)=>fields[key]);
      respond('text/html; charset=utf-8',html); return;
    }
    const artifact = record.artifact;
    const handle = await open(artifact.path,constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== artifact.size) { res.writeHead(404).end(); return; }
      res.setHeader('Accept-Ranges','bytes');
      res.setHeader('Content-Type',artifact.mime);
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
  return {port:server.address().port, close:() => new Promise(ok => {server.close(ok);server.closeAllConnections();})};
}
