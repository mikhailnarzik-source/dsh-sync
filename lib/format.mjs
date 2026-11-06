/**
 * Примитивы формата DSH: каталог проекта, первый zstd-фрейм (заголовок) и
 * нормализация путей. Никакого fs — только байты и строки.
 *
 * Формат: `sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`,
 * где первый фрейм содержит одну строку заголовка, а дальше идут фреймы с
 * событиями (append-only).
 */
import { platform } from 'node:os'
import { posix, win32 } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const IS_WIN = platform() === 'win32'
export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Порт `projectKey` из @deepseek-ai/dsh-session-persistence-jsonl. */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Кодирование одного сегмента пути (id сессии) — порт `encodeSegment`. */
export function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Длина первого zstd-фрейма (заголовка).
 *
 * Границу ищем по началу следующего кадра (магическое число), а не по
 * «усечённому» декодированию: новые сборки Node проверяют контрольную сумму и
 * отвергают кадр без четырёх завершающих байт. Кандидаты проверяются реальным
 * декодированием, поэтому ложное совпадение магического числа внутри данных не
 * ломает разбор.
 */
export function headerFrameLength(buf) {
  if (buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) return undefined
  const limit = Math.min(buf.length, 1 << 20)
  const candidates = []

  for (let i = 4; i + 4 <= limit && candidates.length < 8; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) candidates.push(i)
  }
  candidates.push(buf.length)

  for (const end of candidates) {
    if (end < 8) continue
    try {
      const out = zstdDecompressSync(buf.subarray(0, end))
      if (out.length > 0) return end
    } catch {
      // не граница — пробуем следующий кандидат
    }
  }
  return undefined
}

/** Заголовок сессии из первого фрейма + длина фрейма. */
export function readHeader(buf) {
  const frameEnd = headerFrameLength(buf)
  if (frameEnd === undefined) {
    // Лог без сжатия: первая строка — заголовок, дальше обычный JSONL.
    const newline = buf.indexOf(0x0a)
    if (newline <= 0) return undefined
    const line = buf.subarray(0, newline).toString('utf8')
    let plain
    try {
      plain = JSON.parse(line)
    } catch {
      return undefined
    }
    if (plain === null || typeof plain !== 'object' || plain.type !== 'session' || typeof plain.cwd !== 'string') return undefined
    return { header: plain, frameEnd: newline + 1, raw: line, plain: true }
  }
  const text = zstdDecompressSync(buf.subarray(0, frameEnd)).toString('utf8')
  const line = text.split('\n')[0]
  let header
  try {
    header = JSON.parse(line)
  } catch {
    return undefined
  }
  if (header === null || typeof header !== 'object' || header.type !== 'session' || typeof header.cwd !== 'string') return undefined
  return { header, frameEnd, raw: line, plain: false }
}

/** Новый лог: переписан только заголовок, хвост байт-в-байт. */
export function rewriteHeader(buf, header, frameEnd) {
  const line = `${JSON.stringify(header)}\n`
  const plain = buf.length < 4 || !buf.subarray(0, 4).equals(MAGIC)
  const head = plain ? Buffer.from(line, 'utf8') : zstdCompressSync(Buffer.from(line, 'utf8'))
  return Buffer.concat([head, buf.subarray(frameEnd)])
}

/** Нормализация пути для сравнения (на Windows регистр не значим). */
export function normalizePath(value) {
  const p = (IS_WIN ? win32 : posix).normalize(value)
  const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, '') : p
  return IS_WIN ? trimmed.toLowerCase() : trimmed
}

export function samePath(a, b) {
  return normalizePath(a) === normalizePath(b)
}
