/**
 * push/pull: перенос сессий между локальным стором и git-зеркалом.
 *
 * Модель слияния опирается на append-only природу лога: хвост после заголовка
 * у обеих сторон начинается с общих байт, поэтому «один хвост — префикс
 * другого» означает, что одна сторона просто дописала события. Полное
 * расхождение (обе дописали своё) не склеивается: удалённая версия
 * импортируется отдельной сессией, локальная остаётся нетронутой.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalize, isLocked, listLocalSessions, listMirrorSessions, localSessionDir, mirrorLogPath, remapTo, sessionsOfProject, splitLog } from './store.mjs'
import { encodeSegment } from './format.mjs'
import { git } from './git.mjs'
import { createRemote } from './remote.mjs'
import { mergeDevice, readMeta, writeMeta } from './mirror-meta.mjs'
import { pullAttachments, pushAttachments } from './attachments.mjs'

function tailOf(bytes) {
  return splitLog(bytes).tail
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
        const canonical = canonicalize(source, projectId)
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
      if (sessions.length === 0 && previous.size > 0) {
        // Скан не увидел ни одной сессии, хотя раньше их было много: почти
        // наверняка сломан доступ к стору, а не «удалили всё».
        summary.warning = 'локальные сессии не найдены — удаление из зеркала пропущено'
      } else {
        for (const sessionId of previous) {
          if (current.has(sessionId)) continue
          const dir = join(config.repoDir, 'sessions', projectId, encodeSegment(sessionId))
          if (!existsSync(dir)) continue
          await rm(dir, { recursive: true, force: true })
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
  }

  await writeMeta(config.repoDir, meta)
  await writeState(home, state)

  if (config.attachments) {
    const attachments = await pushAttachments({ home, repoDir: config.repoDir })
    summary.attachments = attachments
  }

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
      }

      if (localBytes === undefined) {
        await write(remapTo(remoteSession.bytes, entry.path))
        stats.imported += 1
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
        await writeFile(join(forkDir, 'session.v4.jsonl.zstd'), remapTo(remoteSession.bytes, entry.path, { id: forkId }))
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

  return summary
}
