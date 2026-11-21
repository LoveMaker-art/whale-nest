import {statSync} from 'node:fs';
import {basename,join} from 'node:path';
import {hash} from './routing.mjs';
import {readState,writeState} from './state.mjs';
import {stickerPath,NEVER_RANDOM} from './aurabot-stickers.generated.mjs';

const legacyScenes = ['庆祝','安慰','晚安','熟人玩笑'];
export const stickerScenes = [...legacyScenes,'吃喝','问候','回应','感谢','陪伴','撒娇','情绪表达','惊讶','疲惫','思考','吐槽','休闲','音乐','节日'];
export const stickerDirections = ['大肥鱼自己','给对方','一起','围观'];
const directions = stickerDirections;
const reserved = new Set([...stickerScenes,...directions,NEVER_RANDOM,'通用']);
const open = '<whalenest-sticker';
const close = '</whalenest-sticker>';
const guidance = '本轮已抽中自动配表情。正文末尾必须另起一行输出一个内部结果。接蹭饭玩笑示例：<whalenest-sticker>熟人玩笑|白饭,蹭饭|大肥鱼自己</whalenest-sticker>。从本轮词表选一个场景和最具体的话题，可加补充词。表达方向为大肥鱼自己、给对方、一起或围观。根据整句对话及正文语义选择，近义口语可映射到词表。认真倾诉、否定、引用转述或语境不明时输出 <whalenest-sticker>跳过</whalenest-sticker>。禁止为配图调用发送工具或在正文解释。';
const safeTopic = value => typeof value==='string'&&/^[\p{L}\p{N}]{1,8}$/u.test(value);
const normalized = value => value.normalize('NFKC').toLowerCase();
const itemTopics = item => (item.tags??[]).filter(tag=>safeTopic(tag)&&!reserved.has(tag));

function parseDecision(value) {
  if(legacyScenes.includes(value))return value;
  const fields=value?.normalize('NFKC').split('|').map(field=>field.trim());
  if(fields?.length!==3)return null;
  const [scene,terms,direction]=fields;
  const topics=terms.split(/[,，]/).map(term=>term.trim());
  if(!stickerScenes.includes(scene)||!directions.includes(direction)||topics.length>3||
     topics.some(topic=>!safeTopic(topic)||(reserved.has(topic)&&topic!=='通用'))||
     (topics.includes('通用')&&topics.length!==1))return null;
  return {scene,topics:[...new Set(topics.map(normalized))],direction};
}

function relevance(item,decision) {
  const scene=typeof decision==='string'?decision:decision?.scene;
  if(!stickerScenes.includes(scene)||!item?.tags?.includes(scene))return 0;
  const topics=itemTopics(item);
  if(typeof decision==='string')return legacyScenes.includes(scene)&&!topics.length?1:0;
  if(!directions.includes(decision.direction)||!Array.isArray(decision.topics)||!decision.topics.length)return 0;
  const roles=item.tags.filter(tag=>directions.includes(tag));
  if(roles.length&&!roles.includes(decision.direction))return 0;
  const [primary,...other]=decision.topics;
  if(primary==='通用')return topics.length?0:1;
  const terms=new Set(topics.map(normalized));
  if(!terms.has(primary))return 0;
  return 1+other.filter(term=>terms.has(term)).length*2+Number(roles.length>0);
}
const fallbackScenes = new Set(['熟人玩笑','吃喝','音乐','休闲','晚安','节日','庆祝','问候','感谢']);
const fallbackGuards = /没(?:有)?在|不用|不要|不想|不必|并没|只是.{0,5}(?:提到|引用)|难过|痛苦|去世|崩溃|委屈|生病|抑郁|求助/;
const roleSignals = {
  大肥鱼自己:/我|大肥鱼|小鲸鱼/,
  给对方:/祝你|恭喜你|送你|给你|为你|谢谢你/,
  一起:/一起|我们|咱们/,
  围观:/围观|吃瓜|看戏/,
};
function mentioned(topic,text) {
  return text.includes(topic) || (topic==='蹭饭'&&/蹭.{0,3}饭/.test(text));
}

