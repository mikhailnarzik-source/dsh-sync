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
import { loadConfig, resolveDshHome } from './config.mjs'
import { pull, push } from './sync.mjs'

const action = ['sync', 'pull', 'push'].includes(process.argv[2]) ? process.argv[2] : 'sync'
const home = resolveDshHome(undefined)
const started = Date.now()

try {
  const config = await loadConfig(home)
  const messages = []
  const result = { pull: null, push: null }

  if (action !== 'push') {
    result.pull = await pull({ home, config })
    messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
    if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
  }

  if (action !== 'pull') {
    result.push = await push({ home, config })
    messages.push(`отправлено: ${result.push.pushed}${result.push.committed ? ', коммит создан' : ', изменений нет'}`)
    if (result.push.failures?.length) messages.push(`не прочитано: ${result.push.failures.length} (${result.push.failures[0].id}: ${result.push.failures[0].message})`)
    if (result.push.warning) messages.push(result.push.warning)
  }

  process.stdout.write(JSON.stringify({
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
  }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    action,
    mode: 'child',
    message: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
  }))
  process.exitCode = 1
}
