import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {discoverPluginRelease,pluginId,updateProtocol,updateTarget,validateUpdatePath} from '../src/plugin-release.mjs';
import {resolvePluginUpdatePlan,validatePluginUpdatePlan} from '../src/plugin-update-path.mjs';

const repository='whalenest-fixture/releases';
const current='1.0.0-beta.4',first='1.0.0-beta.5',second='1.0.0-beta.6',target='1.0.0-beta.7';
const digest=value=>createHash('sha256').update(value).digest('hex');
const reference=version=>({version,sha256:digest(version)});
const path=versions=>({schema:1,steps:versions.map(reference)});

function fixtureRelease(version,metadataFields={}) {
  const tag='v'+version,root='https://github.com/'+repository+'/releases/download/'+tag+'/';
  const metadata={schema:1,pluginId,target:updateTarget,version,sha256:digest(version),
    compatibility:{dataSchema:1},notes:'Immutable fixture release',...metadataFields};
  const body=JSON.stringify(metadata);
  return {body,row:{tag_name:tag,immutable:true,draft:false,prerelease:version.includes('-'),assets:[
    {name:'whalenest-companion-'+version+'-'+updateTarget+'.connect-plugin',
      browser_download_url:root+'whalenest-companion-'+version+'-'+updateTarget+'.connect-plugin',digest:'sha256:'+metadata.sha256},
    {name:'distribution.json',browser_download_url:root+'distribution.json',digest:'sha256:'+digest(body)},
  ]}};
}

function fixture(rows,{listed=[target]}={}) {
  const releases=new Map(rows.map(([version,fields])=>[version,fixtureRelease(version,fields)])),requests=[];
  const config={repository,channel:'beta'};
  const fetchImpl=async value=>{
    const url=new URL(value);requests.push(url.href);
    if (url.origin==='https://api.github.com') {
      const prefix='/repos/'+repository+'/releases';
      if (url.pathname===prefix) return Response.json(listed.map(version=>releases.get(version)?.row).filter(Boolean));
      const tagPrefix=prefix+'/tags/';
      assert.ok(url.pathname.startsWith(tagPrefix),'Unexpected API request');
      const tag=decodeURIComponent(url.pathname.slice(tagPrefix.length));
      const release=releases.get(tag.replace(/^v/,''));
      return release?Response.json(release.row):new Response('',{status:404});
    }
    for (const release of releases.values()) {
      if (url.href===release.row.assets[1].browser_download_url) return new Response(release.body);
    }
    throw Error('Unexpected fixture network request: '+url.href);
  };
  const discover=(options,active,extra={})=>discoverPluginRelease(options,active,{...extra,fetchImpl});
  return {config,discover,requests,releases,final:()=>discover(config,current,{tag:'v'+target})};
}

test('authenticated metadata preserves optional updater protocol and strict pinned route',async()=>{
  const f=fixture([[target,{updateProtocol,updatePath:path([first,second])}]]);
  const release=await f.final();
  assert.equal(release.updateProtocol,1);
  assert.deepEqual(release.updatePath,path([first,second]));
  assert.equal(release.repository,repository);
  const legacy=fixture([[target,{}]]);
  const old=await legacy.final();
  assert.equal(Object.hasOwn(old,'updateProtocol'),false);
  assert.equal(Object.hasOwn(old,'updatePath'),false);
  const plan=await resolvePluginUpdatePlan(legacy.config,current,old,{discover:legacy.discover});
  assert.deepEqual(plan,{schema:1,steps:[old]});
});

test('an exact-tag bridge is found even when absent from the latest release page',async()=>{
  const f=fixture([[first,{updateProtocol}],[second,{updateProtocol,updatePath:path([first])}],
    [target,{updateProtocol,updatePath:path([first,second])}]],{listed:[target]});
  const final=await f.discover(f.config,current);
  const plan=await resolvePluginUpdatePlan(f.config,current,final,{discover:f.discover});
  assert.deepEqual(plan.steps.map(step=>step.version),[first,second,target]);
  assert.ok(f.requests.some(url=>url.endsWith('/releases?per_page=30')));
  assert.ok(f.requests.some(url=>url.endsWith('/releases/tags/v'+first)));
  assert.equal(f.requests.filter(url=>url.endsWith('/releases?per_page=30')).length,1);
  assert.deepEqual(validatePluginUpdatePlan(plan,final),plan);
});

