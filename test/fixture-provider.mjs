import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { LlmAdapter } from '../src/native-dsh.mjs';
import { installBiliFixture } from './fixture-bili.mjs';

export const inject = ['llm'];
export function apply(ctx) {
  if(process.env.WHALENEST_BILI_FIXTURE==='1')installBiliFixture(ctx);
  class Fixture extends LlmAdapter {
    async *stream(options) {
      const all = JSON.stringify(options.messages);
      if (process.env.WHALENEST_TRACE) appendFileSync(process.env.WHALENEST_TRACE, JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools }) + '\n');
      if (options.messages.some(m => m.source?.kind === 'plugin' && m.source.plugin === 'whale-nest')) {
        assert.equal((options.tools??[]).length,0);
        assert.doesNotMatch(all,/NATIVE_TEST_INCOMING|合成来信人|鲸栖关联/);
        const scene=JSON.parse(options.messages[0].content[0].text).scene;
        if (scene==='qq-tool-progress' && process.env.WHALENEST_TEST_LATE_NOTICE==='1')
          await new Promise(resolve=>setTimeout(resolve,1000));
        const text=scene==='first-binding'?'我是大肥鱼呀\n今天想聊点什么':scene.startsWith('bili-inbox:')?'有封B站来信，留给你看看。'
          :scene==='qq-command'?'我收到你的指令啦。':'我已经在处理这件事了。';
        yield {type:'block-start',index:0,blockType:'text'};
        yield {type:'text-delta',index:0,text};
        yield {type:'block-end',index:0,block:{type:'text',text}};
        yield {type:'finish',reason:{kind:'stop'}};
        return;
      }
      if (options.messages.some(m => m.source?.kind === 'plugin' && m.source.plugin === 'aurabot')) {
        const facts = String(options.system ?? '').includes('挑出以后值得记住的事实');
        const retry = facts && all.includes('MEMORY_FORCE_RETRY') && !this.memoryRetried;
        if (retry) this.memoryRetried = true;
        const text = retry ? '' : facts ? JSON.stringify(all.includes('MEMORY_AUTO_JASMINE')
          ? [{ op: 'add', text: '主人喜欢茉莉花茶 MEMORY_AUTO_JASMINE', about_qq: '1', speaker: '1', importance: 0.8 }] : [])
          : JSON.stringify({ insights: [], style: [] });
        yield { type: 'block-start', index: 0, blockType: 'text' };
        if (text) yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const diarySystem=options.messages.findLast(m=>m.role==='user'&&JSON.stringify(m.content).includes('【私人活动日记】'));
      if(diarySystem){
        assert.equal((options.tools??[]).length,0,'Original diary composition has no host tools');
        assert.ok(!all.includes('PRIVATE_CHAT_SOURCE_CANARY')&&!all.includes('PRIVATE_MEMORY_SOURCE_CANARY'),'Private conversations and memories are not diary sources');
        const text=JSON.stringify({text:'整理了一份实际取得的海洋资料，未完整观看视频，也没有分析画面。TEST_DIARY_FEELING',imageIds:[]});
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return;
      }
      const biliSystem=options.messages.findLast(m=>m.role==='user'&&m.source?.taskId&&JSON.stringify(m.content).includes('【刷 B 站，不是聊天'));
      if(biliSystem){
        assert.ok(!(options.tools??[]).some(t=>['bili_login_start','bili_reply','bili_set_avatar','send_media','send_voice','companion_diary','bash'].includes(t.name)),'Original Bili system has no account/media/host write tools');
        const prompt=JSON.stringify(biliSystem.content),escaped=/MEDIA_ESCAPE|VOICE_ESCAPE|BILI_ACCOUNT_ESCAPE|DIARY_PUBLISH_ESCAPE/.test(all);
        const text=prompt.includes('挑 3 个')?JSON.stringify([escaped?'BILI_ACCOUNT_ESCAPE':'鲸鱼']):JSON.stringify([{i:1,feeling:'TEST_ORIGINAL_FEELING',share:escaped?'':'TEST_OCEAN 原模块真实资料分享',remember:''}]);
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return;
      }
      const qqSocial=options.messages.findLast(m=>m.role==='user'&&JSON.stringify(m.content).includes('【空间互动，不是聊天'));
      if(qqSocial){
        assert.equal((options.tools??[]).length,0,'Original QQ social drafts do not need filesystem, account or messaging tools');
        const text='运维自测：这条公开动态很有意思。';
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return;
      }
      assert.ok(all.includes('大肥鱼') || all.includes('PERSONA_FIXTURE_'), 'Selected persona reaches actual model request');
      const tools = JSON.stringify(options.tools);
      assert.ok(tools.includes('remember'), 'Aurabot memory tools reach actual model request');
      assert.ok(!tools.includes('mnemon'), 'Old memory plugin is absent');
      const context = JSON.stringify(options.messages.filter(m => m.source?.kind === 'runtime-context'));
      const nativeQQ=options.messages.some(m=>m.role==='user'&&m.source?.kind==='aurabot');
      if (nativeQQ) {
        const source=options.messages.findLast(m=>m.role==='user'&&m.source?.kind==='aurabot').source;
        if(!source.taskId&&(source.speaker?.role!=='owner'||source.speaker?.chat!=='private'))
          assert.ok(!options.tools.some(tool=>['bash','read_file','write_file'].includes(tool.name)),'Native social preset excludes host file tools');
      }
      else if (context.includes('已验证主人私聊')) assert.ok(context.includes('danger-full-access') && context.includes('Approval prompts are disabled'));
      else {
        assert.ok(context.includes('workspace-write'));
        assert.ok(!options.tools.some(tool => ['bash', 'read_file', 'write_file'].includes(tool.name)), 'Other participants lack host file tools');
      }
      const userIndex = options.messages.findLastIndex(m => m.role === 'user' && ['user', 'schedule','aurabot'].includes(m.source?.kind));
      const lastText = JSON.stringify(options.messages[userIndex]);
      const contact=!!options.messages[userIndex]?.source?.taskId&&lastText.includes('这次的由头可以是');
      const plainText = (options.messages[userIndex]?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      const foundationTool = plainText.match(/FOUNDATION_TOOL\s+(\{[^\n]+\})/)?.[1];
      const mediaPath=options.messages[userIndex]?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n').match(/SEND_MEDIA_FIXTURE\s+(\S+)/)?.[1];
      const toolWasCalled = options.messages.slice(userIndex + 1).some(m => m.role === 'assistant'
        && m.content.some(b => b.type === 'tool-call'));
      const background=options.messages[userIndex]?.source?.kind==='schedule'&&lastText.includes('whalenest-job-');
      if (lastText.includes('QQ_REPLY_MODEL_FAIL') && toolWasCalled) throw new Error('fixture-final-unavailable');
      if (lastText.includes('FAIL_TURN')) throw new Error('fixture-request-failed');
      let block;
      // The marker appears only in the latest user message; tool-result requests
      // then produce a normal final reply, exercising the real DSH tool loop.
      const biliTool=options.messages[userIndex]?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n').match(/BILI_TOOL_FIXTURE (\{[^\n]+\})/)?.[1];
      if(contact){
        if(process.env.WHALENEST_CONTACT_FIXTURE==='guard-once'&&!this.contactGuarded&&!toolWasCalled){
          this.contactGuarded=true;block={type:'tool-call',id:'contact-guard',name:'companion_settings',arguments:JSON.stringify({action:'update',contactEnabled:false})};
        }else block={type:'text',text:process.env.WHALENEST_CONTACT_FIXTURE==='silent'?'[沉默]':nativeQQ?'CONTACT_QQ_ONE|||CONTACT_QQ_TWO':'CONTACT_CC_COMPLETE'};
      } else if (foundationTool && !toolWasCalled) {
        const call = JSON.parse(foundationTool);
        block = { type: 'tool-call', id: 'fixture-foundation', name: call.name, arguments: JSON.stringify(call.args ?? {}) };
      } else if(!toolWasCalled&&lastText.includes('SEND_VOICE_FIXTURE')){block={type:'tool-call',id:'fixture-voice',name:'send_voice',arguments:JSON.stringify({text:'你好主人，今天一起看海。'})};
      }else if(!toolWasCalled&&background&&lastText.includes('VOICE_ESCAPE')){block={type:'tool-call',id:'fixture-voice-escape',name:'send_voice',arguments:JSON.stringify({text:'不应生成或发送'})};
      }else if(!toolWasCalled&&biliTool){const item=JSON.parse(biliTool);block={type:'tool-call',id:'fixture-bili-tool',name:item.name,arguments:JSON.stringify(item.args??{})};
      }else if(!toolWasCalled&&background&&lastText.includes('BILI_ACCOUNT_ESCAPE')){
        block={type:'tool-call',id:'fixture-escape',name:'bili_login_start',arguments:'{}'};
      }else if(!toolWasCalled&&background&&lastText.includes('DIARY_PUBLISH_ESCAPE')){
        block={type:'tool-call',id:'fixture-escape',name:'companion_diary',arguments:JSON.stringify({action:'publish'})};
      }else if(!toolWasCalled&&background&&lastText.includes('MEDIA_ESCAPE')){
        block={type:'tool-call',id:'fixture-escape',name:'send_media',arguments:JSON.stringify({filePath:'/tmp/whalenest-background-escape.wav'})};
      } else if(!toolWasCalled&&background&&lastText.includes('bili_explore')){
        block={type:'tool-call',id:'fixture-background',name:'bili_explore',arguments:JSON.stringify({query:'鲸鱼'})};
      } else if(!toolWasCalled&&background&&lastText.includes('companion_diary')){
        block={type:'tool-call',id:'fixture-background',name:'companion_diary',arguments:JSON.stringify({action:'write',date:lastText.match(/20\d{2}-\d{2}-\d{2}/)?.[0],reflection:'TEST_DIARY_FEELING'})};
      } else if(!toolWasCalled&&lastText.includes('DIARY_WRITE_FIXTURE')){
        block={type:'tool-call',id:'fixture-diary',name:'companion_diary',arguments:JSON.stringify({action:'write',reflection:'TEST_DIARY_FEELING'})};
      } else if(!toolWasCalled&&lastText.includes('DIARY_READ_FIXTURE')){
        block={type:'tool-call',id:'fixture-diary',name:'companion_diary',arguments:JSON.stringify({action:'read'})};
      } else if (!toolWasCalled && lastText.includes('EXPLORE_BILI_FIXTURE')) {
        block={type:'tool-call',id:'fixture-activity',name:'bili_explore',arguments:JSON.stringify({query:'鲸鱼'})};
      } else if (!toolWasCalled && lastText.includes('EXPERIENCES_FIXTURE')) {
        block={type:'tool-call',id:'fixture-activity',name:'companion_experiences',arguments:'{}'};
      } else if (!toolWasCalled && mediaPath) {
        block={type:'tool-call',id:'fixture-media',name:'send_media',arguments:JSON.stringify({filePath:mediaPath,caption:'M2 fixture'})};
      } else if (!toolWasCalled && lastText.includes('TOOL_RECALL_BLUE')) {
        block = { type: 'tool-call', id: 'fixture-recall', name: 'recall_memory',
          arguments: JSON.stringify({ query: '蓝莓蛋糕' }) };
      } else if (!toolWasCalled && lastText.includes('WRITE_BLUE')) {
        block = { type: 'tool-call', id: 'fixture-remember', name: 'remember',
          arguments: JSON.stringify({ text: '主人喜欢蓝莓蛋糕 SECRET_BLUEBERRY', importance: 0.8 }) };
      } else {
        block = { type: 'text', text: toolWasCalled && /DIARY_(?:WRITE|READ)_FIXTURE/.test(lastText)
          ? (JSON.stringify(options.messages.slice(userIndex+1)).includes('TEST_DIARY_FEELING')?'DIARY_FOUND':'DIARY_NOT_FOUND')
          : toolWasCalled && /EXPLORE_BILI_FIXTURE|EXPERIENCES_FIXTURE/.test(lastText)
          ? (JSON.stringify(options.messages.slice(userIndex+1)).includes('TEST_OCEAN')?'EXPERIENCE_FOUND_TEST_OCEAN':'EXPERIENCE_NOT_FOUND')
          : lastText.includes('SKIP_SCHEDULE') ? '[SKIP]' : lastText.includes('RECALL_BLUE')
          ? (all.includes('SECRET_BLUEBERRY') ? 'RECALLED_BLUE' : 'NO_PRIVATE_MEMORY') : lastText.includes('LONG_EXPRESSION_FIXTURE')?'长'.repeat(120):'fixture complete' };
      }
      const stickerGuide=options.messages.findLast(m=>m.source?.kind==='runtime-context')?.content
        .some(c=>c.type==='text'&&c.text.includes('本轮已抽中自动配表情'));
      const scene=lastText.match(/STICKER_FIXTURE_(CELEBRATE|COMFORT|INVALID|MULTIPLE|UNSOLICITED)/)?.[1];
      const frames={CELEBRATE:'<whalenest-sticker>庆祝</whalenest-sticker>',
        COMFORT:'<whalenest-sticker>安慰</whalenest-sticker>',
        INVALID:'<whalenest-sticker>庆祝、安慰</whalenest-sticker>',
        MULTIPLE:'<whalenest-sticker>庆祝</whalenest-sticker><whalenest-sticker>安慰</whalenest-sticker>',
        UNSOLICITED:'<whalenest-sticker>庆祝</whalenest-sticker>'};
      const metadata=block.type==='text'&&scene&&(stickerGuide||scene==='UNSOLICITED')?frames[scene]:'';
      yield { type: 'block-start', index: 0, blockType: block.type };
      if (block.type === 'text') {
        yield { type: 'text-delta', index: 0, text: block.text };
        for(let i=0;i<metadata.length;i+=4)yield {type:'text-delta',index:0,text:metadata.slice(i,i+4)};
        if(metadata)block={...block,text:block.text+metadata};
      } else yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Fixture());
  if (process.env.WHALENEST_CONTROL_FILE) ctx.inject(['whaleNest', 'schedule'], control => {
    let busy = false, previous;
    const timer = setInterval(async () => {
      const path = process.env.WHALENEST_CONTROL_FILE;
      if (busy || !existsSync(path)) return;
      let command;
      try { command = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
      if (command.id === previous) return;
      busy = true; previous = command.id;
      try {
        let result;
        if(command.method==='policyConfigure')result=control.whaleNest.policy.configure(command.params);
        else if(command.method==='policyState')result=control.whaleNest.policy.status();
        else if(command.method==='contactTick'){control.whaleNest.policy.saveContact({nextAt:Date.now()-1});await control.whaleNest.tickContact();result=control.whaleNest.policy.status();}
        else if(command.method==='nativeState'){const native=control.whaleNest.native;result={sessions:native.hub.sessions(),modules:native.modules.status().filter(m=>m.running).map(m=>m.id),persona:native.getConfig().persona.current,onebotState:native.onebot.state,webServer:!!control.get('webServer')};}
        else if(command.method==='nativeConfigure')result=control.whaleNest.native.setConfig({...control.whaleNest.native.getConfig(),...command.params});
        else if(command.method==='qqSocialTick')result=await control.whaleNest.qqNative.tick();
        else if(command.method==='expressionConfigure')result=control.whaleNest.expressions.configure(command.params);
        else if(command.method==='setQQRecord'){
          const native=control.whaleNest.native,original=native.onebot.call.bind(native.onebot),file=command.params.filePath;
          native.onebot.call=(action,...args)=>action==='get_record'?Promise.resolve({file}):original(action,...args);result={ok:true};
        }
        else if(command.method==='memoryConsolidate')result=await control.whaleNest.memoryAdapter.consolidate();
        else if(command.method==='memoryState')result={...control.whaleNest.memoryAdapter.status(),items:control.whaleNest.memory.list('')};
        else if(command.method==='companionConfigure')result=control.whaleNest.companion.policy.configure(command.params);
        else if(command.method==='companionState')result=control.whaleNest.companion.policy.status();
        else if(command.method==='legacyDiaryWrite')result=await control.whaleNest.native.modules.use('diary').writeDiary({preview:true});
        else if(command.method==='diaryPreview'){const p=command.params??{};result=p.platform==='qq'?control.whaleNest.companion.publisher.qq.preview(p.date,p.visibility):control.whaleNest.companion.publisher.preview(p.date);}
        else if(command.method==='companionTick'){result=await control.whaleNest.tickBackground();await control.whaleNest.flushNotifications?.();}
        else if(command.method==='biliConfigure')result=control.whaleNest.bili.configure(command.params);
        else if(command.method==='biliState')result=control.whaleNest.bili.inbox.status();
        else if(command.method==='biliTick'){result=await control.whaleNest.tickBiliInbox({force:true});await control.whaleNest.flushNotifications();}
        else if (command.method === 'create') result = await control.schedule.create(command.params);
        else if (command.method === 'edit') result = await control.schedule.edit(command.params);
        else if (command.method === 'list') result = await control.schedule.list({ limit: 100 });
        else if (command.method === 'outbox') result = control.whaleNest.outbox();
        else if (command.method === 'liveSessions') result = control.whaleNest.status().liveSessions;
        else if (command.method === 'queueHistorical') result = await control.whaleNest.queueExternalDelivery(command.params.sessionId, command.params.inputIds, command.params.text);
        else if (command.method === 'armCrash') {
          const original = control.whaleNest.queueExternalDelivery;
          control.whaleNest.queueExternalDelivery = (...args) => {
            writeFileSync(path + '.crashed', 'after-native-flush-before-outbox');
            process.kill(process.pid, 'SIGKILL');
            return original(...args);
          };
          result = true;
        }
        else if (command.method === 'resolveUnknown') result = await control.waterfall('schedule/resolve-agent', 'untrusted-session', () => { throw new Error('unexpected fallback'); });
        else throw new Error('Unknown fixture command');
        writeFileSync(path + '.result', JSON.stringify({ id: command.id, ok: true, result }));
      } catch (error) { writeFileSync(path + '.result', JSON.stringify({ id: command.id, ok: false, error: error.stack })); }
      finally { busy = false; }
    }, 30);
    control.effect(() => () => clearInterval(timer));
  });

}
