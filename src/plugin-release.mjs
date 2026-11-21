import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {wantsUnstable} from '../vendor/aurabot/src/core/update.js';

export const pluginId = 'whalenest.runtime.deepseek-harness';
export const updateTarget = 'linux-x64';
export const updateCompatibility = {
  dsh: '0.2.2-rc.1',
  core: '0.1.0-beta.9-whalenest.media.3-replay.2-renewal.1-liveware.1-voice.2-stickers.1',
  dataSchema: 1,
};
export const updateInterval = 6 * 3600_000;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*))?$/;
const digestPattern = /^sha256:([a-f0-9]{64})$/;
const metadataName = 'distribution.json';

function versionParts(version) {
  const parsed = typeof version === 'string' && version.length <= 100 && versionPattern.exec(version);
  assert.ok(parsed, 'Invalid Whale Nest release version');
  return {base: parsed.slice(1,4).map(BigInt), pre: parsed[4]?.split('.')};
}

export function comparePluginVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let index=0; index<3; index++) {
    if (x.base[index] !== y.base[index]) return x.base[index]<y.base[index]?-1:1;
  }
  if (!x.pre || !y.pre) return Number(!x.pre)-Number(!y.pre);
  for (let index=0; index<Math.max(x.pre.length,y.pre.length); index++) {
    const left=x.pre[index],right=y.pre[index];
    if (left===right) continue;
    if (left===undefined || right===undefined) return left===undefined?-1:1;
    // Current tags use a dev.N tail. Numeric identifiers must sort numerically.
    const number = value=>/^\d+$/.test(value);
    if (number(left) && number(right)) {
      const first=BigInt(left),second=BigInt(right);
      if (first!==second) return first<second?-1:1;
      continue;
    }
    if (number(left)!==number(right)) return number(left)?-1:1;
    if (left!==right) return left<right?-1:1;
  }
  return 0;
}

export function releaseRepository(value) {
  assert.match(value ?? '', /^(?![.-])[A-Za-z0-9-]{1,39}\/(?![.-])[A-Za-z0-9_.-]{1,100}$/);
  return value;
}

async function boundedJson(url, fetchImpl, redirects = false) {
  const signal = AbortSignal.timeout(9000);
  let response;
  for (let count=0; count<3; count++) {
    response=await fetchImpl(url,{signal,redirect:'manual',headers:{Accept:'application/vnd.github+json'}});
    if (![301,302,303,307,308].includes(response.status)) break;
    assert.ok(redirects,'Unexpected release metadata redirect');
    const next = new URL(response.headers.get('location') ?? '', url);
    assert.ok(next.protocol==='https:' && ['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname)
      && !next.username && !next.password && !next.port);
    url = next;
  }
  assert.ok(response?.ok && response.body,'Release metadata unavailable');
  const bytes=[];
  let size=0;
  for await (const piece of response.body) {
    size+=piece.byteLength;
    assert.ok(size<=512*1024,'Release metadata too large');
    bytes.push(Buffer.from(piece));
  }
  const body=Buffer.concat(bytes);
  return {json:JSON.parse(body.toString('utf8')),digest:createHash('sha256').update(body).digest('hex')};
}

function asset(release, repository, name) {
  const matches=(release.assets??[]).filter(row=>row?.name===name);
  assert.equal(matches.length,1,'Missing or ambiguous Whale Nest release asset');
  const file=matches[0];
  const expected='https://github.com/'+repository+'/releases/download/'+encodeURIComponent(release.tag_name)+'/'+name;
  assert.equal(file.browser_download_url,expected,'Unexpected release asset origin');
  assert.match(file.digest ?? '',digestPattern);
  return file;
}

async function describe(release, repository, fetchImpl) {
  const tag = release.tag_name, version=tag.replace(/^v/,'');
  const parts=versionParts(version);
  assert.ok(release.draft===false && release.immutable===true,'A confirmed release requires immutable tag and assets');
  assert.equal(Boolean(parts.pre),release.prerelease,'Release channel disagrees with the tag');
  assert.equal((release.assets??[]).filter(file=>file?.name?.endsWith('.connect-plugin')).length,1,
    'This Linux release must identify exactly one plugin bundle');
  const bundle=asset(release,repository,'whalenest-companion-'+version+'-'+updateTarget+'.connect-plugin');
  const manifest=asset(release,repository,metadataName);
  const {json:metadata,digest}=await boundedJson(new URL(manifest.browser_download_url),fetchImpl,true);
  assert.equal('sha256:'+digest,manifest.digest,'Distribution metadata checksum mismatch');
  assert.equal(metadata.schema,1);
  assert.equal(metadata.version,version);
  assert.equal(metadata.pluginId,pluginId);
  assert.equal(metadata.target,updateTarget);
  assert.equal('sha256:'+metadata.sha256,bundle.digest,'Bundle checksum disagrees with release metadata');
  const compatibility=metadata.compatibility;
  assert.ok(typeof compatibility?.dsh==='string' && typeof compatibility?.core==='string' && Number.isSafeInteger(compatibility?.dataSchema));
  const notes=typeof metadata.notes==='string'?metadata.notes.trim().slice(0,600):'';
  return {repository,tag,version,sha256:metadata.sha256,compatibility,notes};
}

export async function discoverPluginRelease(config, current, {fetchImpl=fetch, tag} = {}) {
  const repository=releaseRepository(config.repository);
  const prefix='https://api.github.com/repos/'+repository+'/releases';
  if (tag) {
    versionParts(tag.replace(/^v/,''));
    const {json}=await boundedJson(new URL(prefix+'/tags/'+encodeURIComponent(tag)),fetchImpl);
    assert.equal(json.tag_name,tag);
    return await describe(json,repository,fetchImpl);
  }
  const {json:releases}=await boundedJson(new URL(prefix+'?per_page=30'),fetchImpl);
  assert.ok(Array.isArray(releases));
  const unstable=wantsUnstable(config.channel==='beta'?true:config.channel==='stable'?false:null,current);
  const options=releases.filter(release=>release?.draft===false && release.immutable===true
    && (unstable||release.prerelease===false) && typeof release.tag_name==='string'
    && versionPattern.test(release.tag_name.replace(/^v/,'')) && comparePluginVersions(release.tag_name.replace(/^v/,''),current)>0)
    .sort((a,b)=>comparePluginVersions(b.tag_name.replace(/^v/,''),a.tag_name.replace(/^v/,'')));
  return options.length ? await describe(options[0],repository,fetchImpl) : null;
}