test('the installed prefix is skipped without bridge downgrade or another list scan',async()=>{
  const f=fixture([[second,{updateProtocol,updatePath:path([first])}],
    [target,{updateProtocol,updatePath:path([first,second])}]]);
  const final=await f.final();
  const plan=await resolvePluginUpdatePlan(f.config,first,final,{discover:f.discover});
  assert.deepEqual(plan.steps.map(step=>step.version),[second,target]);
  assert.equal(f.requests.some(url=>url.endsWith('/tags/v'+first)),false);
  const completedPrefix=await resolvePluginUpdatePlan(f.config,second,final,{discover:f.discover});
  assert.deepEqual(completedPrefix.steps.map(step=>step.version),[target]);
  await assert.rejects(resolvePluginUpdatePlan(f.config,target,final,{discover:f.discover}),/newer/);
});

test('a bridge may refer to already installed history, not undeclared future work',async()=>{
  const historical='0.9.0';
  const good=fixture([[first,{updateProtocol,updatePath:path([historical])}],
    [target,{updateProtocol,updatePath:path([first])}]]);
  assert.equal((await resolvePluginUpdatePlan(good.config,current,await good.final(),{discover:good.discover})).steps.length,2);
  const missing='1.0.0-beta.4.1';
  const bad=fixture([[first,{updateProtocol,updatePath:path([missing])}],
    [target,{updateProtocol,updatePath:path([first])}]]);
  await assert.rejects(resolvePluginUpdatePlan(bad.config,current,await bad.final(),{discover:bad.discover}),/undeclared intermediate/);
});

test('nested paths must retain outer-prefix hashes and cannot add a cycle',async()=>{
  const changed=path([first]);changed.steps[0].sha256='0'.repeat(64);
  const f=fixture([[first,{updateProtocol}],[second,{updateProtocol,updatePath:changed}],
    [target,{updateProtocol,updatePath:path([first,second])}]]);
  await assert.rejects(resolvePluginUpdatePlan(f.config,current,await f.final(),{discover:f.discover}),/checksum disagrees/);
  const loop=fixture([[first,{updateProtocol,updatePath:path([target])}],
    [target,{updateProtocol,updatePath:path([first])}]]);
  await assert.rejects(resolvePluginUpdatePlan(loop.config,current,await loop.final(),{discover:loop.discover}),/must precede/);
});

test('unsupported protocol and a legacy bridge cannot silently lose continuation',async()=>{
  const unsupported=fixture([[target,{updateProtocol:2}]]);
  await assert.rejects(unsupported.final(),/Unsupported update protocol/);
  const absent=fixture([[target,{updatePath:path([first])}]]);
  await assert.rejects(absent.final(),/requires a supported update protocol/);
  const bridge=fixture([[first,{}],[target,{updateProtocol,updatePath:path([first])}]]);
  await assert.rejects(resolvePluginUpdatePlan(bridge.config,current,await bridge.final(),{discover:bridge.discover}),/does not support update continuation/);
});

