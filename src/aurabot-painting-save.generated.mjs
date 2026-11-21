// Generated original savePainting; stable suffix, existing original gallery format.
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {dataDir} from '../vendor/aurabot/src/core/store.js'
import {mimeOf} from '../vendor/aurabot/src/chat/inbound.js'
const dir=()=>dataDir('imagegen')
export function savePainting (buf, prompt, { now = new Date(), requestId } = {}) {
  try {
    const d = dir()
    mkdirSync(d, { recursive: true })
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
    const slug = String(prompt || '图').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 20)
    const ext = ({ 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mimeOf(buf)] || 'png'
    const suffix = requestId ? '--wn-' + createHash('sha256').update(requestId).digest('hex').slice(0, 16) : ''
    const file = join(d, `${stamp}-${slug}${suffix}.${ext}`)
    const previous = requestId && readdirSync(d).find(name => name.endsWith(suffix + '.' + ext))
    const existing = previous ? join(d, previous) : file
    if (existsSync(existing)) { if (!readFileSync(existing).equals(buf)) return ''; return existing }
    writeFileSync(file, buf, { flag: 'wx', mode: 0o600 })
    return file
  } catch (error) {
    return ''
  }
}
