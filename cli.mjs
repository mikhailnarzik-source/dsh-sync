#!/usr/bin/env node
/**
 * dsh-sync — переносимый между устройствами и ОС обмен сессиями DSH.
 *
 * Зеркало (git-репозиторий) хранит сессии с нейтральным путём
 * `/dsh-sync/projects/<id>`, устройство при приёме подставляет свой локальный
 * путь. Поэтому Windows, macOS и Linux совместимы между собой.
 *
 *   dsh-sync init --remote git@github.com:you/dsh-sessions.git
 *   dsh-sync project add dsh --path "C:\work\my-project"
 *   dsh-sync push
 *   dsh-sync pull
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { loadConfig, normalizeProjectId, resolveDshHome, saveConfig } from './lib/config.mjs'
import { listLocalSessions, listMirrorSessions, sessionsOfProject } from './lib/store.mjs'
import { pull, push } from './lib/sync.mjs'
import { ensureRepo, setRemote } from './lib/git.mjs'

const VALUE_FLAGS = new Set(['home', 'remote', 'repo', 'branch', 'path', 'title', 'project', 'backend'])

function parseArgs(argv) {
  const opts = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run' || arg === '--prune' || arg === '--no-prune' || arg === '--attachments') {
      opts[arg.slice(2)] = true
      continue
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      opts[key] = VALUE_FLAGS.has(key) ? argv[++i] : true
      continue
    }
    positional.push(arg)
  }
  return { command: positional[0], sub: positional[1], rest: positional.slice(2), opts }
}

function home(opts) {
  return resolveDshHome(opts.home)
}

async function cmdInit(opts) {
  const dshHome = home(opts)
  const config = await loadConfig(dshHome)
  if (opts.remote) config.remote = opts.remote
  if (opts.branch) config.branch = opts.branch
  if (opts.repo) config.repoDir = opts.repo
  if (opts.backend) {
    if (!['git', 'folder'].includes(opts.backend)) throw new Error('backend: git или folder')
    config.backend = opts.backend
  }
  if (opts.attachments) config.attachments = true
  if (config.backend !== 'folder') {
    await ensureRepo({ repoDir: config.repoDir, branch: config.branch })
    if (config.remote) await setRemote(config.repoDir, config.remote)
  }
  await saveConfig(dshHome, config)
  console.log(`конфиг:     ${join(dshHome, 'dsh-sync.json')}`)
  console.log(`бэкенд:     ${config.backend}`)
  console.log(`зеркало:    ${config.repoDir}`)
  console.log(`remote:     ${config.remote || '(не задан)'}`)
  console.log(`ветка:      ${config.branch}`)
  console.log(`устройство: ${config.deviceId}`)
  if (config.backend === 'folder') {
    console.log('\nпапка зеркала должна синхронизироваться внешним клиентом (OneDrive, Яндекс.Диск, Syncthing)')
  }
}

async function cmdProject(sub, rest, opts) {
  const dshHome = home(opts)
  const config = await loadConfig(dshHome)

  if (sub === 'add') {
    const id = normalizeProjectId(rest[0] ?? '')
    const path = opts.path
    if (!path) throw new Error('нужен --path <локальный путь проекта>')
    config.projects[id] = { path, title: opts.title ?? id }
    await saveConfig(dshHome, config)
    console.log(`проект ${id} → ${path}`)
    return
  }

  if (sub === 'remove') {
    const id = normalizeProjectId(rest[0] ?? '')
    delete config.projects[id]
    await saveConfig(dshHome, config)
    console.log(`проект ${id} удалён`)
    return
  }

  if (Object.keys(config.projects).length === 0) {
    console.log('проекты не настроены: dsh-sync project add <id> --path <путь>')
    return
  }
  console.log('проекты:')
  for (const [id, entry] of Object.entries(config.projects)) {
    console.log(`  ${id.padEnd(24)} ${entry.path}${entry.title && entry.title !== id ? `  (${entry.title})` : ''}`)
  }
}

async function cmdStatus(opts) {
  const dshHome = home(opts)
  const config = await loadConfig(dshHome)
  const local = await listLocalSessions(dshHome)
  console.log(`устройство: ${config.deviceId}`)
  console.log(`бэкенд:     ${config.backend ?? 'git'}`)
  console.log(`зеркало:    ${config.repoDir}${existsSync(config.repoDir) ? '' : ' (ещё не создано)'}`)
  console.log(`remote:     ${config.remote || '(не задан)'}`)
  console.log('')
  for (const [id, entry] of Object.entries(config.projects)) {
    const mine = sessionsOfProject(local, entry.path)
    const mirrored = existsSync(config.repoDir) ? await listMirrorSessions(config.repoDir, id) : []
    const localIds = new Set(mine.map(s => s.id))
    const mirrorIds = new Set(mirrored.map(s => s.id))
    const onlyLocal = mine.filter(s => !mirrorIds.has(s.id)).length
    const onlyMirror = mirrored.filter(s => !localIds.has(s.id)).length
    console.log(`${id}  (${entry.path})`)
    console.log(`  локально: ${mine.length}, в зеркале: ${mirrored.length}, только локально: ${onlyLocal}, только в зеркале: ${onlyMirror}`)
  }
}

async function main() {
  const { command, sub, rest, opts } = parseArgs(process.argv.slice(2))
  const dshHome = home(opts)

  if (command === 'init') return cmdInit(opts)
  if (command === 'project') return cmdProject(sub, rest, opts)

  if (command === 'push' || command === 'pull') {
    const config = await loadConfig(dshHome)
    if (Object.keys(config.projects).length === 0) throw new Error('проекты не настроены: dsh-sync project add <id> --path <путь>')
    if (command === 'push') {
      const result = await push({ home: dshHome, config, project: opts.project, prune: opts['no-prune'] ? false : true })
      console.log(`отправлено сессий: ${result.pushed}`)
      console.log(`удалено в зеркале: ${result.removed}`)
      if (result.attachments) {
        console.log(`вложений добавлено: ${result.attachments.added} (${(result.attachments.bytes / 1048576).toFixed(1)} MB)`)
      }
      console.log(`коммит: ${result.committed ? 'да' : 'нет изменений'}, push: ${result.pushedToRemote ? 'да' : 'нет'}`)
      return
    }
    const result = await pull({ home: dshHome, config, project: opts.project, dryRun: opts['dry-run'] === true })
    console.log(`импортировано: ${result.imported}`)
    console.log(`обновлено:     ${result.updated}`)
    console.log(`конфликтов:    ${result.conflicts}`)
    console.log(`без изменений: ${result.unchanged}, локально новее: ${result.ahead}, открыто: ${result.locked}`)
    if (result.attachments) console.log(`вложений восстановлено: ${result.attachments.restored}`)
    for (const fork of result.forkIds ?? []) console.log(`  fork: ${fork.from} → ${fork.to}`)
    if (result.unknownProjects.length > 0) {
      console.log(`\nв зеркале есть проекты, не настроенные здесь: ${result.unknownProjects.join(', ')}`)
      console.log('добавьте их: dsh-sync project add <id> --path <локальный путь>')
    }
    if (result.imported + result.updated + result.conflicts > 0 && !opts['dry-run']) {
      console.log('\nперезапустите DSH, чтобы новые сессии появились в списке')
    }
    return
  }

  if (command === 'status') return cmdStatus(opts)

  console.log('использование:')
  console.log('  dsh-sync init --backend git|folder --repo <каталог> [--remote <git-url>] [--branch main]')
  console.log('  dsh-sync project add <id> --path <локальный путь> [--title <название>]')
  console.log('  dsh-sync project list | remove <id>')
  console.log('  dsh-sync status')
  console.log('  dsh-sync push [--project <id>] [--no-prune]')
  console.log('  dsh-sync pull [--project <id>] [--dry-run]')
  console.log('')
  console.log('общие ключи: --home <каталог DSH> (по умолчанию $DSH_HOME или ~/.dsh)')
  console.log('')
  console.log('примеры:')
  console.log('  dsh-sync init --backend git --remote git@github.com:me/dsh-sessions.git')
  console.log('  dsh-sync init --backend folder --repo "C:\\Users\\me\\YandexDisk\\dsh-sync"')
  console.log('  dsh-sync project add myproject --path "C:\\work\\my-project"')
  process.exitCode = 2
}

main().catch((error) => {
  console.error(`ошибка: ${error.message}`)
  process.exitCode = 1
})
