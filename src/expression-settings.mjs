import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readState,writeState} from './state.mjs';

/** The existing expression file remains the sole writable preference. */
export function createExpressionSettings(options,config) {
 const file=join(options.dataDir,'expressions/settings.json');
 const defaults={enabled:true,voiceEnabled:true,stickersEnabled:true,voiceChance:config.voice.autoChance,
  stickerChance:config.stickers.autoChance,voiceMaxChars:Math.min(80,config.voice.autoMaxChars)};
 const read=()=>({...defaults,...readState(file,{})});
 function configure(patch){
  const next={...read(),...patch};
  for(const k of Object.keys(patch))assert.ok(Object.hasOwn(defaults,k),'Unknown expression setting');
  for(const k of ['enabled','voiceEnabled','stickersEnabled'])assert.equal(typeof next[k],'boolean','Invalid expression switch');
  for(const k of ['voiceChance','stickerChance'])assert.ok(Number.isFinite(next[k])&&next[k]>=0&&next[k]<=1,'Probability must be 0..1');
  assert.ok(Number.isInteger(next.voiceMaxChars)&&next.voiceMaxChars>=1&&next.voiceMaxChars<=80,'Automatic voice length must be 1..80');
  writeState(file,next);return next;
 }
 function project(cfg,{paused=false}={}){
  const s=read(),automatic=options.expressions?.enabled===true&&s.enabled&&!paused;
  return {...cfg,voice:{...cfg.voice,autoChance:automatic&&s.voiceEnabled?s.voiceChance:0,autoMaxChars:s.voiceMaxChars},
   stickers:{...cfg.stickers,autoEnabled:automatic&&s.stickersEnabled,autoChance:automatic&&s.stickersEnabled?s.stickerChance:0}};
 }
 return {read,configure,project};
}
