/**
 * Починка логов, скопированных при конфликте.
 *
 * Копия получает новый идентификатор в заголовке, но события внутри
 * (`session-log-deepseek/delivery-accepted`) всё ещё называют исходную сессию.
 * DSH считает такой лог повреждённым, поэтому при создании копии и при
 * обслуживании мы переписываем идентификатор внутри событий.
 */
import { decodeFrame, encodeFrame, frameSlices } from './frames.mjs'

/**
 * Исправить ссылки на идентификатор сессии внутри событий.
 * @param bytes содержимое лога
 * @returns { bytes, changed } — новое содержимое и число исправленных событий
 */
export function repairLog(bytes) {
  const slices = frameSlices(bytes)
  if (slices.length === 0) return { bytes, changed: 0 }

  let header
  try {
    header = JSON.parse(decodeFrame(bytes, slices[0][0], slices[0][1]).trim())
  } catch {
    return { bytes, changed: 0 }
  }
  if (typeof header?.id !== 'string' || header.id === '') return { bytes, changed: 0 }

  const parts = [bytes.subarray(0, slices[0][1])]
  let changed = 0

  for (let index = 1; index < slices.length; index++) {
    const [start, end] = slices[index]
    const text = decodeFrame(bytes, start, end)
    if (!text.includes('"sessionId"')) {
      parts.push(bytes.subarray(start, end))
      continue
    }

    let touched = false
    const patched = text.split('\n').map((line) => {
      if (!line.trim()) return line
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return line
      }
      const data = event?.data
      if (data === null || typeof data !== 'object') return line
      if (typeof data.sessionId !== 'string' || data.sessionId === header.id) return line
      // Наследие родительской сессии не трогаем: оно законно ссылается на неё.
      if (header.parentSession !== undefined && event.seq < (data.inheritedEventCount ?? 0)) return line
      data.sessionId = header.id
      touched = true
      changed += 1
      return JSON.stringify(event)
    })

    parts.push(touched ? encodeFrame(patched.join('\n')) : bytes.subarray(start, end))
  }

  return { bytes: Buffer.concat(parts), changed }
}
