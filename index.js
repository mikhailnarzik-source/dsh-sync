/**
 * Host half of `dsh-sync`: проверка окружения, настройки и запуск синхронизации
 * из интерфейса DSH.
 *
 * Плагин работает поверх готового движка из `lib/` (тот же, что у CLI):
 * карточка в настройках читает состояние через `ctx.connection.fetch`,
 * сохраняет параметры в `~/.dsh/dsh-sync.json` и запускает `pull`/`push`.
 * Токены нигде не хранятся: git использует штатный credential helper.
 */import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { readFile as readFileText } from 'node:fs/promises'

import { defaultConfig, loadConfig, saveConfig } from './lib/config.mjs'
import { encodeSegment, projectKey, samePath } from './lib/format.mjs'
import { collectDiagnostics } from './lib/diagnostics.mjs'
import { readHistory, recordRun } from './lib/history.mjs'
import { readLedger, sessionState } from './lib/ledger.mjs'
import { matchProjectPath } from './lib/mirror-meta.mjs'
import { listLocalSessions, listMirrorSessions, sessionsOfProject } from './lib/store.mjs'
import { pull, push } from './lib/sync.mjs'
import { applyUpdate, checkForUpdate, describeUpdate, updateState } from './lib/update.js'

export const name = 'dsh-sync'
// sessionPersistence даёт список сессий с путями к логам: обходим каталог
// приходится только как запасной вариант.
export const inject = ['connection', 'tools', 'sessionPersistence']

const STATE_PATH = '/api/dsh-sync/state'
const CONFIG_PATH = '/api/dsh-sync/config'
const RUN_PATH = '/api/dsh-sync/run'
const CREATE_REPO_PATH = '/api/dsh-sync/create-repo'
const DIAG_PATH = '/api/dsh-sync/diagnostics'
const SESSIONS_PATH = '/api/dsh-sync/sessions'
const NOTIFICATIONS_PATH = '/api/dsh-sync/notifications'

// --- уведомления -----------------------------------------------------------
// Кольцевой буфер: клиент забирает всё, что появилось после его курсора, и
// показывает всплывающие карточки. Так ошибки и обновления видно без захода
// в карточку плагина.
const NOTICE_LIMIT = 50
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const notices = []
let noticeSeq = 0
let announcedVersion = null
const noticeDedupe = new Map()

/** Токен GitHub из хранилища DSH — для проверки обновлений. */
async function resolveGitHubToken(ctx) {
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.('GITHUB_TOKEN')
    return typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  } catch {
    return undefined
  }
}

function pushNotice(kind, text) {
  const key = `${kind}:${text}`
  const last = noticeDedupe.get(key) ?? 0
  if (Date.now() - last < 10 * 60_000) return
  noticeDedupe.set(key, Date.now())
  noticeSeq += 1
  notices.push({ id: noticeSeq, at: Date.now(), kind, text })
  if (notices.length > NOTICE_LIMIT) notices.shift()
}
const UPDATE_PATH = '/api/dsh-sync/update'
const UPDATE_APPLY_PATH = '/api/dsh-sync/update/apply'

/** Инструменты возвращают текст: DSH требует явное описание вывода. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const LAST_RUN_FILE = 'last-run.json'
const PLUGIN_STATUS_FILE = 'plugin-status.json'

/** Состояние фоновой синхронизации (в памяти процесса). */
const automation = {
  enabled: false,
  running: false,
  lastPullAt: 0,
  lastPushAt: 0,
  lastTickAt: 0,
  lastError: '',
  fingerprint: '',
  lastPullOk: true,
  lastPushOk: true,
  timer: null,
}

/** Кеш сетевого опроса зеркала (ls-remote дорогой). */
const REMOTE_PROBE_TTL_MS = 60_000
let remoteProbe = null

/** Известные сторонние плагины синхронизации сессий (проверяются в профиле). */
const KNOWN_SYNC_PLUGINS = [
  'dsh-session-sync',
  '@perrylink/dsh-session-sync',
  'dsh-cloud-sync',
  'dsh-sessions-sync',
]

/** Имена сервисов, через которые сторонний плагин может отдавать API. */
const EXTERNAL_SERVICES = ['session-sync', 'dsh-session-sync', 'sessionSync']

function looksLikeSyncPackage(name) {
  const lower = String(name).toLowerCase()
  if (lower === 'dsh-sync') return false
  if (KNOWN_SYNC_PLUGINS.includes(lower)) return true
  return /(session|sessions)[-_]?sync/.test(lower) && !/^@deepseek-ai\//.test(lower)
}

function looksLikeSyncService(value) {
  return value !== null
    && typeof value === 'object'
    && (typeof value.push === 'function' || typeof value.pull === 'function' || typeof value.sync === 'function')
}

/**
 * Найти установленный сторонний плагин синхронизации.
 *
 * Сначала ищем живой сервис в cordis (тогда синхронизацию можно провести через
 * него), затем — запись в профиле: установлен ли пакет и задан ли у него
 * репозиторий. Код стороннего плагина не вызывается, если он не опубликовал
 * сервис с методами pull/push/sync.
 */
