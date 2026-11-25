import assert from 'node:assert/strict';
import {wantsUnstable} from '../vendor/aurabot/src/core/update.js';
import {comparePluginVersions,discoverPluginRelease,releaseRepository,updateProtocol,
  validateUpdatePath,validateUpdatePrerequisites} from './plugin-release.mjs';

const requiredReleaseFields=['repository','tag','version','sha256','compatibility','notes'];
const optionalReleaseFields=['prerequisites','updateProtocol','updatePath'];
const releaseFields=new Set([...requiredReleaseFields,...optionalReleaseFields]);

function record(value,label) {
  assert.ok(value && typeof value==='object' && !Array.isArray(value),label);
}

/** This validates a persisted description. Authentication still comes from
 * immutable-release discovery, which the mutation worker must repeat. */
function validateRelease(release) {
  record(release,'Invalid update plan release');
  assert.ok(Object.keys(release).every(key=>releaseFields.has(key)),'Unsupported update plan release field');
  assert.ok(requiredReleaseFields.every(key=>Object.hasOwn(release,key)),'Incomplete update plan release');
  releaseRepository(release.repository);
  comparePluginVersions(release.version,release.version);
  assert.ok(release.tag==='v'+release.version || release.tag===release.version,'Update plan tag disagrees with its version');
  assert.match(release.sha256??'',/^[a-f0-9]{64}$/,'Invalid update plan checksum');
  record(release.compatibility,'Invalid update plan compatibility');
  assert.ok(Number.isSafeInteger(release.compatibility.dataSchema),'Invalid update plan data schema');
  assert.ok(typeof release.notes==='string' && release.notes.length<=600,'Invalid update plan notes');
  validateUpdatePrerequisites(release.prerequisites);
  if (release.updateProtocol!==undefined) assert.equal(release.updateProtocol,updateProtocol,'Unsupported update protocol');
  validateUpdatePath(release.updatePath,release.version);
  if (release.updatePath) assert.equal(release.updateProtocol,updateProtocol,'Update path requires a supported update protocol');
}

function validateNestedPath(bridge,outer,index,current) {
  for (const inner of bridge.updatePath?.steps??[]) {
    const found=outer.findIndex(step=>step.version===inner.version);
    if (found!==-1) {
      assert.ok(found<index,'Bridge path contains a later outer step');
      assert.equal(inner.sha256,outer[found].sha256,'Bridge path checksum disagrees with the outer path');
    } else {
      assert.ok(current!==undefined && comparePluginVersions(inner.version,current)<=0,
        'Bridge path requires an undeclared intermediate release');
    }
  }
}

/** Validate a complete immutable plan, including the contiguous suffix of the
 * final release's declared path. No network or installation takes place here.
 * The initial current-version boundary is additionally checked by the resolver. */
export function validatePluginUpdatePlan(plan,final) {
  record(plan,'Invalid plugin update plan');
  assert.deepEqual(Object.keys(plan).sort(),['schema','steps'],'Unsupported plugin update plan field');
  assert.equal(plan.schema,1,'Unsupported plugin update plan schema');
  assert.ok(Array.isArray(plan.steps) && plan.steps.length>=1 && plan.steps.length<=9,'Invalid plugin update plan length');
  validateRelease(final);
  for (const step of plan.steps) {
    validateRelease(step);
    assert.equal(step.repository,final.repository,'Update plan crosses release repositories');
    assert.equal(step.compatibility.dataSchema,final.compatibility.dataSchema,'Update plan changes instance data schema');
  }
  assert.deepEqual(plan.steps.at(-1),final,'Update plan final release changed');
  for (let index=1;index<plan.steps.length;index++) {
    assert.ok(comparePluginVersions(plan.steps[index].version,plan.steps[index-1].version)>0,'Update plan is not strictly increasing');
  }
  const bridges=plan.steps.slice(0,-1),outer=final.updatePath?.steps??[];
  if (bridges.length) {
    assert.equal(final.updateProtocol,updateProtocol,'Multi-step update requires a supported final updater');
    const first=outer.findIndex(step=>step.version===bridges[0].version);
    assert.ok(first>=0 && outer.length-first===bridges.length,'Update plan omits a declared intermediate release');
    for (let index=0;index<bridges.length;index++) {
      const bridge=bridges[index],reference=outer[first+index];
      assert.equal(bridge.tag,'v'+bridge.version,'Bridge must use the canonical release tag');
      assert.equal(bridge.version,reference.version,'Update plan changed its declared order');
      assert.equal(bridge.sha256,reference.sha256,'Update plan bridge checksum changed');
      assert.equal(bridge.updateProtocol,updateProtocol,'Bridge does not support update continuation');
      // Without the initial installed version, persisted structure can only
      // bound undeclared historical requirements below the first planned step.
      validateNestedPath(bridge,outer,first+index,bridges[0].version);
    }
  }
  return structuredClone(plan);
}

/** Resolve only the path named by the final authenticated release. Bridges are
 * read by exact tag, so older required releases need not fit a latest-page scan. */
export async function resolvePluginUpdatePlan(config,current,final,{discover=discoverPluginRelease}={}) {
  validateRelease(final);
  assert.equal(final.repository,releaseRepository(config.repository),'Unexpected final release repository');
  assert.ok(comparePluginVersions(final.version,current)>0,'Update target must be newer than the installed plugin');
  const outer=final.updatePath?.steps??[];
  const unstable=wantsUnstable(config.channel==='beta'?true:config.channel==='stable'?false:null,current);
  assert.ok(unstable || !final.version.includes('-'),'Update plan crosses the configured release channel');
  const steps=[];
  for (let index=0;index<outer.length;index++) {
    const reference=outer[index];
    if (comparePluginVersions(reference.version,current)<=0) continue;
    assert.ok(unstable || !reference.version.includes('-'),'Update bridge crosses the configured release channel');
    const bridge=await discover(config,current,{tag:'v'+reference.version});
    validateRelease(bridge);
    assert.equal(bridge.repository,final.repository,'Unexpected bridge release repository');
    assert.equal(bridge.tag,'v'+reference.version,'Unexpected bridge release tag');
    assert.equal(bridge.version,reference.version,'Unexpected bridge release version');
    assert.equal(bridge.sha256,reference.sha256,'Bridge release checksum changed');
    assert.equal(bridge.compatibility.dataSchema,final.compatibility.dataSchema,'Update bridge changes instance data schema');
    assert.equal(bridge.updateProtocol,updateProtocol,'Bridge does not support update continuation');
    validateNestedPath(bridge,outer,index,current);
    steps.push(bridge);
  }
  return validatePluginUpdatePlan({schema:1,steps:[...steps,final]},final);
}
