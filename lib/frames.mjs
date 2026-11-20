/**
 * Разбор zstd-логов по кадрам.
 *
 * Потоковый декодер Node и `zstdDecompressSync` останавливаются на первом
 * кадре, а лог сессии — это тысячи склеенных кадров. Поэтому границы кадров
 * считаются по структуре формата (RFC 8878): заголовок кадра и блоки.
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528

/** Длина кадра, начинающегося в `start`, либо -1, если структура битая. */
export function frameLength(bytes, start) {
  if (start + 4 > bytes.length || bytes.readUInt32LE(start) !== MAGIC) return -1
  let pos = start + 4
  if (pos >= bytes.length) return -1
  const fhd = bytes[pos++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3

  if (!singleSegment) pos += 1
  pos += [0, 1, 2, 4][dictFlag]
  pos += fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]

  for (;;) {
    if (pos + 3 > bytes.length) return -1
    const header = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16)
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    pos += 3
    if (type === 0 || type === 2) pos += size
    else if (type === 1) pos += 1
    else return -1
    if (pos > bytes.length) return -1
    if (last) break
  }

  if (checksum) pos += 4
  return pos - start
}

/** Все кадры лога как пары [начало, конец). */
export function frameSlices(bytes) {
  const slices = []
  let pos = 0
  while (pos < bytes.length) {
    const length = frameLength(bytes, pos)
    if (length <= 0) break
    slices.push([pos, pos + length])
    pos += length
  }
  return slices
}

/** Распаковать один кадр в текст. */
export function decodeFrame(bytes, start, end) {
  return zstdDecompressSync(bytes.subarray(start, end)).toString('utf8')
}

/** Упаковать текст в один кадр. */
export function encodeFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}