async function discoverExternal(ctx) {
  for (const name of EXTERNAL_SERVICES) {
    let service
    try {
      service = ctx?.get?.(name)
    } catch {
      service = undefined
    }
    if (looksLikeSyncService(service)) {
      return {
        found: true,
        callable: true,
        name,
        source: 'service',
        configured: true,
        methods: ['push', 'pull', 'sync'].filter(method => typeof service[method] === 'function'),
        service,
      }
    }
  }

  const profilesRoot = join(dshHome(), 'profiles')
  let profiles = []
  try {
    profiles = await (await import('node:fs/promises')).readdir(profilesRoot, { withFileTypes: true })
  } catch {
    profiles = []
  }

  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    const dir = join(profilesRoot, entry.name)
    let manifest
    try {
      manifest = JSON.parse(await readFileText(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const dependencies = Object.keys(manifest?.dependencies ?? {})
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const installed = [...new Set([...dependencies, ...bundles])]
      .filter(packageName => looksLikeSyncPackage(packageName))

    for (const name of installed) {
      let configured = false
      try {
        const patch = await readFileText(join(dir, 'cordis.patch.yml'), 'utf8')
        const block = patch.split(/\n(?=- insert:)/).find(part => part.includes(name))
        configured = block !== undefined && /\n\s+remote:\s*\S+/.test(block)
      } catch {
        configured = false
      }
      return { found: true, callable: false, name, source: `profile:${entry.name}`, configured, methods: [] }
    }
  }

  return { found: false, callable: false, name: null, source: null, configured: false, methods: [] }
}

/** DSH home: та же папка, что использует CLI. */
function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') return process.env.DSH_HOME.trim()
  return join(homedir(), '.dsh')
}

/**
 * Запуск команды с захватом вывода через временные файлы: так одинаково
 * работает и в обычном процессе, и под ограничениями, где нельзя открыть pipe.
 */
async function runCapture(command, args, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-env-'))
  const outPath = join(dir, 'out')
  const errPath = join(dir, 'err')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  try {
    const code = await new Promise((resolvePromise) => {
      const child = spawn(command, args, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...options.env },
        stdio: ['ignore', out.fd, err.fd],
        windowsHide: true,
      })
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            try {
              child.kill()
            } catch {
              // уже завершился
            }
            resolvePromise({ code: -2, message: 'timeout' })
          }, options.timeoutMs)
      child.on('error', (error) => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise({ code: -1, message: String(error.message) })
      })
      child.on('close', (exitCode) => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise({ code: exitCode })
      })
    })
    const [stdout, stderr] = await Promise.all([readFileText(outPath, 'utf8'), readFileText(errPath, 'utf8')])
    return { code: code.code, stdout, stderr: code.message ?? stderr }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Проверка окружения: node, git, remote, путь проекта. */
async function checkEnvironment(config) {
  const checks = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const nodeMinor = Number(process.versions.node.split('.')[1] ?? 0)
  checks.push({
    id: 'node',
    title: 'Node.js',
    ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 15),
    detail: `v${process.versions.node}`,
    hint: 'Нужен Node.js 22.15 или новее. В DSH уже есть встроенный рантайм — обновите приложение.',
  })

  const gitVersion = await runCapture('git', ['--version'])
  const gitOk = gitVersion.code === 0
  checks.push({
    id: 'git',
    title: 'git',
    ok: gitOk,
    detail: gitOk ? gitVersion.stdout.trim().replace(/^git version\s*/, '') : 'не найден',
    hint: 'Установите Git for Windows (git-scm.com) — без него зеркало не обновить.',
  })

  const projectPath = config?.projects?.[Object.keys(config?.projects ?? {})[0]]?.path
  const projectOk = typeof projectPath === 'string' && projectPath.length > 0 && existsSync(projectPath)
  checks.push({
    id: 'project',
    title: 'Папка проекта',
    ok: projectOk,
    detail: projectPath ?? 'не указана',
    hint: 'Укажите путь к проекту ниже — папка должна существовать.',
  })

  const remote = config?.remote ?? ''
  if (remote.length > 0 && gitOk) {
    // Сетевой опрос кешируем: карточка перерисовывается часто, а ls-remote
    // занимает секунды.
    const cached = remoteProbe
    const fresh = cached !== null && cached.remote === remote && Date.now() - cached.at < REMOTE_PROBE_TTL_MS
    const reachable = fresh ? cached.ok : (await runCapture('git', ['ls-remote', '--heads', remote])).code === 0
    if (!fresh) remoteProbe = { remote, at: Date.now(), ok: reachable }
    checks.push({
      id: 'remote',
      title: 'Репозиторий зеркала',
      ok: reachable,
      detail: reachable ? 'доступен' : 'нет доступа',
      hint: 'Проверьте адрес и войдите в GitHub один раз в терминале: git ls-remote <адрес>',
    })
  } else {
    checks.push({
      id: 'remote',
      title: 'Репозиторий зеркала',
      ok: false,
      detail: remote.length === 0 ? 'не задан' : 'проверка недоступна без git',
      hint: 'Укажите https-адрес приватного репозитория для сессий.',
    })
  }

  return checks
}