function fallbackDecision(items,incoming,reply) {
  if(!incoming||!reply||fallbackGuards.test(incoming)||fallbackGuards.test(reply))return null;
  incoming=normalized(incoming);
  reply=normalized(reply);
  const matches=[];
  for(const item of items){
    if(item.tags?.includes(NEVER_RANDOM))continue;
    const scene=item.tags?.find(tag=>fallbackScenes.has(tag));
    const direction=item.tags?.find(tag=>directions.includes(tag));
    if(!scene||!direction||!roleSignals[direction].test(reply))continue;
    const topics=itemTopics(item).map(normalized);
    const shared=topics.filter(topic=>topic.length>=2&&mentioned(topic,incoming)&&mentioned(topic,reply));
    if(scene==='熟人玩笑'&&topics.includes('蹭饭')&&topics.includes('白饭')&&mentioned('蹭饭',incoming)
      &&/白饭|米饭|一碗/.test(incoming)&&/饭|碗/.test(reply))shared.unshift('蹭饭');
    if(shared.length)matches.push({scene,direction,topics:[...new Set(shared)].slice(0,3)});
  }
  matches.sort((a,b)=>b.topics.length-a.topics.length);
  return matches.length&&matches[0].topics.length!==(matches[1]?.topics.length??0)?matches[0]:null;
}

const noMedia = /(?:别|不要|不用|禁止|无需).{0,8}(?:发|配|加|贴).{0,6}(?:图|表情)|(?:只|仅)(?:用|发|要)?文字|文字回复|打字回复/;
const mediaRequest = /(?:发|给|来|配|贴|画|生成|重发|再发)(?!了).{0,12}(?:表情包?|动图|图片|张图|这张|那张|照片|图(?=$|[。！？，、\s]))|(?:收录|收藏|导入|收为|存为|保存).{0,14}(?:图|表情|收藏)|把.{0,16}(?:图|表情).{0,9}(?:发|收|存)|(?:请|帮我|给我|我要).{0,12}(?:修改|更改|开启|关闭|删除|更新|连接|绑定|查询|检查|记住|提醒|设置)|(?:开启|关闭|修改|更改|调整|查看|检查).{0,12}(?:设置|自动|更新|状态|开关)/;

export const requestedSticker = text => !noMedia.test(text) && /(?:发|给|来|贴)(?!了).{0,16}(?:表情|动图)|(?:表情|动图).{0,8}(?:发给|发我|发一)/.test(text);
export const blocksAutomaticSticker = text => noMedia.test(text) || mediaRequest.test(text) || requestedSticker(text);

function suffixLength(text, delimiter) {
  for (let n=Math.min(text.length,delimiter.length-1);n>0;n--) {
    if (text.slice(-n).toLowerCase()===delimiter.slice(0,n)) return n;
  }
  return 0;
}

// Keep delimiter prefixes until they can be classified. The frame body stays
// bounded even if the provider omits its terminator.
function frameFilter() {
  let pending='', header=false, body='', overflow=false;
  const decisions=[];
  return {
    decisions,
    push(delta) {
      let output='';
      pending+=delta;
      while(pending) {
        const delimiter=header?close:open;
        const at=pending.toLowerCase().indexOf(delimiter);
        const carry=at<0?suffixLength(pending,delimiter):0;
        const part=at<0?pending.slice(0,pending.length-carry):pending.slice(0,at);
        if (header) {
          if (body.length+part.length>80) overflow=true;
          if (!overflow) body+=part;
        } else output+=part;
        if(at<0) { pending=pending.slice(pending.length-carry); break; }
        pending=pending.slice(at+delimiter.length);
        if(header) {
          const value=overflow?'':body.match(/^>\s*([^<>\r\n]+?)\s*$/)?.[1];
          decisions.push(parseDecision(value));
          body='';overflow=false;
        }
        header=!header;
      }
      return output;
    },
    finish() {
      if (header || pending.length>=3) decisions.push(null);
      return !header && pending.length<3 ? pending : '';
    },
  };
}

