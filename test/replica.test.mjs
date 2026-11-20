import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { pullReplicated, pushReplicated, secondaryConfig } from '../lib/replica.mjs'
import { localSessionDir } from '../lib/store.mjs'

function sessionBytes(projectPath, id) {
  const header = { type: 'session', version: 4, id, createdAt: Date.now(), cwd: projectPath, isSeeded: false, delegationDepth: 0 }
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ seq: 0 })}\n`)),
  ])
}

async function writeSession(home, projectPath, id) {
  const dir = localSessionDir(home, projectPath, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), sessionBytes(projectPath, id))
}

test('отправка дублируется в оба хранилища', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-replica-'))
  const project = join(root, 'project')
  const home = join(root, 'home')
  await mkdir(project, { recursive: true })
  try {
    const id = `session-${randomUUID()}`
    await writeSession(home, project, id)

    const config = {
      backend: 'folder',
      repoDir: join(root, 'mirror-main'),
      projects: { p: { path: project } },
      secondary: { enabled: true, backend: 'folder', repoDir: join(root, 'mirror-backup') },
    }

    const summary = await pushReplicated({ home, config })
    assert.ok(summary.pushed >= 1)
    assert.ok(summary.secondary !== undefined, 'резервное хранилище задействовано')
    assert.ok(existsSync(join(config.repoDir, 'sessions', 'p', id)), 'основное зеркало')
    assert.ok(existsSync(join(config.secondary.repoDir, 'sessions', 'p', id)), 'резервное зеркало')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('при недоступном основном хранилище приём идёт из резервного', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-replica-'))
  const project = join(root, 'project')
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  await mkdir(project, { recursive: true })
  try {
    const id = `session-${randomUUID()}`
    await writeSession(homeA, project, id)

    const backupDir = join(root, 'mirror-backup')
    const configA = {
      backend: 'folder',
      repoDir: backupDir,
      projects: { p: { path: project } },
    }
    await pushReplicated({ home: homeA, config: configA })

    const configB = {
      backend: 'folder',
      repoDir: backupDir,
      projects: { p: { path: project } },
      secondary: { enabled: true, backend: 'folder', repoDir: backupDir },
    }
    // Основное «сломано» указанием на недоступный git-remote.
    const broken = { ...configB, backend: 'git', remote: join(root, 'no-such-repo.git'), repoDir: join(root, 'mirror-broken'), secondary: configB.secondary }
    const result = await pullReplicated({ home: homeB, config: broken })
    assert.equal(result.viaSecondary, true, 'принято из резервного')
    assert.ok(existsSync(localSessionDir(homeB, project, id)), 'сессия приехала')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('выключенное резервное хранилище не используется', () => {
  assert.equal(secondaryConfig({ backend: 'folder', repoDir: '/tmp/x' }), undefined)
  assert.equal(secondaryConfig({ backend: 'folder', repoDir: '/tmp/x', secondary: { enabled: false, backend: 'git' } }), undefined)
})