/** Текущее состояние: окружение, настройки, счётчики и последний запуск. */
async function readState(ctx) {
  const home = dshHome()
  let config
  try {
    config = await loadConfig(home)
  } catch (error) {
    return {
      ok: false,
      message: `Не удалось прочитать конфигурацию: ${error instanceof Error ? error.message : String(error)}`,
      checks: [],
      config: null,
      status: null,
    }
  }

  const projectEntries = Object.entries(config.projects ?? {})
  const [projectId, project] = projectEntries[0] ?? [undefined, undefined]
  const checks = await checkEnvironment(config)

  let local = 0
  let mirror = 0
  let onlyLocal = 0
  let onlyMirror = 0
  let scanned = 0
  let scanError = ''
  const cwds = new Set()

  const located = await localSessionsFor(ctx, home, project?.path ?? '')
  scanned = located.total
  scanError = located.error
  for (const session of located.sessions) cwds.add(session.cwd)

  try {
    const mine = located.sessions
    local = mine.length
    if (projectId && existsSync(config.repoDir)) {
      const mirrored = await listMirrorSessions(config.repoDir, projectId)
      mirror = mirrored.length
      const localIds = new Set(mine.map(session => session.id))
      const mirrorIds = new Set(mirrored.map(session => session.id))
      onlyLocal = mine.filter(session => !mirrorIds.has(session.id)).length
      onlyMirror = mirrored.filter(session => !localIds.has(session.id)).length
    }
  } catch {
    // счётчики — вспомогательная информация, карточка работает и без них
  }

  let lastRun = null
  try {
    lastRun = JSON.parse(await readFile(join(home, 'dsh-sync', LAST_RUN_FILE), 'utf8'))
  } catch {
    lastRun = null
  }
  const history = await readHistory(home, 5)

  const external = await discoverExternal(ctx)
  const preferExternal = config.useExternal !== false
  const mode = external.found && external.callable && preferExternal ? 'external' : 'builtin'

  const currentFingerprint = await computeFingerprint(ctx)
  const pending = automation.fingerprint !== '' && currentFingerprint !== '' && currentFingerprint !== automation.fingerprint

  // Диагностика расхождения счётчиков: если локальных сессий не видно, а в
  // зеркале они есть, сохраняем, что именно просканировано.
  if (local === 0 && mirror > 0) {
    void writeStatus({ debug: { home, sessionsScanned: scanned, cwds: [...cwds], projectPath: project?.path ?? '' } })
  }

  return {
    ok: true,
    deviceId: config.deviceId,
    mode,
    preferExternal,
    external: {
      found: external.found,
      callable: external.callable,
      name: external.name,
      source: external.source,
      configured: external.configured,
      methods: external.methods,
    },
    config: {
      remote: config.remote ?? '',
      backend: config.backend ?? 'git',
      branch: config.branch ?? 'main',
      repoDir: config.repoDir,
      attachments: config.attachments === true,
      useExternal: config.useExternal !== false,
      projectId: projectId ?? '',
      projectPath: project?.path ?? '',
    },
    checks,
    ready: checks.every(check => check.ok),
    status: { local, mirror, onlyLocal, onlyMirror },
    pending,
    history,
    automation: {
      enabled: automation.enabled,
      running: automation.running,
      lastPullAt: automation.lastPullAt === 0 ? null : new Date(automation.lastPullAt).toISOString(),
      lastPushAt: automation.lastPushAt === 0 ? null : new Date(automation.lastPushAt).toISOString(),
      lastError: automation.lastError,
      settings: config.autoSync ?? {},
    },
    debug: { home, sessionsScanned: scanned, cwds: [...cwds], projectPath: project?.path ?? '', scanError, source: located.source },
    lastRun,
  }
}

/**
 * Сессии проекта так, как их видит сам DSH: через `sessionPersistence`, который
 * отдаёт и заголовок, и путь к логу. Обход каталога — запасной путь: в
 * host-процессе `readdir` может быть недоступен, а чтение известного файла — нет.
 */
async function localSessionsFor(ctx, home, projectPath) {
  const persistence = ctx?.get?.('sessionPersistence')
  if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      const sessions = []
      let total = 0
      for (const snapshot of snapshots ?? []) {
        const header = snapshot?.header
        const path = snapshot?.location?.path
        if (header === null || header === undefined || typeof header.id !== 'string' || typeof header.cwd !== 'string') continue
        total += 1
        if (typeof path !== 'string') continue
        if (projectPath === '' || !samePath(header.cwd, projectPath)) continue
        sessions.push({ id: header.id, cwd: header.cwd, path, parent: header.parentSession ?? '' })
      }
      return { sessions, total, source: 'persistence', error: '' }
    } catch (error) {
      // падаем в следующий источник
    }
  }

  // Второй источник: реестр workspace — он знает id сессий каждого проекта,
  // а путь к логу вычисляется из id без чтения каталога.
  const registry = ctx?.get?.('workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    try {
      const sessions = []
      for (const workspace of registry.list() ?? []) {
        const workspacePath = workspace?.path ?? workspace?.record?.path
        if (typeof workspacePath !== 'string' || (projectPath !== '' && !samePath(workspacePath, projectPath))) continue
        for (const id of workspace?.sessionIds ?? []) {
          if (typeof id !== 'string') continue
          sessions.push({
            id,
            cwd: workspacePath,
            path: join(home, 'sessions', projectKey(workspacePath), encodeSegment(id), 'session.v4.jsonl.zstd'),
          })
        }
      }
      if (sessions.length > 0) return { sessions, total: sessions.length, source: 'registry', error: '' }
    } catch {
      // падаем в файловый обход
    }
  }

  {
    const fsSessions = await listLocalSessions(home).catch(() => [])
    return {
      sessions: projectPath === '' ? fsSessions : sessionsOfProject(fsSessions, projectPath),
      total: fsSessions.length,
      source: 'fs',
      error: '',
    }
  }
}

