/**
 * push/pull: перенос сессий между локальным стором и git-зеркалом.
 *
 * Модель слияния опирается на append-only природу лога: хвост после заголовка
 * у обеих сторон начинается с общих байт, поэтому «один хвост — префикс
 * другого» означает, что одна сторона просто дописала события. Полное
 * расхождение (обе дописали своё) не склеивается: удалённая версия
 * импортируется отдельной сессией, локальная остаётся нетронутой.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { canonicalize, isLocked, listLocalSessions, listMirrorSessions, localSessionDir, mirrorLogPath, remapTo, sessionsOfProject, splitLog } from './store.mjs'
import { encodeSegment } from './format.mjs'
import { git } from './git.mjs'
import { createRemote } from './remote.mjs'
import { mergeDevice, readMeta, writeMeta } from './mirror-meta.mjs'
import { pullAttachments, pushAttachments } from './attachments.mjs'
import { markSynced, readLedger, writeLedger } from './ledger.mjs'
import { addTombstone, dropTombstone, readTombstones, writeTombstones } from './tombstones.mjs'
import { repairLog } from './repair.mjs'

function tailOf(bytes) {
  return splitLog(bytes).tail
}

/**
 * Отрезать недописанный хвост: DSH может дописывать сессию в момент чтения, и
 * незавершённый кадр нельзя отправлять другим устройствам — иначе они получат
 * обрезанную историю.
 */
export function sanitizeLog(bytes) {
  const { frameEnd, plain } = splitLog(bytes)
  const tail = bytes.subarray(frameEnd)
  if (tail.length === 0) return { bytes, dropped: 0 }

  if (plain) {
    const lastNewline = tail.lastIndexOf(0x0a)
    if (lastNewline === -1) return { bytes: bytes.subarray(0, frameEnd), dropped: tail.length }
    if (lastNewline === tail.length - 1) return { bytes, dropped: 0 }
    return { bytes: bytes.subarray(0, frameEnd + lastNewline + 1), dropped: tail.length - lastNewline - 1 }
  }

  let lastStart = -1
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail[i] === 0x28 && tail[i + 1] === 0xb5 && tail[i + 2] === 0x2f && tail[i + 3] === 0xfd) {
      lastStart = i
      break
    }
  }
  if (lastStart < 0) return { bytes, dropped: 0 }

  let complete = false
  try {
    complete = zstdDecompressSync(tail.subarray(lastStart)).length > 0
  } catch {
    complete = false
  }
  if (complete) return { bytes, dropped: 0 }
  return { bytes: bytes.subarray(0, frameEnd + lastStart), dropped: tail.length - lastStart }
}

/**
 * Совпадает ли лог по смыслу: заголовок (без учёта порядка ключей) и хвост.
 * Байты заголовка сравнивать нельзя: разные сборки Node сжимают один и тот же
 * JSON в разные zstd-кадры, и тогда каждый push создавал бы пустой коммит.
 */
function sameLog(a, b) {
  let left
  let right
  try {
    left = splitLog(a)
    right = splitLog(b)
  } catch {
    return false
  }
  if (!left.tail.equals(right.tail)) return false
  const normalize = (header) => JSON.stringify(Object.fromEntries(Object.keys(header).sort().map(key => [key, header[key]])))
  return normalize(left.header) === normalize(right.header)
}

function isPrefix(prefix, whole) {
  return whole.length >= prefix.length && whole.subarray(0, prefix.length).equals(prefix)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function dropCache(home, sessionId) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (existsSync(file)) await rm(file, { force: true })
}

async function backupLog(home, projectId, sessionId, bytes) {
  const dir = join(home, 'dsh-sync', 'backups', stamp())
  const target = join(dir, projectId, `${sessionId}.zstd`)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return target
}

function selectedProjects(config, filter) {
  const ids = Object.keys(config.projects)
  if (!filter) return ids.map(id => [id, config.projects[id]])
  if (!config.projects[filter]) throw new Error(`проект не настроен: ${filter} (см. project add)`)
  return [[filter, config.projects[filter]]]
}

/**
 * Какие сессии это устройство отправляло в прошлый раз. Нужен, чтобы удаление
 * распространялось только на «свои» сессии: чужие (ещё не притянутые) сессии
 * из зеркала нельзя удалять — устройство их просто не видело.
 */
async function readState(home) {
  const file = join(home, 'dsh-sync', 'state.json')
  if (!existsSync(file)) return { version: 1, projects: {} }
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed?.projects ? parsed : { version: 1, projects: {} }
  } catch {
    return { version: 1, projects: {} }
  }
}

