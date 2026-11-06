/**
 * Дымовой прогон host-части плагина без запуска DSH: подменяем ctx, вызываем
 * apply, дёргаем зарегистрированные маршруты и инструменты.
 *
 * Запуск: node test/plugin-smoke.mjs
 */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = await mkdtemp(join(tmpdir(), 'dsh-sync-plugin-'))
process.env.DSH_HOME = home

const { apply, name, inject } = await import('../index.js')

const routes = new Map()
const tools = new Map()
const ctx = {
  effect: (fn) => { fn() },
  connection: { fetch: { register: (route) => routes.set(route.path, route) } },
  tools: { register: (tool) => tools.set(tool.name, tool) },
}

assert.equal(name, 'dsh-sync')
assert.deepEqual(inject, ['connection', 'tools', 'sessionPersistence'])
apply(ctx)

assert.deepEqual([...routes.keys()].sort(), ['/api/dsh-sync/config', '/api/dsh-sync/create-repo', '/api/dsh-sync/run', '/api/dsh-sync/state'])
assert.deepEqual([...tools.keys()].sort(), ['sync_run', 'sync_status'])

const call = async (path, payload) => {
  const response = await routes.get(path).fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }))
  return { status: response.status, body: await response.json() }
}

// 1. пустая конфигурация
const empty = await call('/api/dsh-sync/state', {})
assert.equal(empty.body.ok, true)
assert.equal(empty.body.ready, false)
assert.equal(empty.body.checks.length, 4)

// 2. сохранение настроек
const projectPath = join(home, 'project')
await mkdir(projectPath, { recursive: true })
const saved = await call('/api/dsh-sync/config', {
  remote: 'https://example.invalid/sessions.git',
  projectPath,
  projectId: 'Harness Test',
  attachments: true,
})
assert.equal(saved.body.ok, true)
assert.equal(saved.body.config.projectId, 'harness-test')
assert.equal(saved.body.config.projectPath, projectPath)
assert.equal(saved.body.config.attachments, true)

// 3. повторное чтение видит сохранённое
const again = await call('/api/dsh-sync/state', {})
assert.equal(again.body.config.remote, 'https://example.invalid/sessions.git')
assert.equal(again.body.config.projectId, 'harness-test')

// 4. инструменты отвечают текстом
const statusText = await tools.get('sync_status').execute({})
assert.match(statusText, /устройство/)
assert.match(statusText, /проект: harness-test/)

// 5. run без доступного remote возвращает ok:false с сообщением, а не падает
const run = await call('/api/dsh-sync/run', { action: 'pull' })
assert.equal(run.status, 200)
assert.equal(typeof run.body.ok, 'boolean')
assert.equal(typeof run.body.message, 'string')

// 6. битое тело запроса не ломает маршрут
const bad = await routes.get('/api/dsh-sync/config').fetch(new Request('http://local/api/dsh-sync/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{not json',
}))
assert.equal(bad.status, 200)
assert.equal((await bad.json()).ok, true)

// 7. внешний плагин: обнаружение по сервису и делегирование
const calls = []
const externalService = {
  async pull() { calls.push('pull') },
  async push() { calls.push('push') },
}
const externalRoutes = new Map()
apply({
  effect: (fn) => { fn() },
  connection: { fetch: { register: route => externalRoutes.set(route.path, route) } },
  tools: { register: () => {} },
  get: (serviceName) => (serviceName === 'session-sync' ? externalService : undefined),
})
const callExternal = async (path, payload) => {
  const response = await externalRoutes.get(path).fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }))
  return response.json()
}

const externalState = await callExternal('/api/dsh-sync/state', {})
assert.equal(externalState.external.found, true)
assert.equal(externalState.external.callable, true)
assert.equal(externalState.external.name, 'session-sync')
assert.equal(externalState.mode, 'external')

const externalRun = await callExternal('/api/dsh-sync/run', { action: 'sync' })
assert.equal(externalRun.ok, true)
assert.equal(externalRun.mode, 'external')
assert.deepEqual(calls, ['pull', 'push'])
assert.match(externalRun.message, /через session-sync/)

// 8. выключенный приоритет внешнего плагина возвращает встроенный движок
await callExternal('/api/dsh-sync/config', {
  remote: 'https://example.invalid/sessions.git',
  projectPath,
  projectId: 'harness-test',
  attachments: true,
  useExternal: false,
})
calls.length = 0
const builtinAgain = await callExternal('/api/dsh-sync/state', {})
assert.equal(builtinAgain.mode, 'builtin')
assert.equal(builtinAgain.preferExternal, false)

// 9. внешний плагин, установленный, но без сервиса: найден по профилю
await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
await writeFile(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({
  name: 'profile',
  dependencies: { 'dsh-session-sync': '^0.2.32' },
  dsh: { profile: { bundles: ['dsh-session-sync'] } },
}))
await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), `- insert:\n    - id: session-sync\n      name: dsh-session-sync\n      config:\n        remote: git@github.com:me/sessions.git\n`)
const profileRoutes = new Map()
apply({ effect: (fn) => { fn() }, connection: { fetch: { register: route => profileRoutes.set(route.path, route) } }, tools: { register: () => {} } })
const profileState = await (await profileRoutes.get('/api/dsh-sync/state').fetch(new Request('http://local/api', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}))).json()
assert.equal(profileState.external.found, true)
assert.equal(profileState.external.callable, false)
assert.equal(profileState.external.name, 'dsh-session-sync')
assert.equal(profileState.external.configured, true)
assert.equal(profileState.mode, 'builtin')

// 10. создание репозитория без токена возвращает понятную причину
const noToken = await call('/api/dsh-sync/create-repo', {})
assert.equal(noToken.body.ok, false)
assert.equal(noToken.body.code, 'no-token')

console.log('plugin smoke: OK')
console.log('  маршруты:', [...routes.keys()].join(', '))
console.log('  инструменты:', [...tools.keys()].join(', '))
console.log('  lastRun:', JSON.stringify(run.body))
await rm(home, { recursive: true, force: true })