/** Сохранить параметры, введённые в карточке. */
async function saveSettings(ctx, payload) {
  const home = dshHome()
  const config = existsSync(join(home, 'dsh-sync.json'))
    ? await loadConfig(home)
    : { ...defaultConfig(home) }

  const remote = typeof payload.remote === 'string' ? payload.remote.trim() : config.remote
  const folder = typeof payload.repoDir === 'string' ? payload.repoDir.trim() : config.repoDir
  const projectIdRaw = typeof payload.projectId === 'string' ? payload.projectId.trim() : ''
  const projectPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : ''
  const projectId = (projectIdRaw || 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  config.backend = payload.backend === 'folder' ? 'folder' : 'git'
  if (config.backend === 'folder') {
    if (folder !== '') config.repoDir = folder
  } else if (remote !== '') {
    config.remote = remote
  }
  config.attachments = payload.attachments === true
  config.autoUpdate = payload.autoUpdate === true
  if (typeof payload.useExternal === 'boolean') config.useExternal = payload.useExternal
  config.projects = { [projectId]: { path: projectPath, title: projectId } }
  await saveConfig(home, config)
  return readState(ctx)
}

/** Node с рабочим zstd: host-процесс DSH может быть собран иначе. */
let cachedNode

async function resolveNodeWithZstd() {
  if (cachedNode !== undefined) return cachedNode
  const probeCode = "process.exit(typeof require('node:zlib').zstdDecompressSync==='function'?0:1)"
  const candidates = []

  if (process.env.DSH_SYNC_NODE) candidates.push({ path: process.env.DSH_SYNC_NODE, env: {} })

  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources.length > 0) {
    candidates.push({ path: join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'), env: {} })
    candidates.push({ path: join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node'), env: {} })
  }

  // Запасной путь к встроенному рантайму, если resourcesPath недоступен.
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) {
    candidates.push({
      path: join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
      env: {},
    })
  }

  candidates.push({ path: 'node', env: {} })
  // Electron в режиме Node: свой исполняемый файл запускается как Node.
  candidates.push({ path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })

  for (const candidate of candidates) {
    const probe = await runCapture(candidate.path, ['-e', probeCode], { env: candidate.env, timeoutMs: 15_000 })
    if (probe.code === 0) {
      cachedNode = candidate
      return candidate
    }
  }
  cachedNode = null
  return null
}

/**
 * Выполнить синхронизацию в отдельном процессе на штатном Node: там доступны и
 * полный файловый обход, и zstd. Возвращает undefined, если подходящего Node нет.
 */
async function runViaChild(action) {
  const node = await resolveNodeWithZstd()
  if (node === null) return undefined
  const childPath = fileURLToPath(new URL('./lib/sync-child.mjs', import.meta.url))

  const started = Date.now()
  const result = await runCapture(node.path, [childPath, action], { env: node.env, timeoutMs: 600_000 })
  const line = result.stdout.trim().split('\n').filter(part => part.trim().startsWith('{')).pop()

  let parsed
  try {
    parsed = line === undefined ? undefined : JSON.parse(line)
  } catch {
    parsed = undefined
  }

  if (parsed === undefined) {
    const record = {
      ok: false,
      at: new Date().toISOString(),
      action,
      mode: 'child',
      message: `дочерний процесс не ответил (код ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
      durationMs: Date.now() - started,
    }
    await writeLastRun(record)
    pushNotice('error', `Синхронизация не удалась: ${record.message}`)
    return record
  }

  const record = { ...parsed, at: new Date().toISOString(), nodePath: node.path, durationMs: parsed.durationMs ?? Date.now() - started }
  await writeLastRun(record)
  if (record.ok !== true) {
    pushNotice('error', `Синхронизация не удалась: ${record.message}`)
  } else if ((record.pull?.imported ?? 0) > 0) {
    pushNotice('sync', `Принято новых сессий: ${record.pull.imported}. Откройте DSH заново, чтобы увидеть их в списке.`)
  }
  return record
}

/** Запустить синхронизацию: pull → push (или что-то одно). */
async function runSync(ctx, action) {
  const home = dshHome()
  const config = await loadConfig(home)
  const projectEntries = Object.keys(config.projects ?? {})
  if (projectEntries.length === 0) {
    return { ok: false, message: 'Сначала укажите проект в настройках плагина.' }
  }

  const external = await discoverExternal(ctx)
  if (external.found && external.callable && config.useExternal !== false) {
    return runViaExternal(external, action)
  }

  // Основной путь — отдельный процесс: в host-процессе DSH файловый обход и
  // разбор логов могут вести себя иначе, чем в обычном Node.
  const viaChild = await runViaChild(action)
  if (viaChild !== undefined) {
    // Приём выполняет дочерний процесс, а привязать новые сессии к рабочему
    // пространству может только host-часть: у неё есть реестр.
    if (action !== 'push' && viaChild.ok === true) {
      try {
        const attached = await attachAllProjects(ctx, config)
        if (attached > 0) {
          viaChild.message = `${viaChild.message}; привязано к рабочему пространству: ${attached}`
          await writeLastRun({ ...viaChild })
        }
        const deletedIds = viaChild.pull?.deletedIds ?? []
        if (deletedIds.length > 0) {
          const detached = await detachSessions(ctx, deletedIds)
          viaChild.message = `${viaChild.message}; убрано из пространств: ${detached}`
          await writeLastRun({ ...viaChild })
        }
      } catch {
        // привязка — вспомогательный шаг, синхронизация уже прошла
      }
    }
    return viaChild
  }

  const started = Date.now()
  const result = { pull: null, push: null }
  const messages = []
  try {
    if (action !== 'push') {
      result.pull = await pull({ home, config })
      messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
      if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)

      // В зеркале могут быть проекты, которых здесь ещё нет: подхватываем по имени.
      const adopted = await adoptMirrorProjects(ctx, config, result.pull)
      if (adopted > 0) {
        result.pull = await pull({ home, config })
        messages.push(`подхвачено проектов из зеркала: ${adopted}; принято: ${result.pull.imported}`)
        if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
      }

      // Привязать к рабочему пространству и импортированное, и то, что уже
      // лежало на диске после прошлых синхронизаций.
      const attached = await attachAllProjects(ctx, config)
      if (attached > 0) messages.push(`привязано к рабочему пространству: ${attached}`)
      const deletedIds = result.pull?.deletedIds ?? []
      if (deletedIds.length > 0) {
        const detached = await detachSessions(ctx, deletedIds)
        messages.push(`удалено по отметкам других устройств: ${deletedIds.length}; убрано из пространств: ${detached}`)
      }
    }
    if (action !== 'pull') {
      const entry = Object.values(config.projects ?? {})[0]
      const located = await localSessionsFor(ctx, home, entry?.path ?? '')
      result.push = await push({ home, config, sessions: located.sessions })
      messages.push(`отправлено: ${result.push.pushed}${result.push.committed ? ', коммит создан' : ', изменений нет'}`)
      if (result.push.failures?.length) {
        const first = result.push.failures[0]
        messages.push(`не прочитано: ${result.push.failures.length} (${first.id}: ${first.message})`)
      }
      if (result.push.warning) messages.push(result.push.warning)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const record = { ok: false, at: new Date().toISOString(), action, mode: 'builtin', message, durationMs: Date.now() - started }
    await writeLastRun(record)
    pushNotice('error', `Синхронизация не удалась: ${message}`)
    return record
  }

  const record = {
    ok: true,
    at: new Date().toISOString(),
    action,
    mode: 'host',
    message: `дочерний Node не найден, работал host-процесс. ${messages.join('; ')}`,
    durationMs: Date.now() - started,
    pull: result.pull
      ? { imported: result.pull.imported, updated: result.pull.updated, conflicts: result.pull.conflicts, attachments: result.pull.attachments?.restored ?? 0 }
      : null,
    push: result.push
      ? { pushed: result.push.pushed, committed: result.push.committed, attachments: result.push.attachments?.added ?? 0 }
      : null,
  }
  await writeLastRun(record)
  return record
}

/**
 * Синхронизация через сторонний плагин: вызываем только опубликованные им
 * методы и не заглядываем внутрь. Ошибки внешнего плагина не роняют карточку —
 * они попадают в отчёт.
 */
async function runViaExternal(external, action) {
  const service = external.service
  const started = Date.now()
  const calls = []
  try {
    if (action !== 'push' && typeof service.pull === 'function') {
      await service.pull()
      calls.push('pull')
    }
    if (action !== 'pull' && typeof service.push === 'function') {
      await service.push()
      calls.push('push')
    }
    if (calls.length === 0 && typeof service.sync === 'function') {
      await service.sync()
      calls.push('sync')
    }
    const record = {
      ok: true,
      at: new Date().toISOString(),
      action,
      mode: 'external',
      external: external.name,
      message: `синхронизация выполнена через ${external.name} (${calls.join(' + ')})`,
      durationMs: Date.now() - started,
      pull: null,
      push: null,
    }
    await writeLastRun(record)
    return record
  } catch (error) {
    const record = {
      ok: false,
      at: new Date().toISOString(),
      action,
      mode: 'external',
      external: external.name,
      message: `внешний плагин ${external.name} вернул ошибку: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - started,
    }
    await writeLastRun(record)
    return record
  }
}

async function writeLastRun(record) {
  await recordRun(dshHome(), record)
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function body(request) {
  try {
    return (await request.json()) ?? {}
  } catch {
    return {}
  }
}

/**
 * Отпечаток локального стора: меняется, когда в сессиях появляются события.
 * Берётся у сервиса сессий, поэтому не зависит от доступа к каталогу.
 */
async function computeFingerprint(ctx) {
  const persistence = ctx?.get?.('sessionPersistence')
  if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') return ''
  try {
    const list = await persistence.list()
    return (list ?? [])
      .map(snapshot => `${snapshot?.header?.id ?? '?'}:${snapshot?.sizeBytes ?? 0}`)
      .sort()
      .join('|')
  } catch {
    return ''
  }
}

/**
 * Один такт фоновой синхронизации: приём по расписанию и отправка при
 * изменениях, но не чаще заданного окна.
 */
async function autoTick(ctx) {
  if (automation.running) return
  automation.lastTickAt = Date.now()

  const home = dshHome()
  let config
  try {
    config = await loadConfig(home)
  } catch {
    return
  }
  const options = config.autoSync ?? {}
  if (options.enabled === false || Object.keys(config.projects ?? {}).length === 0) return

  automation.running = true
  try {
    const now = Date.now()
    const pullEvery = Math.max(60_000, (options.pullIntervalMinutes ?? 15) * 60_000)
    const pushEvery = Math.max(0, (options.pushMinIntervalMinutes ?? 5) * 60_000)
    const retryMs = 60_000

    // Приём: при старте — всегда (если не выключен), дальше по интервалу.
    // Неудачная попытка повторяется через минуту, а не через четверть часа.
    const pullDue = automation.lastPullAt === 0
      ? options.pullOnStart !== false
      : now - automation.lastPullAt >= (automation.lastPullOk ? pullEvery : retryMs)

    if (pullDue) {
      const record = await runSync(ctx, 'pull')
      automation.lastPullAt = Date.now()
      automation.lastPullOk = record?.ok === true
      if (record?.ok !== true) automation.lastError = String(record?.message ?? '')
    } else if (automation.lastPullAt === 0) {
      automation.lastPullAt = Date.now()
    }

    if (options.pushOnChange !== false) {
      const fingerprint = await computeFingerprint(ctx)
      const changed = fingerprint !== '' && fingerprint !== automation.fingerprint
      const pushDue = now - automation.lastPushAt >= (automation.lastPushOk === false ? retryMs : pushEvery)

      // Удаление сессии плагином удаления не меняет размер логов, зато сразу
      // уменьшает список сессий рабочего пространства — отправляем без задержки.
      const workspaceCount = countWorkspaceSessions(ctx)
      const shrunk = automation.workspaceCount !== undefined && workspaceCount < automation.workspaceCount
      automation.workspaceCount = workspaceCount

      if ((changed && pushDue) || shrunk) {
        const record = await runSync(ctx, 'push')
        automation.lastPushAt = Date.now()
        automation.lastPushOk = record?.ok === true
        automation.lastError = record?.ok === true ? '' : String(record?.message ?? '')
        if (record?.ok === true) automation.fingerprint = fingerprint
      }
    }
  } catch (error) {
    automation.lastError = error instanceof Error ? error.message : String(error)
  } finally {
    automation.running = false
  }
}

/** Пути всех workspace, которые видит DSH. */
function workspacePaths(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
      return (registry.list() ?? [])
        .map(workspace => workspace?.path ?? workspace?.record?.path)
        .filter(path => typeof path === 'string' && path.length > 0)
    }
  } catch {
    // реестр недоступен — работаем без него
  }
  return []
}

/** Имена репозиториев, которые имеет смысл искать в аккаунте. */
const REPO_CANDIDATES = ['dsh-sessions', 'dsh-sync-sessions', 'dsh-sync']

/**
 * Найти репозиторий зеркала по токену GitHub из хранилища DSH. Только чтение:
 * запрашиваем логин и наличие репозитория с ожидаемым именем.
 */
async function discoverRepository(ctx) {
  let token
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.('GITHUB_TOKEN')
    token = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  } catch {
    token = undefined
  }
  if (token === undefined) return undefined

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-sync',
    'x-github-api-version': '2022-11-28',
  }

  try {
    const me = await fetch('https://api.github.com/user', { headers })
    if (!me.ok) return undefined
    const login = (await me.json())?.login
    if (typeof login !== 'string' || login.length === 0) return undefined

    for (const name of REPO_CANDIDATES) {
      const response = await fetch(`https://api.github.com/repos/${login}/${name}`, { headers })
      if (!response.ok) continue
      const repo = await response.json()
      if (typeof repo?.clone_url === 'string') return repo.clone_url
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Если проекты не настроены, взять первый workspace из DSH: путь и id
 * подставляются сами. Если не задан репозиторий — попробовать найти его в
 * аккаунте GitHub по сохранённому токену.
 */
async function ensureProjectDefaults(ctx) {
  const home = dshHome()
  const config = await loadConfig(home)
  let changed = false

  if (Object.keys(config.projects ?? {}).length === 0) {
    const paths = workspacePaths(ctx)
    const path = paths[0]
    if (typeof path === 'string' && path.length > 0) {
      const folder = path.split(/[\\/]/).filter(Boolean).pop() ?? 'default'
      const id = folder.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
      config.projects = { [id]: { path, title: folder } }
      changed = true
    }
  }

  if ((config.remote ?? '').length === 0) {
    const remote = await discoverRepository(ctx)
    if (remote !== undefined) {
      config.remote = remote
      changed = true
    }
  }

  if (changed) await saveConfig(home, config)
  return config
}

/**
 * Создать приватный репозиторий для зеркала и прописать его в настройках.
 * Токен читается из хранилища DSH и в браузер не возвращается.
 */
async function createRepository(ctx) {
  const home = dshHome()
  const config = await loadConfig(home)

  let token
  try {
    const credentials = ctx?.get?.('credentials')
    const hit = await credentials?.resolve?.('GITHUB_TOKEN')
    token = typeof hit?.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  } catch {
    token = undefined
  }
  if (token === undefined) {
    return {
      ok: false,
      code: 'no-token',
      message: 'В хранилище DSH нет токена GitHub. Создайте приватный репозиторий вручную и вставьте его HTTPS-адрес в поле выше.',
    }
  }

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-sync',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  }
  const repoName = 'dsh-sessions'

  try {
    const me = await fetch('https://api.github.com/user', { headers })
    if (!me.ok) {
      return { ok: false, code: 'unauthorized', message: `GitHub не принял токен (${me.status}). Обновите токен в настройках DSH.` }
    }
    const login = (await me.json())?.login
    if (typeof login !== 'string' || login.length === 0) {
      return { ok: false, code: 'no-login', message: 'Не удалось определить владельца токена на GitHub.' }
    }

    const existing = await fetch(`https://api.github.com/repos/${login}/${repoName}`, { headers })
    if (existing.ok) {
      const repo = await existing.json()
      const remote = typeof repo?.clone_url === 'string' ? repo.clone_url : ''
      if (remote !== '') {
        config.remote = remote
        await saveConfig(home, config)
        return { ok: true, created: false, remote, message: `Репозиторий уже существует: ${login}/${repoName}` }
      }
    }

    const created = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: repoName,
        private: true,
        description: 'Зеркало сессий DeepSeek Harness (dsh-sync)',
        auto_init: false,
      }),
    })
    if (!created.ok) {
      const detail = await created.text().catch(() => '')
      return {
        ok: false,
        code: 'create-failed',
        message: `GitHub ответил ${created.status}: ${detail.slice(0, 200)}. Создайте приватный репозиторий вручную и вставьте адрес в поле.`,
      }
    }
    const repo = await created.json()
    const remote = typeof repo?.clone_url === 'string' ? repo.clone_url : ''
    if (remote === '') {
      return { ok: false, code: 'no-url', message: 'Репозиторий создан, но GitHub не вернул адрес. Скопируйте HTTPS-адрес вручную.' }
    }
    config.remote = remote
    await saveConfig(home, config)
    return { ok: true, created: true, remote, message: `Создан приватный репозиторий ${login}/${repoName}` }
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: `Не удалось связаться с GitHub: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Состояние каждой сессии для индикатора в списке: зелёный — совпадает с
 * зеркалом, оранжевый — есть неотправленные изменения, красный — ещё не уезжала.
 * Результат кэшируется на несколько секунд: список перерисовывается часто.
 */
let sessionStatesCache = { at: 0, value: undefined }

async function sessionStates(ctx) {
  if (sessionStatesCache.value !== undefined && Date.now() - sessionStatesCache.at < 5_000) {
    return sessionStatesCache.value
  }

  const home = dshHome()
  const config = await loadConfig(home)
  const ledger = await readLedger(home)
  const states = {}

  for (const entry of Object.values(config.projects ?? {})) {
    const projectPath = typeof entry?.path === 'string' ? entry.path : ''
    if (projectPath === '') continue
    let located
    try {
      located = await localSessionsFor(ctx, home, projectPath)
    } catch {
      continue
    }
    for (const session of located.sessions) {
      if (typeof session.path !== 'string') continue
      let info
      try {
        info = await stat(session.path)
      } catch {
        info = undefined
      }
      states[session.id] = sessionState(session.id, info, ledger)
    }
  }

  const value = { ok: true, states }
  sessionStatesCache = { at: Date.now(), value }
  return value
}

/**
 * Привязать сессии всех настроенных проектов к их рабочим пространствам. */
async function attachAllProjects(ctx, config) {
  let attached = 0
  for (const entry of Object.values(config.projects ?? {})) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    if (path === '') continue
    try {
      const located = await localSessionsFor(ctx, dshHome(), path)
      const ids = located.sessions.filter(session => !session.parent).map(session => session.id)
      attached += await attachSessions(ctx, path, ids)
    } catch {
      // один проект не должен мешать остальным
    }
  }
  return attached
}

/** Убрать удалённые сессии из рабочих пространств, чтобы они исчезли из списка. */
async function detachSessions(ctx, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) return 0
  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch {
    return 0
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return 0

  const wanted = new Set(sessionIds)
  let detached = 0
  for (const workspace of registry.list() ?? []) {
    let known
    try {
      known = new Set(Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : [])
    } catch {
      continue
    }
    for (const id of wanted) {
      if (!known.has(id)) continue
      try {
        await workspace.detachSession(id)
        detached += 1
      } catch {
        // уже отвязана
      }
    }
  }
  return detached
}

/** Сколько всего сессий числится за рабочими пространствами. */
function countWorkspaceSessions(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return 0
    let total = 0
    for (const workspace of registry.list() ?? []) {
      total += Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Привязать сессии к рабочему пространству проекта.
 *
 * DSH выполняет bootstrap реестра только при первой инициализации: сессии,
 * добавленные позже (нашим плагином или вручную), на диске есть, но в списке
 * не появляются. `attachSession` идемпотентен, поэтому повторный вызов дешёвый.
 */
async function attachSessions(ctx, projectPath, sessionIds) {
  if (typeof projectPath !== 'string' || projectPath.length === 0 || sessionIds.length === 0) return 0

  let registry
  try {
    registry = ctx?.get?.('workspaceRegistry')
  } catch {
    registry = undefined
  }
  if (registry === undefined || registry === null || typeof registry.list !== 'function') return 0

  let workspace
  try {
    for (const candidate of registry.list() ?? []) {
      const path = candidate?.path ?? candidate?.record?.path
      if (typeof path === 'string' && samePath(path, projectPath)) {
        workspace = candidate
        break
      }
    }
  } catch {
    return 0
  }
  if (workspace === undefined || typeof workspace.attachSession !== 'function') return 0

  let attached = 0
  let known = new Set()
  try {
    known = new Set(Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
  } catch {
    known = new Set()
  }
  for (const id of sessionIds.slice(0, 1000)) {
    if (known.has(id)) continue
    try {
      await workspace.attachSession(id)
      attached += 1
    } catch {
      // уже привязана, либо cwd не совпал — не повод ронять синхронизацию
    }
  }
  return attached
}

/** Подхватить проекты из метаданных зеркала, сопоставив их с локальными путями. */
async function adoptMirrorProjects(ctx, config, pullResult) {
  const projects = pullResult?.mirrorProjects ?? []
  if (projects.length === 0) return 0
  const paths = workspacePaths(ctx)
  if (paths.length === 0) return 0

  let added = 0
  for (const project of projects) {
    if (config.projects?.[project.id] !== undefined) continue
    const path = matchProjectPath(project.id, project.title, paths)
    if (path === undefined) continue
    config.projects[project.id] = { path, title: project.title }
    added += 1
  }
  if (added > 0) await saveConfig(dshHome(), config)
  return added
}

/** Включить фоновую синхронизацию: первый такт через 10 с, дальше раз в минуту. */
function startAutomation(ctx) {
  automation.enabled = true
  void ensureProjectDefaults(ctx).catch(() => {})
  ctx.effect(() => {
    const initial = setTimeout(() => {
      void autoTick(ctx)
    }, 3_000)
    initial.unref?.()
    const timer = setInterval(() => {
      void autoTick(ctx)
    }, 60_000)
    timer.unref?.()

    // Быстрый сторож удалений: плагин удаления сессий убирает её из рабочего
    // пространства, а список меняется сразу. Проверяем каждые 5 секунд, чтобы
    // удаление уезжало в зеркало почти мгновенно, без ожидания минуты.
    automation.workspaceCount = countWorkspaceSessions(ctx)
    const watcher = setInterval(() => {
      if (automation.running) return
      const now = countWorkspaceSessions(ctx)
      if (automation.workspaceCount !== undefined && now < automation.workspaceCount) {
        automation.workspaceCount = now
        if (!automation.workspacePushPending) {
          automation.workspacePushPending = true
          void runSync(ctx, 'push')
            .catch(() => {})
            .finally(() => {
              automation.workspacePushPending = false
            })
        }
      } else {
        automation.workspaceCount = now
      }
    }, 5_000)
    watcher.unref?.()

    automation.timer = timer
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
      clearInterval(watcher)
      automation.enabled = false
    }
  }, 'dsh-sync: automation')
}

/** Периодическая проверка обновлений: первая через полминуты, дальше раз в 6 часов. */
function startUpdateWatch(ctx) {
  ctx.effect(() => {
    let stopped = false
    let timer
    const tick = async () => {
      if (stopped) return
      try {
        const fresh = await checkForUpdate(() => resolveGitHubToken(ctx))
        if (fresh.status === 'behind' && fresh.latest !== announcedVersion) {
          announcedVersion = fresh.latest
          pushNotice('update', `Доступна новая версия dsh-sync (${String(fresh.latest).slice(0, 7)}). Обновить можно в карточке плагина.`)
          const config = await loadConfig(dshHome())
          if (config.autoUpdate === true) {
            pushNotice('update', 'Автообновление включено: плагин переустановится после паузы.')
            setTimeout(() => {
              try {
                applyUpdate(ctx)
              } catch {
                // менеджер плагинов может быть недоступен — не критично
              }
            }, 120_000).unref?.()
          }
        }
      } catch (error) {
        pushNotice('error', `Проверка обновлений не удалась: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!stopped) {
        timer = setTimeout(() => void tick(), UPDATE_CHECK_INTERVAL_MS)
        timer.unref?.()
      }
    }
    const first = setTimeout(() => void tick(), 30_000)
    first.unref?.()
    return () => {
      stopped = true
      clearTimeout(first)
      clearTimeout(timer)
    }
  }, 'dsh-sync: update watch')
}

