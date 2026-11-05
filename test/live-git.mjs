/**
 * Живой прогон git-бэкенда на настоящем репозитории (bare, локальный путь).
 * Проверяет то, чего не видит юнит-тест с подменённым исполнителем:
 * реальные fetch / reset / commit / push и повторный pull на другой стороне.
 *
 * Запуск: node test/live-git.mjs
 * Нужен установленный git; под песочницей DSH локальный транспорт может быть
 * заблокирован (git for Windows запускает sh, которому нужны named pipes).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

import { defaultConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir, splitLog } from '../lib/store.mjs'
import { pull, push } from '../lib/sync.mjs'
import { git, ensureRepo } from '../lib/git.mjs'

function makeLog(header, events) {
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    ...events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))),
  ])
}

const root = await mkdtemp(join(tmpdir(), 'dsh-sync-live-'))
try {
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  const remote = join(root, 'remote.git')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(remote, { recursive: true })
  await git(remote, ['init', '--bare', '-b', 'main'])

  const pathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const pathB = process.platform === 'win32' ? 'D:\\projects\\alpha' : '/home/user/alpha'

  const configA = { ...defaultConfig(homeA), backend: 'git', remote, repoDir: join(homeA, 'repo'), deviceId: 'a' }
  configA.projects = { alpha: { path: pathA } }
  const configB = { ...defaultConfig(homeB), backend: 'git', remote, repoDir: join(homeB, 'repo'), deviceId: 'b' }
  configB.projects = { alpha: { path: pathB } }
  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)
  await ensureRepo({ repoDir: configA.repoDir, branch: 'main' })
  await ensureRepo({ repoDir: configB.repoDir, branch: 'main' })

  const id = `session-${randomUUID()}`
  const log = makeLog({ type: 'session', version: 4, id, createdAt: Date.now(), cwd: pathA, isSeeded: false, delegationDepth: 0 }, [{ seq: 0 }])
  const dirA = localSessionDir(homeA, pathA, id)
  await mkdir(dirA, { recursive: true })
  await writeFile(join(dirA, 'session.v4.jsonl.zstd'), log)

  const pushed = await push({ home: homeA, config: configA })
  assert.equal(pushed.pushedToRemote, true, 'push должен дойти до репозитория')

  const pulled = await pull({ home: homeB, config: configB })
  assert.equal(pulled.imported, 1, 'вторая сторона должна импортировать сессию')

  const imported = await readFile(join(localSessionDir(homeB, pathB, id), 'session.v4.jsonl.zstd'))
  assert.equal(splitLog(imported).header.cwd, pathB)
  assert.deepEqual(splitLog(imported).tail, splitLog(log).tail)

  // второй круг: изменение на B возвращается на A
  const appended = Buffer.concat([imported, zstdCompressSync(Buffer.from(`${JSON.stringify({ seq: 1, from: 'B' })}\n`))])
  await writeFile(join(localSessionDir(homeB, pathB, id), 'session.v4.jsonl.zstd'), appended)
  await push({ home: homeB, config: configB })
  const back = await pull({ home: homeA, config: configA })
  assert.equal(back.updated, 1, 'A должен получить fast-forward из B')

  const finalA = await readFile(join(localSessionDir(homeA, pathA, id), 'session.v4.jsonl.zstd'))
  assert.equal(splitLog(finalA).tail.length, splitLog(appended).tail.length)

  console.log('OK: git-бэкенд прошёл полный круг A → remote → B → remote → A')
} finally {
  await rm(root, { recursive: true, force: true })
}
