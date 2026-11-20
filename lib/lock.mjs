/**
 * Межпроцессный лок синхронизации.
 *
 * Два экземпляра DSH на одной машине, автоматика и ручная кнопка могут
 * запустить синхронизацию одновременно — тогда два процесса пишут в одно
 * git-дерево. Лок создаётся атомарно каталогом и снимается по завершении;
 * зависший лок старше порога считается мусором.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STALE_MS = 10 * 60_000

/**
 * Взять лок.
 * @param dir каталог состояния (~/.dsh/dsh-sync)
 * @param owner подпись владельца для диагностики
 * @returns объект с release() либо undefined, если лок занят
 */
export async function acquireLock(dir, owner = 'sync') {
  const path = join(dir, 'sync.lock')
  await mkdir(dir, { recursive: true })

  const take = async () => {
    await mkdir(path)
    await writeFile(join(path, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: Date.now(), owner })}\n`, 'utf8')
  }

  try {
    await take()
    return {
      path,
      async release() {
        await rm(path, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  let stale = false
  try {
    const info = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'))
    stale = typeof info?.at !== 'number' || Date.now() - info.at > STALE_MS
  } catch {
    stale = true
  }
  if (!stale) return undefined

  // Лок остался от упавшего или закрытого процесса — снимаем и пробуем снова.
  await rm(path, { recursive: true, force: true }).catch(() => {})
  try {
    await take()
    return {
      path,
      async release() {
        await rm(path, { recursive: true, force: true }).catch(() => {})
      },
    }
  } catch {
    return undefined
  }
}
