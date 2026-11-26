import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const catalog=JSON.parse(readFileSync(new URL('./assets/voices.json',import.meta.url),'utf8'));
export const platformVoiceIdPattern=/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/;
assert.equal(catalog.schema,1);assert.ok(typeof catalog.model==='string');
const names=new Map(),ids=new Set();
for(const entry of catalog.voices){
  assert.match(entry.voice,platformVoiceIdPattern);assert.ok(!ids.has(entry.voice));ids.add(entry.voice);
  for(const name of [entry.name,...(entry.aliases??[])]){
    assert.ok(typeof name==='string'&&name.trim()===name&&name&&!names.has(name));names.set(name,entry.voice);
  }
}
const defaults=catalog.voices.filter(entry=>entry.default===true);assert.equal(defaults.length,1);
export const defaultPlatformVoice=defaults[0].voice;

export function resolvePlatformVoice(value,model){
  assert.ok(typeof value==='string'&&value.trim(),'请选择一个音色');
  const input=value.trim(),named=names.get(input);
  if(named){assert.equal(model,catalog.model,'当前语音模型不支持这组音色');return named;}
  assert.match(input,platformVoiceIdPattern,'没有找到这个音色，请先查看可选音色');
  if(ids.has(input))assert.equal(model,catalog.model,'当前语音模型不支持这组音色');
  return input;
}

export function platformVoiceChoices(model,{current,verified=[]}={}){
  const choices=model===catalog.model?catalog.voices:[];
  const all=[...choices.map(({name,voice,style,default:isDefault})=>({name,voice,...(style?{style}:{}),default:isDefault===true}))];
  for(const voice of [current,...verified].filter(Boolean))if(!all.some(entry=>entry.voice===voice))
    all.push({name:voice===current?'当前音色':'自定义音色',voice,default:false});
  return all.map(entry=>({...entry,selected:entry.voice===current,verified:verified.includes(entry.voice)}));
}
