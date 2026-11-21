import assert from 'node:assert/strict';

export function verifyLiveModules(status){
 assert.ok(Array.isArray(status.modules),'Runtime module status missing');
 assert.equal(new Set(status.modules).size,status.modules.length,'Duplicated running module');
 for(const id of ['bili','diary','companion-management','memory','mood','speakup','stickers','voice'])
  assert.equal(status.modules.filter(name=>name===id).length,1,'Missing or duplicated shared module: '+id);
 if(status.imageGeneration?.enabled)assert.equal(status.modules.filter(name=>name==='imagegen').length,1,'Missing or duplicated original imagegen');
 if(status.singing?.enabled)assert.equal(status.modules.filter(name=>name==='song').length,1,'Missing or duplicated platform song module');
 if(status.qqNative?.configured)for(const id of ['qq-tools','qq-api','profile','contacts','qzone-social'])assert.equal(status.modules.filter(name=>name===id).length,1,'Missing or duplicated original QQ module: '+id);
 // Additional original QQ/platform modules are legitimate when enabled.
 return {sharedModulesPresent:true};
}

export function verifyLiveTools(status,profile,{activitiesEnabled=false,speechEnabled=false,imagesEnabled=false,songsEnabled=false}={}){
 const legacy=/mnemon|dsh-feiyu-mood|dsh-bili-subagent|dsh-fish-memory/;
 const packages=[...Object.keys(profile.dependencies??{}),...(profile.dsh?.profile?.bundles??[])];
 assert.ok(!packages.some(name=>legacy.test(name)),'Old independent plugin package remains in the profile');
 assert.ok(!status.tools.some(name=>/mnemon|feiyu_mood/.test(name)),'Old exclusive plugin tools remain loaded');
 if(activitiesEnabled)for(const name of ['bili_scan','bili_whoami','bili_search','bili_subtitle','bili_comments','bili_reply','bili_triple','bili_send_message','bili_send_dynamic','bili_status','bili_login_start','bili_login_poll','bili_setup','bili_config'])assert.equal(status.tools.filter(item=>item===name).length,1,'Missing or duplicated unified tool: '+name);
 if(activitiesEnabled)assert.equal(status.tools.filter(name=>name==='companion_diary').length,1,'Missing or duplicated shared diary tool');
 if(speechEnabled)for(const tool of ['send_voice','companion_voice'])assert.equal(status.tools.filter(name=>name===tool).length,1,'Missing or duplicated voice tool: '+tool);
 if(imagesEnabled)for(const tool of ['draw_image','companion_paintings'])assert.equal(status.tools.filter(name=>name===tool).length,1,'Missing or duplicated image tool: '+tool);
 if(songsEnabled)for(const tool of ['sing_song','companion_songs'])assert.equal(status.tools.filter(name=>name===tool).length,1,'Missing or duplicated singing tool: '+tool);
 return {oldPluginPackagesAbsent:true,oldExclusiveToolsAbsent:true,biliFacadeTools:activitiesEnabled,speechTool:speechEnabled};
}
