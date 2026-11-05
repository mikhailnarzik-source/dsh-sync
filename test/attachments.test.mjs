import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { pullAttachments, pushAttachments } from '../lib/attachments.mjs'

async function makeObject(home, bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex')
  const dir = join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2))
  await mkdir(dir, { recursive: true })
  const path = join(dir, digest)
  await writeFile(path, bytes)
  return { digest, path }
}

test('вложения копируются по sha256 и не дублируются', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-att-'))
  try {
    const homeA = join(root, 'a')
    const homeB = join(root, 'b')
    const mirror = join(root, 'shared')
    await mkdir(homeA, { recursive: true })
    await mkdir(homeB, { recursive: true })
    await mkdir(mirror, { recursive: true })

    const image = Buffer.from('not-really-a-png-but-bytes')
    const { digest } = await makeObject(homeA, image)
    const file = Buffer.from('generic file attachment')
    const fileDigest = createHash('sha256').update(file).digest('hex')
    const filesDir = join(homeA, 'attachments', 'v1', 'files', fileDigest.slice(0, 2), fileDigest)
    await mkdir(filesDir, { recursive: true })
    await writeFile(join(filesDir, 'report.txt'), file)

    const pushed = await pushAttachments({ home: homeA, repoDir: mirror })
    assert.equal(pushed.added, 2)
    assert.equal(existsSync(join(mirror, 'attachments', 'objects', digest.slice(0, 2), digest)), true)
    assert.equal(existsSync(join(mirror, 'attachments', 'files', fileDigest.slice(0, 2), fileDigest, 'report.txt')), true)

    const again = await pushAttachments({ home: homeA, repoDir: mirror })
    assert.equal(again.added, 0)

    const restored = await pullAttachments({ home: homeB, repoDir: mirror })
    assert.equal(restored.restored, 2)

    const imageBytes = await readFile(join(homeB, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest))
    assert.deepEqual(imageBytes, image)
    const fileBytes = await readFile(join(homeB, 'attachments', 'v1', 'files', fileDigest.slice(0, 2), fileDigest, 'report.txt'))
    assert.deepEqual(fileBytes, file)

    const second = await pullAttachments({ home: homeB, repoDir: mirror })
    assert.equal(second.restored, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('кеш запросов и tmp не попадают в зеркало', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-att-'))
  try {
    const home = join(root, 'a')
    const mirror = join(root, 'shared')
    const tmpDir = join(home, 'attachments', 'v1', 'tmp')
    const cacheDir = join(home, 'attachments', 'v1', 'request-images', 'aa')
    await mkdir(tmpDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(tmpDir, 'partial'), 'x')
    await writeFile(join(cacheDir, 'cache'), 'y')
    await mkdir(mirror, { recursive: true })

    const pushed = await pushAttachments({ home, repoDir: mirror })
    assert.equal(pushed.added, 0)
    assert.equal(existsSync(join(mirror, 'attachments')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
