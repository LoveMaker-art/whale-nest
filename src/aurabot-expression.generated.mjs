// Generated from the pinned QQ Hub voice expression block. Both channels call this function.
import {requestedSticker} from './sticker-selection.mjs';
export function selectReplyItems(items,{cfg,mood,opts={},chatId='',random=Math.random}) {
 const textOnly=/(不要|不用|别|只用|仅用).{0,6}语音|文字回复|打字回复/.test(opts.userText??'');
 if (textOnly) items=items.map(i=>i.kind==='voice'?{...i,kind:'text'}:i);
 if (opts.manualMedia) return items.filter(i=>i.kind!=='sticker').map(i=>i.kind==='voice'?{...i,kind:'text'}:i);
 if (!requestedSticker(opts.userText??'')) items=items.filter(i=>i.kind!=='sticker');
 if (opts.backgroundJob) return items;
    // 对方明确要语音、她却只打了字：整段改成语音发（模型偶尔会忘，这里兜底）
    if (!textOnly && opts.allowVoice !== false && opts.wantVoice && cfg.voice.enabled && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    // 短回复按概率整条变语音
    const texts = items.filter((i) => i.kind === 'text')
    if (!textOnly && opts.allowVoice !== false && cfg.voice.enabled && items.length === texts.length && texts.length > 0) {
      const all = texts.map((t) => t.value).join('，')
      if (!/```|!\[|https?:\/\//.test(all) && all.length <= cfg.voice.autoMaxChars && random() < cfg.voice.autoChance * mood().voice) items = [{ kind: 'voice', value: all }]
    }
    const inGroup = chatId.startsWith('group:')
    // 群里别刷屏：一段最多 3 条
    if (inGroup && items.length > 3) items = items.slice(0, 3)

 return items;
}
