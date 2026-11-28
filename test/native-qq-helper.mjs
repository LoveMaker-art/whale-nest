import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startMockOneBot} from '../vendor/aurabot/test/helpers/mock-onebot.js';
import {bridgeDirectory,bootBridge} from './bridge-helper.mjs';
import {seedBiliAccount} from './bili-test-helper.mjs';
import {enablePlatformSpeech,enablePlatformImage,enablePlatformSinging} from '../src/runtime-upgrade.mjs';

export const call=(name,args)=>'FOUNDATION_TOOL '+JSON.stringify({name,args});
export async function until(predicate) {
  const deadline=Date.now()+18000;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await delay(30);}
  throw Error('Native QQ test timed out');
}

export async function linkedFixture(t,{limit,contactMode,loginDelayMs=700,bili=false,inbox=false,voiceServer,imageServer,songServer,expressions=false,nativeModules=false,lateNotice=false}={}){
  const mock=await startMockOneBot({selfId:'20000002',loginDelayMs});
  t.after(()=>mock.close());
  const directory=await bridgeDirectory();
  directory.options.owners=[directory.options.owners[0],{channel:'qq',account:'20000002',sender:'10000001'}];
  directory.options.qq={enabled:true,nativeModules};
  if(expressions){directory.options.expressions={enabled:true};directory.options.clawchat.delivery.mediaEnabled=true;}
  if(imageServer){const provider=join(directory.root,'image-provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:imageServer,apiKey:'image-fixture'}}}}));directory.options.image=enablePlatformImage({providerConfigPath:provider});directory.options.clawchat.delivery.mediaEnabled=true;}
  if(songServer){const provider=join(directory.root,'song-provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:songServer,apiKey:'song-fixture'}}}}));directory.options.singing=enablePlatformSinging({providerConfigPath:provider,pollMs:3000});directory.options.clawchat.delivery.mediaEnabled=true;}
  if(voiceServer){
    const provider=join(directory.root,'speech-provider.json');await writeFile(provider,JSON.stringify({models:{providers:{clawling:{baseUrl:voiceServer,apiKey:'voice-fixture'}}}}));
    directory.options.speech=enablePlatformSpeech({providerConfigPath:provider});directory.options.expressions={enabled:true};directory.options.clawchat.delivery.mediaEnabled=true;
  }
  if(limit!==undefined)directory.options.activities={enabled:false,automatic:false,maxDailyBackgroundModelCalls:limit};
  if(bili){directory.biliFixture=true;directory.options.activities={enabled:true,automatic:false,maxDailyBackgroundModelCalls:limit??0};}
  if(inbox){directory.biliInboxFixture=join(directory.root,'bili-inbox-fixture.json');seedBiliAccount(directory.options,directory.options.clawchat.route);await writeFile(directory.biliInboxFixture,JSON.stringify({sessions:{session_list:[],has_more:0},messages:{messages:[],has_more:0},at:{items:[],cursor:{is_end:true}},reply:{items:[],cursor:{is_end:true}}}));}
  if(contactMode)directory.nativeModelEnv={WHALENEST_CONTACT_FIXTURE:contactMode};
  if(lateNotice)directory.nativeModelEnv={...directory.nativeModelEnv,WHALENEST_TEST_LATE_NOTICE:'1'};
  await writeFile(directory.configPath,JSON.stringify(directory.options));
  const data=join(directory.options.dataDir,'aurabot');
  await mkdir(data,{recursive:true});
  await writeFile(join(data,'config.json'),JSON.stringify({
    enabled:true,dryRun:false,safeMode:true,gateway:'onebot',botQQ:'20000002',ownerQQ:'10000001',
    workspaceDir:join(directory.root,'qq-workspace'),persona:{current:'dafeiyu-original'},model:directory.options.model,
    modules:Object.fromEntries(['stickers','mood','memory','bili','companion-management','qq-tools','qq-api'].map(id=>[id,{enabled:true}]).concat(
      ['voice','imagegen','diary','qzone-social','speakup','purpose','song','profile','contacts','video'].map(id=>[id,{enabled:false}]))),
    snowluma:{autoStart:false,autoAttach:false,httpUrl:mock.httpUrl,wsUrl:mock.wsUrl,httpToken:mock.token,wsToken:mock.token},
    approvalViaQQ:false,security:{dangerConfirm:false},
    merge:{enabled:false},voice:{enabled:!!voiceServer,autoChance:0},stickers:{autoChance:0,collect:false,caption:false},
    mood:{enabled:true,judge:false},memory:{enabled:true,dailyConsolidate:false,shortTerm:false,extractIdleMinutes:0,vector:{enabled:false}},
    speakUp:{enabled:false},bili:{enabled:bili,minViews:0},chat:{seedHistory:false},
  }));
  const bridge=await bootBridge(directory);t.after(()=>bridge.close());
  return {mock,directory,bridge,data};
}
