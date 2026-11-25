import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readClawChatToolStatus,readClawChatPlatformState,readBoundClawChatAgentId} from '../src/clawchat-state.mjs';
import {createClawChatCore} from '../src/clawchat-core.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'whalenest-core-receipts-'));
  const configPath=join(root,'connect.json'),dbPath=join(root,'connect.sqlite');
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE tool_requests(binding_id TEXT, tool_name TEXT, request_id TEXT PRIMARY KEY,
    state TEXT, result_json TEXT, error TEXT);`);
  writeFileSync(configPath,JSON.stringify({defaultAgent:'other',agents:{dsh:{},other:{}},stateDbPath:dbPath}));
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const insert=(id,state,{binding='dsh',tool='clawchat_send_media',result=null,error=null}={}) =>
    db.prepare('INSERT INTO tool_requests VALUES(?,?,?,?,?,?)').run(binding,tool,id,state,result===null?null:JSON.stringify(result),error);
  return {root,configPath,dbPath,db,insert,read:(name,id)=>readClawChatToolStatus(configPath,'dsh',name,id)};
}

test('Core receipt queries match the binding, tool and exact request without submitting or mutating state',t=>{
  const f=fixture(t);
  f.insert('confirmed','succeeded',{result:{sent:true,messageId:'ack-existing'}});
  f.insert('another-binding','succeeded',{binding:'other',result:{messageId:'private'}});
  f.insert('another-tool','succeeded',{tool:'clawchat_create_moment',result:{moment:{id:123}}});
  const before=readFileSync(f.dbPath);
  assert.deepEqual(f.read('clawchat_send_media','confirmed'),{requestId:'confirmed',status:'succeeded',result:{sent:true,messageId:'ack-existing'}});
  for(const id of ['missing','another-binding','another-tool'])
    assert.deepEqual(f.read('clawchat_send_media',id),{requestId:id,status:'not_found'});
  assert.deepEqual(readFileSync(f.dbPath),before);
  assert.equal(f.db.prepare('SELECT count(*) AS total FROM tool_requests').get().total,3);
});

test('Core receipt queries preserve each stored outcome and its error without expiring pending requests',t=>{
  const f=fixture(t);
  for(const state of ['pending','running','succeeded','failed','expired','indeterminate']) {
    const error=state==='failed'?'Platform rejected this attachment':null;
    f.insert(state,state,{error});
    assert.deepEqual(f.read('clawchat_send_media',state),{requestId:state,status:state,...(error?{error}:{})});
  }
  assert.equal(f.db.prepare("SELECT state FROM tool_requests WHERE request_id='pending'").get().state,'pending');
});

test('Core facade uses its exact configured binding, and malformed receipts fail without creating a missing database',t=>{
  const f=fixture(t);
  f.insert('configured-binding','succeeded',{result:{messageId:'dsh-ack'}});
  const core=createClawChatCore({dataDir:f.root,clawchat:{route:{account:'dsh'},delivery:{connectBin:'/fixture/core',configPath:f.configPath}}});
  assert.equal(core.toolStatus('clawchat_send_media','configured-binding').result.messageId,'dsh-ack');
  assert.throws(()=>readClawChatToolStatus(f.configPath,'unconfigured','clawchat_send_media','configured-binding'),/binding/);
  assert.throws(()=>f.read('','configured-binding'),/tool name/);
  f.db.prepare('UPDATE tool_requests SET result_json = ? WHERE request_id = ?').run('malformed','configured-binding');
  assert.throws(()=>f.read('clawchat_send_media','configured-binding'),SyntaxError);
  const missing=join(f.root,'absent.sqlite');
  writeFileSync(f.configPath,JSON.stringify({agents:{dsh:{}},stateDbPath:missing}));
  assert.throws(()=>f.read('clawchat_send_media','configured-binding'));
  assert.equal(existsSync(missing),false);
});

test('read-only Core receipt queries observe a late acknowledgement committed to the running Core WAL',t=>{
  const f=fixture(t);
  f.db.exec('PRAGMA journal_mode = WAL');
  f.insert('late-ack','running');
  assert.equal(f.read('clawchat_send_media','late-ack').status,'running');
  f.db.prepare('UPDATE tool_requests SET state = ?, result_json = ? WHERE request_id = ?')
    .run('succeeded',JSON.stringify({sent:true,messageId:'late-wal-ack'}),'late-ack');
  assert.equal(f.read('clawchat_send_media','late-ack').result.messageId,'late-wal-ack');
});

test('public platform identity uses the configured official command without requiring activation tables',async t=>{
  const f=fixture(t),connectBin=join(f.root,'official-state');
  const status={userId:'public-agent',ownerId:'public-owner',conversationId:'public-dm',connected:true,available:true};
  const config={agents:{dsh:{}},stateDbPath:f.dbPath,fixtureStatus:status};
  writeFileSync(f.configPath,JSON.stringify(config));
  writeFileSync(connectBin,'#!'+process.execPath+'\n'+[
    "const fs=require('node:fs');",
    "if(process.argv[2]!=='__clawnest-state'||process.argv.includes('--prepare-workspace'))process.exit(2);",
    "const config=JSON.parse(fs.readFileSync(process.env.CLAWCHAT_CONNECT_CONFIG,'utf8'));",
    'console.log(JSON.stringify(config.fixtureStatus));',
  ].join('\n'),{mode:0o700});
  const delivery={connectBin,configPath:f.configPath};
  assert.deepEqual(await readClawChatPlatformState(delivery),status);
  const clawchat={delivery,route:{account:'dsh',sender:'public-owner',conversation:'public-dm'}};
  assert.equal(await readBoundClawChatAgentId(clawchat),'public-agent');
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name),['tool_requests']);
  config.fixtureStatus={...status,userId:'next-agent',ownerId:'next-owner'};
  writeFileSync(f.configPath,JSON.stringify(config));
  assert.equal(await readBoundClawChatAgentId(clawchat),null);
  assert.equal(await readBoundClawChatAgentId({...clawchat,route:{...clawchat.route,sender:'next-owner'}}),'next-agent');
});

test('public identity rejects mismatched routes or an unavailable official query without private DB fallback',async t=>{
  const f=fixture(t);
  f.db.exec(`CREATE TABLE activations(platform, local_agent_id, access_token, user_id, owner_user_id, conversation_id, activated_at);
    CREATE TABLE installation_owner(id, owner_user_id);
    INSERT INTO installation_owner VALUES(1,'owner');
    INSERT INTO activations VALUES('clawchat-connect','dsh','fixture','private-agent','owner','dm',100);`);
  const clawchat={delivery:{connectBin:'/fixture/core',configPath:f.configPath},route:{account:'dsh',sender:'owner',conversation:'dm'}};
  const status={userId:'public-agent',ownerId:'owner',conversationId:'dm'};
  const readPlatformState=()=>status;
  assert.equal(await readBoundClawChatAgentId(clawchat,{readPlatformState}),'public-agent');
  for(const mismatch of [{ownerId:'another-owner'},{conversationId:'another-dm'},{userId:null},{userId:123}])
    assert.equal(await readBoundClawChatAgentId(clawchat,{readPlatformState:()=>({...status,...mismatch})}),null);
  assert.equal(await readBoundClawChatAgentId(clawchat,{readPlatformState:()=>{throw Error('official status unavailable');}}),null);
});

test('a route or executable configuration change during the public identity query discards its stale result',async t=>{
  const f=fixture(t),status={userId:'agent',ownerId:'owner',conversationId:'dm'};
  for(const change of [value=>{value.route.account='other';},value=>{value.delivery.configPath=join(f.root,'other.json');},
      value=>{value.route={...value.route,sender:'next-owner'};}]) {
    const clawchat={delivery:{connectBin:'/fixture/core',configPath:f.configPath},route:{account:'dsh',sender:'owner',conversation:'dm'}};
    let finish;
    const state=new Promise(resolve=>{finish=resolve;});
    const pending=readBoundClawChatAgentId(clawchat,{readPlatformState:()=>state});
    change(clawchat);finish(status);
    assert.equal(await pending,null);
  }
});

test('both public state adapters explicitly scope the official platform entry through its config environment',async t=>{
  const f=fixture(t),delivery={connectBin:'/fixture/core',configPath:f.configPath};
  const status={userId:'agent',ownerId:'owner',conversationId:'dm'};
  const inspect=(bin,args,options)=>{
    assert.equal(bin,delivery.connectBin);assert.equal(args[0],'__clawnest-state');
    assert.equal(options.env.CLAWCHAT_CONNECT_CONFIG,f.configPath);
    assert.equal(args.includes('--prepare-workspace'),false);
    return JSON.stringify(status);
  };
  const run=async(...args)=>({stdout:inspect(...args)});
  assert.deepEqual(await readClawChatPlatformState(delivery,{run}),status);
  const core=createClawChatCore({clawchat:{delivery,route:{account:'dsh'}}},{
    run,
  });
  assert.deepEqual(await core.state(),status);
});
