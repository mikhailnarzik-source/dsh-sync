import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { pull, push } from '../lib/sync.mjs'
import { localSessionDir } from '../lib/store.mjs'

function sessionBytes(projectPath, id) {
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: Date.now(),
    cwd: projectPath,
    isSeeded: false,
    delegationDepth: 0,
  }
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ seq: 0, text: 'привет' })}\n`)),
  ])
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-tomb-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  const remote = join(root, 'remote.git')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })

  const config = (suffix) => ({
    backend: 'git',
    branch: 'main',
    remote,
    repoDir: join(root, `mirror-${suffix}`),
    deviceId: `device-${suffix}`,
    attachments: false,
    projects: { p: { id: 'p', title: 'p', path: project } },
  })

  return { root, project, configA: config('a'), configB: config('b') }
}

async function writeSession(home, projectPath, id) {
  const dir = localSessionDir(home, projectPath, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBytes(projectPath, id))
  return dir
}

test('удаление сессии доезжает до другого устройства через надгробие', async () => {
  const env = await makeEnvironment()
  const homeA = join(env.root, 'home-a')
  const homeB = join(env.root, 'home-b')
  const id = `session-${randomUUID()}`

  try {
    // Устройство A создаёт сессию и отправляет её.
    await writeSession(homeA, env.project, id)
    await push({ home: homeA, config: env.configA })
    assert.ok(existsSync(join(env.configA.repoDir, 'sessions', 'p', id)), 'сессия в зеркале')

    // Устройство B принимает её.
    const firstPull = await pull({ home: homeB, config: env.configB })
    assert.equal(firstPull.imported, 1)
    const dirB = localSessionDir(homeB, env.project, id)
    assert.ok(existsSync(dirB), 'сессия приехала на B')

    // A удаляет сессию и отправляет — из зеркала она уходит, отметка остаётся.
    await rm(localSessionDir(homeA, env.project, id), { recursive: true, force: true })
    const removed = await push({ home: homeA, config: env.configA })
    assert.equal(removed.removed, 1)
    assert.equal(existsSync(join(env.configA.repoDir, 'sessions', 'p', id)), false, 'из зеркала удалена')

    const tomb = JSON.parse(await readFile(join(env.configA.repoDir, 'tombstones.json'), 'utf8'))
    assert.ok(tomb.sessions[id], 'надгробие записано')

    // B принимает изменения — сессия исчезает, но копия остаётся в архиве.
    const secondPull = await pull({ home: homeB, config: env.configB })
    assert.equal(secondPull.deleted, 1)
    assert.deepEqual(secondPull.deletedIds, [id])
    assert.equal(existsSync(dirB), false, 'на B сессия удалена')

    const deletedRoot = join(homeB, 'dsh-sync', 'deleted')
    assert.ok(existsSync(deletedRoot), 'каталог архива создан')
    const stamps = (await import('node:fs')).readdirSync(deletedRoot)
    assert.ok(stamps.length > 0, 'есть отметка времени архива')
    assert.ok(existsSync(join(deletedRoot, stamps[0], id)), 'копия сохранена в архиве')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('вернувшаяся сессия снимает надгробие', async () => {
  const env = await makeEnvironment()
  const homeA = join(env.root, 'home-a')
  const id = `session-${randomUUID()}`

  try {
    const dir = await writeSession(homeA, env.project, id)
    await push({ home: homeA, config: env.configA })
    await rm(dir, { recursive: true, force: true })
    await push({ home: homeA, config: env.configA })

    // Сессия «восстановлена» на устройстве и снова уходит в зеркало.
    await writeSession(homeA, env.project, id)
    await push({ home: homeA, config: env.configA })

    const tomb = JSON.parse(await readFile(join(env.configA.repoDir, 'tombstones.json'), 'utf8'))
    assert.equal(tomb.sessions[id], undefined, 'надгробие снято')
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