export function apply(ctx) {
  const failures = []

  const route = (label, path, handler) => {
    try {
      ctx.effect(() => ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      }), `dsh-sync: ${label}`)
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  route('state', STATE_PATH, async () => json(await readState(ctx)))

  // Самопроверка версии: сравнивает закреплённый коммит с `main` в репозитории
  // и по явному нажатию просит менеджер плагинов переустановить пакет.
  const resolveUpdateToken = async () => {
    try {
      const credentials = ctx.get('credentials')
      const hit = await credentials?.resolve('GITHUB_TOKEN')
      return hit?.value
    } catch {
      return undefined
    }
  }

  void checkForUpdate(resolveUpdateToken)

  route('update', UPDATE_PATH, async () => json({ ok: true, ...updateState(), description: describeUpdate() }))

  route('update-apply', UPDATE_APPLY_PATH, async () => {
    const fresh = await checkForUpdate(resolveUpdateToken)
    const result = applyUpdate(ctx)
    return json({
      ok: result.started,
      code: result.started ? 'scheduled' : 'no-op',
      message: result.reason,
      status: fresh.status,
      installed: fresh.installed,
      latest: fresh.latest,
    })
  })

  route('config', CONFIG_PATH, async (request) => {
    try {
      return json(await saveSettings(ctx, await body(request)))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('run', RUN_PATH, async (request) => {
    const payload = await body(request)
    const action = ['sync', 'pull', 'push'].includes(payload.action) ? payload.action : 'sync'
    try {
      return json(await runSync(ctx, action))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('create-repo', CREATE_REPO_PATH, async () => {
    try {
      return json(await createRepository(ctx))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('diagnostics', DIAG_PATH, async () => {
    try {
      const probe = await runCapture('git', ['--version'])
      const gitVersion = probe.code === 0 ? probe.stdout.trim().replace(/^git version\s*/, '') : 'не найден'
      const report = await collectDiagnostics(dshHome(), { gitVersion })
      return json({ ok: true, report })
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('sessions', SESSIONS_PATH, async () => {
    try {
      return json(await sessionStates(ctx))
    } catch (error) {
      return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  route('notifications', NOTIFICATIONS_PATH, async (request) => {
    const payload = await body(request)
    const since = Number(payload?.since ?? 0)
    return json({ ok: true, items: notices.filter(item => item.id > since), cursor: noticeSeq })
  })

  const tool = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      failures.push(`tool ${definition.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  tool({
    name: 'sync_status',
    description: 'Показать состояние синхронизации сессий DSH: окружение, настройки, счётчики и последний запуск. Вызывайте перед любой операцией синхронизации.',
    parameters: { type: 'object', properties: {} },
    output: TEXT_OUTPUT,
    async execute() {
      const state = await readState(ctx)
      const lines = []
      lines.push(`устройство: ${state.deviceId ?? '?'}`)
      lines.push(`репозиторий: ${state.config?.remote || 'не задан'}`)
      lines.push(`проект: ${state.config?.projectId || '?'} → ${state.config?.projectPath || '?'}`)
      lines.push(`режим: ${state.mode === 'external' ? `через внешний плагин ${state.external.name}` : 'встроенный движок'}`)
      if (state.external?.found && !state.external.callable) {
        lines.push(`внимание: установлен ${state.external.name}, но без программного интерфейса — активен встроенный движок`)
      }
      for (const check of state.checks) {
        lines.push(`${check.ok ? 'OK' : 'НЕТ'} ${check.title}: ${check.detail}`)
      }
      if (state.status) {
        lines.push(`сессий локально: ${state.status.local}, в зеркале: ${state.status.mirror}`)
      }
      if (state.lastRun) {
        lines.push(`последний запуск: ${state.lastRun.at} — ${state.lastRun.ok ? 'успешно' : 'ошибка'}: ${state.lastRun.message}`)
      }
      if (state.automation) {
        const auto = state.automation
        lines.push(`автосинхронизация: ${auto.enabled ? 'вкл' : 'выкл'}${auto.running ? ' (выполняется)' : ''}`)
        lines.push(`  приём: ${auto.lastPullAt ?? 'ещё не было'}, отправка: ${auto.lastPushAt ?? 'ещё не было'}${auto.lastError ? `, ошибка: ${auto.lastError}` : ''}`)
      }
      return lines.join('\n')
    },
  })

  tool({
    name: 'sync_run',
    description: 'Синхронизировать сессии DSH с зеркалом: принять удалённые изменения и отправить локальные. Требует настроенного плагина dsh-sync.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['sync', 'pull', 'push'],
          description: 'sync — принять и отправить (по умолчанию), pull — только принять, push — только отправить.',
        },
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = ['sync', 'pull', 'push'].includes(args?.action) ? args.action : 'sync'
      const record = await runSync(ctx, action)
      return `${record.ok ? 'OK' : 'ОШИБКА'}: ${record.message}`
    },
  })

  startAutomation(ctx)
  startUpdateWatch(ctx)
  void writeStatus({ applied: true, pid: process.pid, failures })
}

/** Записать отметку о загрузке host-части: помогает диагностировать «404». */
async function writeStatus(patch) {
  try {
    const dir = join(dshHome(), 'dsh-sync')
    await mkdir(dir, { recursive: true })
    const file = join(dir, PLUGIN_STATUS_FILE)
    let current = {}
    try {
      current = JSON.parse(await readFile(file, 'utf8'))
    } catch {
      current = {}
    }
    await writeFile(file, `${JSON.stringify({ ...current, ...patch, at: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // диагностика не должна мешать загрузке
  }
}

//

// Отметка о загрузке модуля: по ней видно, дошло ли дело до host-части вообще.
void writeStatus({ imported: true })