export function createStickerSelection(options,{getConfig,settings,policy,mood,store:guideStore,random=Math.random,now=Date.now}) {
  const active=new Map();
  const enabled=()=> {
    const cfg=settings.project(getConfig(),{paused:policy.status().settings.paused}).stickers;
    return cfg.enabled&&cfg.autoEnabled&&cfg.autoChance>0 ? cfg.autoChance : 0;
  };
  const usageFile = route => join(options.dataDir,'expressions/sticker-usage',hash([route.channel,route.account,route.conversation])+'.json');
  const qqRoute = conversation => ({channel:'qq',account:getConfig().botQQ,conversation});
  function available(item,route) {
    if (!item?.file||basename(item.file)!==item.file||item.tags?.includes(NEVER_RANDOM)) return false;
    if (route.channel==='qq'&&item.market?.emojiId) return true;
    return statSync(stickerPath(item),{throwIfNoEntry:false})?.isFile()===true;
  }
  return {
    prepare(id,turn,texts) {
      active.delete(id);
      if (!texts?.length) return;
      const base=enabled();
      const chance=base&&!texts.some(blocksAutomaticSticker)?Math.min(1,base*Math.max(0,mood().sticker??1)):0;
      const attempt=chance>0&&random()<chance;
      if(active.size>=128)active.delete(active.keys().next().value);
      active.set(id,{turn,attempt,scene:null,incoming:attempt?texts.join('\n').slice(-1200):''});
    },
    stop(id) {
      const round=active.get(id);
      if(round){round.attempt=false;round.scene=null;}
    },
    forget(id){ active.delete(id); },
    guide(id) {
      if(!active.get(id)?.attempt)return '';
      const items=guideStore?.()?.library().items;
      if(!items)return guidance;
      const terms=new Map();
      for(const item of items){
        if(item.tags?.includes(NEVER_RANDOM))continue;
        const topics=itemTopics(item);
        for(const scene of item.tags??[]){
          if(!stickerScenes.includes(scene))continue;
          if(!terms.has(scene))terms.set(scene,new Set());
          const sceneTerms=terms.get(scene);
          for(const topic of topics.length?topics:['通用'])if(sceneTerms.size<48)sceneTerms.add(topic);
        }
      }
      const vocabulary=[...terms].map(([scene,topics])=>scene+'：'+[...topics].join('、')).join('\n');
      return guidance+'\n'+(vocabulary||'图库没有可用场景，请跳过。');
    },
    scene(id,turn) {
      const round=active.get(id);
      return round?.turn===turn ? round.scene : null;
    },
    async *stream(request,next) {
      const round=active.get(String(request.sessionId));
      if(!round||request.purpose) { yield* next(); return; }
      const blocks=new Map();
      round.scene=null;
      for await(const chunk of next()) {
        if (chunk.type==='tool-call-delta'||chunk.type==='block-start'&&chunk.blockType==='tool-call'
          ||chunk.type==='block-end'&&chunk.block.type==='tool-call') round.attempt=false;
        if (chunk.type==='text-delta') {
          if(!blocks.has(chunk.index))blocks.set(chunk.index,{filter:frameFilter(),text:''});
          const block=blocks.get(chunk.index),text=block.filter.push(chunk.text);
          block.text=(block.text+text).slice(-1500);
          if (text) yield {...chunk,text};
        } else if(chunk.type==='block-end'&&chunk.block.type==='text') {
          const filter=frameFilter();
          const text=filter.push(chunk.block.text)+filter.finish();
          blocks.set(chunk.index,{closed:true,filter,text:text.slice(-1500)});
          yield {...chunk,block:{...chunk.block,text}};
        } else if(chunk.type==='finish') {
          const decisions=[],reply=[];
          for(const [index,block] of blocks) {
            if(!block.closed) {
              const text=block.filter.finish();
              if(text) yield {type:'text-delta',index,text};
              block.text+=text;
            }
            reply.push(block.text);
            decisions.push(...block.filter.decisions);
          }
          if(round.attempt&&chunk.reason.kind==='stop'){
            if(decisions.length===1)round.scene=decisions[0];
            else if(!decisions.length&&guideStore)round.scene=fallbackDecision(guideStore()?.library().items??[],round.incoming,reply.join('\n'));
          }
          yield chunk;
        } else yield chunk;
      }
    },
    pick(route,decision,store) {
      if(!enabled()||!decision)return null;
      const used=readState(usageFile(route),{});
      const candidates=store.library().items.map(item=>({item,score:relevance(item,decision)}))
        .filter(({item,score})=>score>0&&available(item,route));
      candidates.sort((a,b)=>b.score-a.score||(used[a.item.md5]??0)-(used[b.item.md5]??0)
        ||String(a.item.md5).localeCompare(String(b.item.md5),'en'));
      return candidates[0]?.item??null;
    },
    usable(route,item,decision) {
      return Boolean(enabled()&&relevance(item,decision)>0&&available(item,route));
    },
    record(route,item) {
      try {
        const file=usageFile(route),used=readState(file,{});
        used[item.md5]=now();
        writeState(file,used);
      } catch (error) { console.warn('[whalenest-stickers] usage was not saved: '+error.name); }
    },
    qqRoute,
  };
}
