/**
 * «Надгробия»: отметки об удалённых сессиях, чтобы удаление доехало до других
 * устройств. Файл лежит в зеркале и попадает в тот же коммит, что и удаление.
 *
 * Удаление на устройстве не стирает данные мгновенно: локальная копия
 * переносится в ~/.dsh/dsh-sync/deleted/<время>/, поэтому откатить можно.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const TOMBSTONES_FILE = 'tombstones.json'

export async function readTombstones(repoDir) {
  try {
    const parsed = JSON.parse(await readFile(join(repoDir, TOMBSTONES_FILE), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object') {
      return { version: 1, sessions: parsed.sessions }
    }
  } catch {
    // файла ещё нет
  }
  return { version: 1, sessions: {} }
}

export async function writeTombstones(repoDir, data) {
  await writeFile(join(repoDir, TOMBSTONES_FILE), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function addTombstone(data, sessionId, deviceId) {
  data.sessions[sessionId] = { at: new Date().toISOString(), device: deviceId }
  return data
}

export function dropTombstone(data, sessionId) {
  if (data.sessions[sessionId] !== undefined) {
    delete data.sessions[sessionId]
    return true
  }
  return false
}
