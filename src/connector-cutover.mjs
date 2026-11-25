import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const read=file=>JSON.parse(readFileSync(file,'utf8'));
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const busy=job=>['accepted','running'].includes(job?.status);
const jobFingerprint=job=>createHash('sha256').update(JSON.stringify(job??null)).digest('hex');

/** The public image updater owns release verification and selection. This
 * coordinator only permits its selection command while the service is stopped;
 * it never restores a database or rewrites the official state file. */
export function createConnectorCutover({home,cwd,executable='/usr/local/bin/clawchat-dsh',run=execFileSync}) {
  assert.ok(isAbsolute(home)&&isAbsolute(cwd)&&isAbsolute(executable),'Absolute connector cutover paths required');
  const root=join(home,'.clawnest-integrations/deepseek-harness');
  function command(args,timeout=15000) {
    return JSON.parse(run(executable,['plugin',...args],{cwd,encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']}));
  }
  function offline(status) {
    assert.ok(!status.running,'Stop the official integration before selecting its paired custom build');
    assert.ok(!busy(status.job),'Another official connector operation is active');
  }
  return {
    inspect(baseDirectory) {
      const directory=realpathSync(resolve(baseDirectory));
      assert.equal(dirname(directory),realpathSync(join(root,'releases')),'Candidate must be staged by the official updater');
      const stateFile=join(root,'state.json'),state=read(stateFile),targetId=directory.split('/').at(-1);
      const target=state.installed?.[targetId],previous=state.installed?.[state.selected];
      assert.ok(target&&previous,'Official current and candidate releases must be installed');
      assert.ok(!busy(state.job),'Another official connector operation is active');
      const manifestFile=join(directory,'integration.json'),receiptFile=join(directory,'receipt.json'),sourceFile=join(directory,'source.json');
      const manifest=read(manifestFile),receipt=read(receiptFile);
      assert.equal(targetId,target.version+'-'+target.sha256,'Candidate official identity changed');
      assert.equal(receipt.sha256,target.sha256,'Candidate official receipt changed');
      assert.equal(receipt.manifest_sha256,sha(manifestFile),'Candidate official manifest changed');
      assert.equal(manifest.version,target.version);
      assert.equal(manifest.runtime,'deepseek-harness');assert.equal(manifest.plugin,'clawchat-connect');
      assert.equal(manifest.state_schema,target.state_schema);
      assert.equal(previous.state_schema,target.state_schema,'No compatible combined rollback is available');
      if(state.selected!==targetId)assert.equal(previous.rollback_compatible,true,'Previous official release cannot restore this state');
      return {baseDirectory:directory,fromId:state.selected,fromVersion:previous.version,targetId,targetVersion:target.version,
        previousJobId:state.job?.id??null,previousJobFingerprint:jobFingerprint(state.job),
        inputs:Object.fromEntries([stateFile,manifestFile,receiptFile,sourceFile].map(file=>[file,sha(file)]))};
    },
    select(plan) {
      const before=command(['status']);offline(before);
      assert.equal(before.selected?.id,plan.fromId,'Official selection changed before cutover');
      assert.equal(jobFingerprint(before.job),plan.previousJobFingerprint,'Official job changed before cutover');
      if(plan.fromId===plan.targetId)return {changed:false,targetId:plan.targetId};
      let failure;
      // Assets are already staged. The public command performs a fresh signed
      // catalog check; if that online check fails the original selection stays.
      try { command(['upgrade','--version',plan.targetVersion,'--defer'],60000); }
      catch(error) { failure=error; }
      const after=command(['status']);offline(after);
      if(after.selected?.id===plan.fromId)throw failure??Error('Official updater did not select the candidate');
      assert.equal(after.selected?.id,plan.targetId,'Official selection is unknown; do not guess a rollback');
      assert.equal(after.previous?.id,plan.fromId,'Official rollback target changed');
      // The image writes selection before its job receipt. An interrupted CLI
      // in that window is owned only when the exact pre-cutover job remains.
      if(jobFingerprint(after.job)===plan.previousJobFingerprint)
        return {changed:true,targetId:plan.targetId,selectionIncomplete:true,recoveredAcknowledgement:true};
      assert.equal(after.job?.target,plan.targetId,'Official update receipt does not match the candidate');
      assert.notEqual(after.job?.id,plan.previousJobId,'Official update receipt was not created');
      return {changed:true,targetId:plan.targetId,jobId:after.job.id,recoveredAcknowledgement:Boolean(failure)};
    },
    rollback(plan,selection) {
      const before=command(['status']);offline(before);
      if(before.selected?.id===plan.fromId)return {changed:false,selectedId:plan.fromId};
      assert.equal(before.selected?.id,plan.targetId,'A different official release is selected; rollback withheld');
      assert.equal(before.previous?.id,plan.fromId,'Official previous release changed; rollback withheld');
      if(jobFingerprint(before.job)!==plan.previousJobFingerprint) {
        assert.equal(before.job?.target,plan.targetId,'Official selection is not owned by this cutover');
        assert.notEqual(before.job?.id,plan.previousJobId,'Official update receipt is not owned by this cutover');
        if(selection?.jobId)assert.equal(before.job?.id,selection.jobId,'Another official update replaced this cutover');
      }
      let failure;
      try { command(['rollback','--defer'],30000); } catch(error) { failure=error; }
      const after=command(['status']);offline(after);
      assert.equal(after.selected?.id,plan.fromId,failure?.message??'Official rollback did not restore the original release');
      return {changed:true,selectedId:plan.fromId,recoveredAcknowledgement:Boolean(failure)};
    },
    verify(plan,identity) {
      const status=command(['status']),health=status.running?.health;
      assert.equal(status.selected?.id,plan.targetId);assert.equal(status.running?.id,plan.targetId);
      assert.equal(health?.version,plan.targetVersion);assert.equal(health?.identity,identity);
      assert.ok(health.ready&&health.connected&&!health.draining,'The paired official integration is not ready');
      return {selectedId:plan.targetId,version:plan.targetVersion,ready:true,connected:true};
    },
  };
}
