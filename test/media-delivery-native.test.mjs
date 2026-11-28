import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';

test('Native DSH exposes owner media tools and completes audio/file/video delivery through the existing CLI bridge', {timeout:90000},async t=>{
 const dir=await bridgeDirectory();dir.options.clawchat.delivery.mediaEnabled=true;
 await writeFile(dir.configPath,JSON.stringify(dir.options));
 for(const name of ['audio.wav','document.txt','video.mp4'])await copyFile(resolve('test/fixtures/media',name),join(dir.root,name));
 const bridge=await bootBridge(dir);t.after(()=>bridge.close());
 const sessionId='media-native';await bridge.request('create',{sessionId,cwd:dir.root,whalenestChatId:'dm-alice',model:dir.options.model});
 for(const [i,name]of['audio.wav','document.txt','video.mp4'].entries())await bridge.turn(sessionId,'media-input-'+i,'SEND_MEDIA_FIXTURE '+join(dir.root,name));
 const lines=(await readFile(join(dir.root,'delivered.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,3);assert.equal(new Set(lines.map(r=>r.id)).size,3,'Native call IDs in different persisted steps cannot collide');
 assert.deepEqual(lines.map(r=>r.tool),['clawchat_send_voice','clawchat_send_file','clawchat_send_file']);
 assert.ok(lines.every(r=>r.input.chat_id==='dm-alice'&&r.input.chat_type==='direct'&&Buffer.from(r.artifact,'base64').length>0));
 await bridge.request('prompt',{sessionId,inputId:'media-input-0',text:'SEND_MEDIA_FIXTURE '+join(dir.root,'audio.wav')});
 assert.equal((await readFile(join(dir.root,'delivered.jsonl'),'utf8')).trim().split('\n').length,3);
});