test('path data cannot supply URLs, commands, hidden fields or unbounded/nonforward hops',()=>{
  assert.throws(()=>validateUpdatePath({...path([first]),command:'sh'},target),/Unsupported update path field/);
  assert.throws(()=>validateUpdatePath({schema:1,steps:[{...reference(first),url:'https://other.invalid'}]},target),/Unsupported update path step field/);
  assert.throws(()=>validateUpdatePath(path([second,first]),target),/strictly increasing/);
  assert.throws(()=>validateUpdatePath(path([first,first]),target),/strictly increasing/);
  assert.throws(()=>validateUpdatePath(path([target]),target),/must precede/);
  assert.throws(()=>validateUpdatePath({schema:2,steps:[]},target),/schema/);
  assert.throws(()=>validateUpdatePath({schema:1,steps:[{version:first,sha256:'SHA256:'+digest(first)}]},target),/checksum/);
  assert.throws(()=>validateUpdatePath(path(Array.from({length:9},(_,i)=>'0.9.'+i)),target),/too many/);
  assert.throws(()=>validateUpdatePath(path(['https://other.invalid/release']),target),/release version/);
});

test('bridge references are checked against authenticated release and distribution digests',async()=>{
  const badPath=path([first]);badPath.steps[0].sha256='b'.repeat(64);
  const f=fixture([[first,{updateProtocol}],[target,{updateProtocol,updatePath:badPath}]]);
  await assert.rejects(resolvePluginUpdatePlan(f.config,current,await f.final(),{discover:f.discover}),/checksum changed/);
  const changed=fixture([[first,{updateProtocol}],[target,{updateProtocol,updatePath:path([first])}]]);
  const final=await changed.final();
  changed.releases.get(first).body+=' ';
  await assert.rejects(resolvePluginUpdatePlan(changed.config,current,final,{discover:changed.discover}),/metadata checksum mismatch/);
});

test('bridge plugin identity, target and instance schema must stay in the supported lineage',async()=>{
  for (const fields of [{pluginId:'another.plugin'},{target:'darwin-arm64'},{compatibility:{dataSchema:2}}]) {
    const f=fixture([[first,{updateProtocol,...fields}],[target,{updateProtocol,updatePath:path([first])}]]);
    await assert.rejects(resolvePluginUpdatePlan(f.config,current,await f.final(),{discover:f.discover}));
  }
  const f=fixture([[first,{updateProtocol}],[target,{updateProtocol,updatePath:path([first])}]]);
  const final=await f.final(),bridge=await f.discover(f.config,current,{tag:'v'+first});
  await assert.rejects(resolvePluginUpdatePlan(f.config,current,final,{discover:async()=>({...bridge,repository:'other/repository'})}),/repository/);
});

test('persisted plans reject extra execution fields, missing hops and modified final metadata',async()=>{
  const f=fixture([[first,{updateProtocol}],[second,{updateProtocol}],
    [target,{updateProtocol,updatePath:path([first,second])}]]);
  const final=await f.final(),plan=await resolvePluginUpdatePlan(f.config,current,final,{discover:f.discover});
  assert.throws(()=>validatePluginUpdatePlan({...plan,command:'sh'},final),/Unsupported plugin update plan field/);
  assert.throws(()=>validatePluginUpdatePlan({schema:1,steps:[]},final),/length/);
  const added=structuredClone(plan);added.steps[0].url='https://other.invalid';
  assert.throws(()=>validatePluginUpdatePlan(added,final),/Unsupported update plan release field/);
  const missing=structuredClone(plan);missing.steps.splice(1,1);
  assert.throws(()=>validatePluginUpdatePlan(missing,final),/omits a declared intermediate/);
  const modified=structuredClone(plan);modified.steps.at(-1).notes='Changed final offer';
  assert.throws(()=>validatePluginUpdatePlan(modified,final),/final release changed/);
  const reversed=structuredClone(plan);reversed.steps.reverse();
  assert.throws(()=>validatePluginUpdatePlan(reversed,final));
});

test('an explicit stable channel never installs a prerelease bridge',async()=>{
  const base='1.0.0',bridge='1.0.1-beta.1',end='1.0.2';
  const f=fixture([[bridge,{updateProtocol}],[end,{updateProtocol,updatePath:path([bridge])}]]);
  const config={repository,channel:'stable'},final=await f.discover(config,base,{tag:'v'+end});
  await assert.rejects(resolvePluginUpdatePlan(config,base,final,{discover:f.discover}),/release channel/);
});
