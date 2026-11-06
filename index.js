/**
 * Host half of `dsh-sync`: проверка окружения, настройки и запуск синхронизации
 * из интерфейса DSH.
 *
 * Плагин работает поверх готового движка из `lib/` (тот же, что у CLI):
 * карточка в настройках читает состояние через `ctx.connection.fetch`,
 * сохраняет параметры в `~/.dsh/dsh-sync.json` и запускает `pull`/`push`.
 * Токены нигде не хранятся: git использует штатный credential helper.
 */import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { readFile as readFileText } from 'node:fs/promises'

import { defaultConfig, loadConfig, saveConfig } from './lib/config.mjs'
import { encodeSegment, projectKey, samePath } from './lib/format.mjs'
import { listLocalSessions, listMirrorSessions, sessionsOfProject } from './lib/store.mjs'
import { pull, push } from './lib/sync.mjs'

export const name = 'dsh-sync'
// sessionPersistence даёт список сессий с путями к логам: обходим каталог
// приходится только как запасной вариант.
export const inject = ['connection', 'tools', 'sessionPersistence']

const STATE_PATH = '/api/dsh-sync/state'
const CONFIG_PATH = '/api/dsh-sync/config'
const RUN_PATH = '/api/dsh-sync/run'

/** Инструменты возвращают текст: DSH требует явное описание вывода. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const LAST_RUN_FILE = 'last-run.json'
const PLUGIN_STATUS_FILE = 'plugin-status.json'

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

  const external = await discoverExternal(ctx)
  const preferExternal = config.useExternal !== false
  const mode = external.found && external.callable && preferExternal ? 'external' : 'builtin'

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
        sessions.push({ id: header.id, cwd: header.cwd, path })
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
  const projectIdRaw = typeof payload.projectId === 'string' ? payload.projectId.trim() : ''
  const projectPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : ''
  const projectId = (projectIdRaw || 'default').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')

  config.remote = remote
  config.backend = 'git'
  config.attachments = payload.attachments === true
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
    return record
  }

  const record = { ...parsed, at: new Date().toISOString(), nodePath: node.path, durationMs: parsed.durationMs ?? Date.now() - started }
  await writeLastRun(record)
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
  if (viaChild !== undefined) return viaChild

  const started = Date.now()
  const result = { pull: null, push: null }
  const messages = []
  try {
    if (action !== 'push') {
      result.pull = await pull({ home, config })
      messages.push(`принято: ${result.pull.imported}, обновлено: ${result.pull.updated}, конфликтов: ${result.pull.conflicts}`)
      if (result.pull.errors?.length) messages.push(`ошибок чтения: ${result.pull.errors.length} (${result.pull.errors[0].message})`)
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

async function writeLastRun(record) {  const dir = join(dshHome(), 'dsh-sync')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LAST_RUN_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch {
    // запись истории не критична
  }
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

  void writeStatus({ applied: true, version: '0.2.1', pid: process.pid, failures })
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
void writeStatus({ imported: true, version: '0.2.1' })
