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
 * Длина первого zstd-фрейма. Кадр завершён на минимальной длине, при которой
 * декодер выдаёт непустой результат; дальше при флаге checksum идут 4 байта.
 */
export function headerFrameLength(buf) {
  if (buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) return undefined
  const checksum = (buf[4] & 0x04) !== 0
  let lo = 5
  let hi = Math.min(buf.length, 1 << 20)
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    let ok = false
    try {
      ok = zstdDecompressSync(buf.subarray(0, mid)).length > 0
    } catch {
      ok = false
    }
    if (ok) {
      found = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  if (found < 0) return undefined
  const end = found + (checksum ? 4 : 0)
  if (end > buf.length) return undefined
  if (end < buf.length && !buf.subarray(end, end + 4).equals(MAGIC)) return undefined
  return end
}

/** Заголовок сессии из первого фрейма + длина фрейма. */
export function readHeader(buf) {
  const frameEnd = headerFrameLength(buf)
  if (frameEnd === undefined) return undefined
  const text = zstdDecompressSync(buf.subarray(0, frameEnd)).toString('utf8')
  const line = text.split('\n')[0]
  let header
  try {
    header = JSON.parse(line)
  } catch {
    return undefined
  }
  if (header === null || typeof header !== 'object' || header.type !== 'session' || typeof header.cwd !== 'string') return undefined
  return { header, frameEnd, raw: line }
}

/** Новый лог: переписан только первый фрейм, хвост байт-в-байт. */
export function rewriteHeader(buf, header, frameEnd) {
  const line = `${JSON.stringify(header)}\n`
  return Buffer.concat([zstdCompressSync(Buffer.from(line, 'utf8')), buf.subarray(frameEnd)])
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
