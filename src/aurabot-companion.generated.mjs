// Generated from pinned features/companion.js; original strategy, injected clock/state only.
import { dataDir, readJson, writeJson } from '../vendor/aurabot/src/core/store.js'

export function createSpeakUp({ getConfig, hub, log, isMuted, memory, now = Date.now, random = Math.random, loadState, saveState, clockParts = () => ({ hour: new Date(now()).getHours(), date: new Date(now()).toDateString() }), beforeTick }) {
  const file = () => dataDir('speakup.json')
  const load = () => loadState ? loadState() : readJson(file(), () => ({ day: '', count: 0, nextAt: 0, last: 0 }))
  const save = (s) => saveState ? saveState(s) : writeJson(file(), s)

  function schedule(s, cfg) {
    const min = cfg.minIntervalMinutes
    const max = cfg.maxIntervalMinutes
    s.nextAt = now() + (min + random() * (max - min)) * 60_000
  }

  // 私聊里的「最近一次来往」：只看和主人的私聊，群里再热闹也不影响她想你
  const lastPrivateAt = () => Math.max(hub.lastOwnerChatAt || 0, hub.lastBotToOwner?.at || 0)

  // 每次换个由头，免得句句都是「在干嘛」
  const ANGLES = [
    '分享一件你今天遇到的小事或想到的东西',
    '接着你们上次聊的话题，问问后来怎么样了',
    '想起记忆里关于对方的一件事，顺口提一句或关心一下',
    '问问对方现在在干嘛、吃了没、累不累',
    '撒个娇或者吐槽一句，说你有点无聊',
    '随手发个表情包或者一句没头没尾的感慨',
    '看看现在几点，按时间说点应景的（早上、饭点、深夜）',
  ]

  async function fire(reason = '定时', { nudge = false } = {}) {
    const cfg = getConfig()
    const owner = cfg.ownerName || '主人'
    const idle = Math.round((now() - lastPrivateAt()) / 60000)
    const angle = ANGLES[Math.floor(random() * ANGLES.length)]
    const prompt = nudge
      ? `【系统提醒，不是${owner}说的话】你刚才跟${owner}说「${String(hub.lastBotToOwner?.text || '').slice(-60)}」，${owner}已经 ${idle} 分钟没回了。可以轻轻追一句（比如「人呢」「睡着啦？」，或者换个话题），别催、别抱怨；觉得${owner}在忙就只回 [沉默]。`
      : `【系统提醒，不是${owner}说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和${owner}私聊了，想主动找${owner}说点什么。这次的由头可以是：${angle}。优先用手里真实的素材（最近做过的事、记忆里的、聊天流水里能查到的），没有真实素材就别硬找，也不要编；用你自己的口气，一两句就好，别用模板、别解释为什么来找；实在不想说就只回 [沉默]。`
    log.info(`主动搭话（${reason}）`)
    await hub.pushToSession({ chatId: `private:${cfg.ownerQQ}`, kind: 'private', userId: cfg.ownerQQ, nickname: owner }, [{ type: 'text', text: prompt }], '')
  }

  /** 找白名单里的人：不提主人的事，这是她和对方自己的聊天。 */
  async function fireFriend(qq) {
    const idle = Math.round((now() - (hub.lastPrivateAt?.(qq) || 0)) / 60000)
    const angle = ANGLES[Math.floor(random() * ANGLES.length)]
    const prompt = `【系统提醒，不是对方说的话】你已经 ${idle > 600 ? '很久' : idle + ' 分钟'}没和这位朋友私聊了，想主动找对方说点什么。这次的由头：${angle}。只说你和对方之间的事，别提主人或别人的私事。`
    log.info(`主动搭话（白名单 ${qq}）`)
    await hub.pushToSession({ chatId: `private:${qq}`, kind: 'private', userId: qq, nickname: qq }, [{ type: 'text', text: prompt }], '')
  }

  /** 白名单：每人单独算次数和间隔，一分钟最多找一个人，不一口气群发。 */
  async function tickFriends(cfg, s) {
    const c = cfg.speakUp
    const h = clockParts().hour
    if (!(h >= c.awakeFrom && h < c.awakeTo)) return false
    const today = clockParts().date
    s.friends = s.friends || {}
    for (const qq of c.allow || []) {
      if (String(qq) === String(cfg.ownerQQ) || isMuted?.(`private:${qq}`) || memory?.()?.dislikes?.(qq)) continue
      const f = s.friends[qq] || (s.friends[qq] = {})
      if (f.day !== today) Object.assign(f, { day: today, count: 0 })
      if (!f.nextAt) schedule(f, c)
      if (now() - (hub.lastPrivateAt?.(qq) || 0) > c.idleMinutes * 60_000 && f.count < c.maxPerDay && now() >= f.nextAt) {
        f.count++
        schedule(f, c)
        save(s)
        await fireFriend(qq)
        return true
      }
    }
    return false
  }

  async function tick() {
    const cfg = getConfig()
    const c = cfg.speakUp
    if (!cfg.enabled || !c.enabled) return
    if (beforeTick?.()) return
    if (cfg.ext?.purpose?.enabled === true) return // 目的引擎开着时由它主动找人，两套都跑同一个人会被找两次
    if (isMuted?.(`private:${cfg.ownerQQ}`)) { // 主人在私聊里让她闭嘴了：只管主人这边，白名单照旧
      const s = load()
      if (!(await tickFriends(cfg, s))) save(s)
      return
    }
    const s = load()
    const today = clockParts().date
    if (s.day !== today) Object.assign(s, { day: today, count: 0 })
    if (!s.nextAt) schedule(s, c)
    const h = clockParts().hour
    const awake = h >= c.awakeFrom && h < c.awakeTo
    const idleOk = now() - lastPrivateAt() > c.idleMinutes * 60_000
    // 追问：她最后一句是在问主人、主人 15~40 分钟没回，有一半的机会轻轻追一句（每句最多追一次，不占每天的次数）
    const lb = hub.lastBotToOwner || { at: 0, text: '' }
    const quiet = now() - lb.at
    if (awake && c.nudge && lb.at > (hub.lastOwnerChatAt || 0) && lb.at !== s.nudgedFor && /[？?]|吗|呢|嘛|没$/.test(lb.text.trim()) && quiet > 15 * 60_000 && quiet < 40 * 60_000) {
      s.nudgedFor = lb.at
      save(s)
      if (random() < 0.5) await fire('追问', { nudge: true })
      return
    }
    if (awake && idleOk && s.count < c.maxPerDay && now() >= s.nextAt) {
      if (!loadState) s.count++
      s.last = now()
      schedule(s, c)
      save(s)
      await fire()
      return
    }
    if (!(await tickFriends(cfg, s))) save(s)
  }

  return { tick, fire, state: load }
}
