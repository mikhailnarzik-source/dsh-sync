/**
 * Чтение локального стора и зеркала. Все операции с логами — на уровне первого
 * zstd-фрейма: заголовок переписывается, хвост событий остаётся байт-в-байт,
 * поэтому его можно сравнивать побайтово между устройствами.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  encodeSegment,
  headerFrameLength,
  projectKey,
  readHeader,
  rewriteHeader,
  samePath,
} from './format.mjs'
import { canonicalCwd } from './config.mjs'

export const LOG_NAME = 'session.v4.jsonl.zstd'
const SESSION_SUFFIX = '.jsonl.zstd'

/** Заголовок + хвост лога. */
export function splitLog(bytes) {
  const frameEnd = headerFrameLength(bytes)
  if (frameEnd === undefined) throw new Error('не удалось прочитать первый zstd-фрейм')
  const parsed = readHeader(bytes)
  if (!parsed) throw new Error('заголовок сессии не распознан')
  return { header: parsed.header, frameEnd, tail: bytes.subarray(frameEnd) }
}

/** Лог в переносимом виде: cwd заменён нейтральным путём проекта. */
export function canonicalize(bytes, projectId) {
  const { header, frameEnd } = splitLog(bytes)
  return rewriteHeader(bytes, { ...header, cwd: canonicalCwd(projectId) }, frameEnd)
}

/** Лог для локального устройства: cwd заменён на локальный путь (и, если нужно, id). */
export function remapTo(bytes, targetPath, options = {}) {
  const { header, frameEnd } = splitLog(bytes)
  const next = { ...header, cwd: targetPath }
  if (options.id) next.id = options.id
  return rewriteHeader(bytes, next, frameEnd)
}

/** Путь файла в зеркале. */
export function mirrorLogPath(repoDir, projectId, sessionId) {
  return join(repoDir, 'sessions', projectId, encodeSegment(sessionId), LOG_NAME)
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Все сессии локального стора: id, cwd, байты, путь. */
export async function listLocalSessions(home) {
  const root = join(home, 'sessions')
  const sessions = []
  for (const bucket of await listDir(root)) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(root, bucket.name)
    for (const entry of await listDir(bucketDir)) {
      if (!entry.isDirectory()) continue
      const dir = join(bucketDir, entry.name)
      const files = (await listDir(dir)).filter(file => file.isFile() && file.name.endsWith(SESSION_SUFFIX))
      const log = files.find(file => file.name === LOG_NAME) ?? files.sort((a, b) => b.name.localeCompare(a.name))[0]
      if (!log) continue
      const path = join(dir, log.name)
      const bytes = await readFile(path)
      const parsed = readHeader(bytes)
      if (!parsed) continue
      sessions.push({
        id: parsed.header.id,
        cwd: parsed.header.cwd,
        createdAt: parsed.header.createdAt,
        bucket: bucket.name,
        dir,
        path,
        size: (await stat(path)).size,
        bytes,
      })
    }
  }
  return sessions
}

/** Сессии проекта в зеркале: id, cwd (нейтральный), байты. */
export async function listMirrorSessions(repoDir, projectId) {
  const root = join(repoDir, 'sessions', projectId)
  const result = []
  for (const entry of await listDir(root)) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, LOG_NAME)
    if (!existsSync(path)) continue
    const bytes = await readFile(path)
    const parsed = readHeader(bytes)
    if (!parsed) continue
    result.push({
      id: parsed.header.id,
      cwd: parsed.header.cwd,
      path,
      dir: join(root, entry.name),
      bytes,
      size: (await stat(path)).size,
    })
  }
  return result
}

export function isLocked(sessionDir) {
  return existsSync(join(sessionDir, 'session.lock'))
}

export function sessionsOfProject(sessions, projectPath) {
  return sessions.filter(session => samePath(session.cwd, projectPath))
}

export function localSessionDir(home, cwd, sessionId) {
  return join(home, 'sessions', projectKey(cwd), encodeSegment(sessionId))
}
