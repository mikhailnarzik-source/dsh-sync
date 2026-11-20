#!/usr/bin/env node
/**
 * Синхронизация в отдельном процессе: host-процесс DSH может отличаться от
 * обычного Node (другая сборка zlib, ограничения файловой системы), а движку
 * нужны и чтение сторов, и zstd. Дочерний процесс запускается на штатном Node
 * и печатает результат одной JSON-строкой.
 *
 * Использование: node sync-child.mjs <sync|pull|push>
 * Каталог DSH берётся из $DSH_HOME (или ~/.dsh), как у CLI.
 */
import { join } from 'node:path'
import { loadConfig, resolveDshHome } from './config.mjs'
import { pullReplicated, pushReplicated } from './replica.mjs'
import { acquireLock } from './lock.mjs'
import { recordRun } from './history.mjs'

const action = ['sync', 'pull', 'push'].includes(process.argv[2]) ? process.argv[2] : 'sync'
const home = resolveDshHome(undefined)
const started = Date.now()

const lock = await acquireLock(join(home, 'dsh-sync'), `child:${action}`)
if (lock === undefined) {
  // Другая синхронизация уже идёт: это не ошибка, просто пропускаем такт.
  process.stdout.write(JSON.stringify({
    ok: true,
    skipped: true,
    action,
    mode: 'child',
    message: 'синхронизация уже выполняется другим процессом',
    durationMs: Date.now() - started,
  }))
  process.exit(0)
}

try {
  const config = await loadConfig(home)
  const messages = []
  const result = { pull: null, push: null }

  if (action !== 'push') {
    result.pull = await pullReplicated({ home, config })
    messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
    if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
    if ((result.pull.deleted ?? 0) > 0) messages.push(`удалено по отметкам других устройств: ${result.pull.deleted}`)
  }

  if (action !== 'pull') {
    result.push = await pushReplicated({ home, config })
    messages.push(`отправлено: ${result.push.pushed}${result.push.committed ? ', коммит создан' : ', изменений нет'}`)
    if (result.push.failures?.length) messages.push(`не прочитано: ${result.push.failures.length} (${result.push.failures[0].id}: ${result.push.failures[0].message})`)
    if (result.push.warning) messages.push(result.push.warning)
    if (result.push.secondary !== undefined) {
      messages.push(`дубль: отправлено ${result.push.secondary.pushed}`)
    } else if (result.push.secondaryError !== undefined) {
      messages.push(`дубль недоступен: ${result.push.secondaryError}`)
    }
  }

  const record = {
    ok: true,
    action,
    mode: 'child',
    message: messages.join('; '),
    durationMs: Date.now() - started,
    pull: result.pull
      ? {
          imported: result.pull.imported,
          updated: result.pull.updated,
          conflicts: result.pull.conflicts,
          attachments: result.pull.attachments?.restored ?? 0,
          errors: result.pull.errors?.length ?? 0,
          deleted: result.pull.deleted ?? 0,
          deletedIds: result.pull.deletedIds ?? [],
        }
      : null,
    push: result.push
      ? {
          pushed: result.push.pushed,
          committed: result.push.committed,
          attachments: result.push.attachments?.added ?? 0,
          failures: result.push.failures?.length ?? 0,
        }
      : null,
  }
  await recordRun(home, { ...record, at: new Date().toISOString() })
  process.stdout.write(JSON.stringify(record))
} catch (error) {
  const record = {
    ok: false,
    action,
    mode: 'child',
    message: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
    at: new Date().toISOString(),
  }
  await recordRun(home, record)
  process.stdout.write(JSON.stringify(record))
  process.exitCode = 1
} finally {
  await lock.release()
}