async function writeState(home, state) {
  const dir = join(home, 'dsh-sync')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export async function push({ home, config, project, prune = true, message, sessions: provided }) {
  // Для git-бэкенда без адреса репозитория пушить некуда: лучше сказать об этом
  // прямо, чем падать на «origin does not appear to be a git repository».
  if (config.backend !== 'folder' && (config.remote ?? '').length === 0) {
    throw new Error('не задан адрес репозитория — укажите его в настройках плагина или нажмите «Создать репозиторий»')
  }
  const remote = await createRemote(config)
  await remote.sync()

  const local = provided === undefined ? await listLocalSessions(home) : []
  const state = await readState(home)
  const summary = { projects: [], pushed: 0, removed: 0, skipped: 0 }
  let meta = await readMeta(config.repoDir)
  const tombstones = await readTombstones(config.repoDir)
  let tombstonesDirty = false

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const sessions = provided ?? sessionsOfProject(local, entry.path)
    const current = new Set(sessions.map(session => session.id))
    const previous = new Set(state.projects[projectId] ?? [])

    for (const session of sessions) {
      try {
        const source = session.bytes
          ?? (session.path !== undefined
            ? await readFile(session.path)
            : await readFile(join(localSessionDir(home, entry.path, session.id), 'session.v4.jsonl.zstd')))
        const safe = sanitizeLog(source)
        if (safe.dropped > 0) {
          summary.truncated = (summary.truncated ?? 0) + 1
        }
        const canonical = canonicalize(safe.bytes, projectId)
        const target = mirrorLogPath(config.repoDir, projectId, session.id)
        await mkdir(dirname(target), { recursive: true })
        if (existsSync(target)) {
          // Уже лежит то же самое (возможно, сжатое другой сборкой Node) —
          // не перезаписываем, иначе каждый push делает пустой коммит.
          const existing = await readFile(target)
          if (sameLog(existing, canonical)) {
            summary.skipped += 1
            continue
          }
        }
        await writeFile(target, canonical)
        summary.pushed += 1
        // Сессия снова существует — её «надгробие» больше не нужно.
        if (dropTombstone(tombstones, session.id)) tombstonesDirty = true
      } catch (error) {
        // Один нечитаемый лог не должен останавливать остальные сессии.
        summary.failures ??= []
        summary.failures.push({
          id: session.id,
          path: session.path ?? '',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // Удаляем только те сессии, которые это устройство отправляло раньше и
    // которых больше нет локально. Чужие (из другого устройства) не трогаем.
    if (prune) {
      const root = join(home, 'sessions')
      if (sessions.length === 0 && previous.size > 0 && !existsSync(root)) {
        // Каталог сессий недоступен: это почти наверняка сломанный доступ,
        // а не «удалили всё» — удаление из зеркала пропускаем.
        summary.warning = 'каталог сессий недоступен — удаление из зеркала пропущено'
      } else {
        for (const sessionId of previous) {
          if (current.has(sessionId)) continue
          const dir = join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId))
          if (!existsSync(dir)) continue
          await rm(dir, { recursive: true, force: true })
          addTombstone(tombstones, sessionId, config.deviceId)
          tombstonesDirty = true
          summary.removed += 1
        }
      }
    }

    state.projects[projectId] = [...current]
    meta = mergeDevice(meta, {
      projectId,
      title: entry.title ?? projectId,
      deviceId: config.deviceId,
      path: entry.path,
    })
    summary.projects.push({ id: projectId, path: entry.path, sessions: sessions.length })

    // Отметить отправленное как синхронизированное (кроме тех, что не прочитались).
    const failedIds = new Set((summary.failures ?? []).map(failure => failure.id))
    const ledger = await readLedger(home)
    for (const session of sessions) {
      if (failedIds.has(session.id)) continue
      const path = session.path ?? join(localSessionDir(home, entry.path, session.id), 'session.v4.jsonl.zstd')
      try {
        markSynced(ledger, session.id, await stat(path))
      } catch {
        // файла нет — не отмечаем
      }
    }
    await writeLedger(home, ledger)
  }

  await writeMeta(config.repoDir, meta)
  await writeState(home, state)

  if (config.attachments) {
    const attachments = await pushAttachments({ home, repoDir: config.repoDir })
    summary.attachments = attachments
  }

  if ((summary.truncated ?? 0) > 0) {
    summary.warning = `недописанные хвосты обрезаны: ${summary.truncated}`
  }

  if (tombstonesDirty) await writeTombstones(config.repoDir, tombstones)

  const result = await remote.commit(message ?? `dsh-sync: push from ${config.deviceId} (${new Date().toISOString()})`)
  summary.committed = result.committed
  summary.pushedToRemote = result.pushed
  return summary
}

export async function pull({ home, config, project, dryRun = false }) {
  const remote = await createRemote(config)
  const fetched = await remote.sync()
  if (fetched === false && config.remote) {
    // Пустой репозиторий (ещё нет ветки) — это не ошибка: принимать нечего.
    const probe = await git(config.repoDir, ['ls-remote', '--heads', config.remote], { allowFailure: true })
    if (probe.code !== 0 || probe.stdout.trim() !== '') {
      throw new Error('не удалось получить удалённую ветку (проверьте remote и доступ)')
    }
  }

  const local = await listLocalSessions(home)
  const summary = { projects: [], imported: 0, updated: 0, conflicts: 0, unchanged: 0, ahead: 0, locked: 0, unknownProjects: [] }
  const meta = await readMeta(config.repoDir)
  const ledger = await readLedger(home)
  const tombstones = await readTombstones(config.repoDir)
  summary.mirrorProjects = Object.entries(meta.projects ?? {}).map(([id, info]) => ({ id, title: info?.title ?? id }))
  const configured = new Set(Object.keys(config.projects))
  const mirrorRoot = join(config.repoDir, 'sessions')
  const projectDirs = existsSync(mirrorRoot) ? await readdir(mirrorRoot, { withFileTypes: true }) : []
  for (const entry of projectDirs) {
    if (entry.isDirectory() && !configured.has(entry.name)) summary.unknownProjects.push(entry.name)
  }

  for (const [projectId, entry] of selectedProjects(config, project)) {
    const remoteSessions = await listMirrorSessions(config.repoDir, projectId)
    const stats = { id: projectId, path: entry.path, imported: 0, updated: 0, conflicts: 0, unchanged: 0, ahead: 0, locked: 0 }

    for (const remoteSession of remoteSessions) {
      try {
      const localDir = localSessionDir(home, entry.path, remoteSession.id)
      const localPath = join(localDir, 'session.v4.jsonl.zstd')
      const localBytes = existsSync(localPath) ? await readFile(localPath) : undefined

      if (isLocked(localDir)) {
        stats.locked += 1
        continue
      }

      const write = async (bytes) => {
        if (dryRun) return
        await mkdir(localDir, { recursive: true })
        await writeFile(localPath, bytes)
        await dropCache(home, remoteSession.id)
        try {
          markSynced(ledger, remoteSession.id, await stat(localPath))
        } catch {
          // не удалось отметить — не критично
        }
      }

      if (localBytes === undefined) {
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.imported += 1
        summary.importedIds ??= []
        summary.importedIds.push(remoteSession.id)
        continue
      }

      let localTail
      let remoteTail
      try {
        localTail = tailOf(localBytes)
        remoteTail = tailOf(remoteSession.bytes)
      } catch (error) {
        // Это не конфликт версий, а нечитаемый лог: показываем причину.
        summary.errors ??= []
        summary.errors.push({ id: remoteSession.id, message: error instanceof Error ? error.message : String(error) })
        continue
      }

      if (localTail.equals(remoteTail)) {
        stats.unchanged += 1
        continue
      }
      if (isPrefix(localTail, remoteTail)) {
        if (!dryRun) await backupLog(home, projectId, remoteSession.id, localBytes)
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.updated += 1
        continue
      }
      if (isPrefix(remoteTail, localTail)) {
        stats.ahead += 1
        continue
      }

      // Расхождение: обе стороны дописали разное. Локальная остаётся, удалённая
      // приезжает отдельной сессией с новым id — ничего не теряется.
      const forkId = `session-${randomUUID()}`
      const forkDir = localSessionDir(home, entry.path, forkId)
      if (!dryRun) {
        await mkdir(forkDir, { recursive: true })
        const forkBytes = remapTo(remoteSession.bytes, entry.path, { id: forkId })
        // Копия получает новый id: события внутри должны называть его же, иначе DSH
        // сочтёт лог повреждённым.
        await writeFile(join(forkDir, 'session.v4.jsonl.zstd'), repairLog(forkBytes).bytes)
        try {
          markSynced(ledger, forkId, await stat(join(forkDir, 'session.v4.jsonl.zstd')))
        } catch {
          // отметка необязательна
        }
      }
      stats.conflicts += 1
      summary.conflictDetails ??= []
      summary.conflictDetails.push({ id: remoteSession.id, localTail: localTail.length, remoteTail: remoteTail.length })
      summary.forkIds ??= []
      summary.forkIds.push({ from: remoteSession.id, to: forkId })
      } catch (error) {
        // Любая ошибка по одной сессии не останавливает обработку остальных.
        summary.errors ??= []
        summary.errors.push({ id: remoteSession.id, message: error instanceof Error ? error.message : String(error) })
      }
    }

    // Удаления с других устройств: локальную копию переносим в архив и убираем
    // из списка сессий. Данные не исчезают — их можно восстановить вручную.
    if (!dryRun) {
      for (const sessionId of Object.keys(tombstones.sessions)) {
        const dir = localSessionDir(home, entry.path, sessionId)
        if (!existsSync(dir)) continue
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backup = join(home, 'dsh-sync', 'deleted', stamp, encodeSegment(sessionId))
        try {
          await mkdir(dirname(backup), { recursive: true })
          await rename(dir, backup)
        } catch {
          await rm(dir, { recursive: true, force: true })
        }
        delete ledger.sessions[sessionId]
        summary.deleted = (summary.deleted ?? 0) + 1
        summary.deletedIds ??= []
        summary.deletedIds.push(sessionId)
      }
    }

    summary.imported += stats.imported
    summary.updated += stats.updated
    summary.conflicts += stats.conflicts
    summary.unchanged += stats.unchanged
    summary.ahead += stats.ahead
    summary.locked += stats.locked
    summary.projects.push(stats)
  }

  if (config.attachments) {
    summary.attachments = await pullAttachments({ home, repoDir: config.repoDir })
  }

  await writeLedger(home, ledger)
  return summary
}
