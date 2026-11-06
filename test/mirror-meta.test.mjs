import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { matchProjectPath, mergeDevice, readMeta, writeMeta } from '../lib/mirror-meta.mjs'

test('метаданные проекта дополняются путём устройства', () => {
  const empty = { version: 1, projects: {} }
  const first = mergeDevice(empty, { projectId: 'harness', title: 'DeepSeek Harness', deviceId: 'a', path: 'E:\\DeepSeek Harness' })
  assert.equal(first.projects.harness.title, 'DeepSeek Harness')
  assert.equal(first.projects.harness.devices.a, 'E:\\DeepSeek Harness')

  const second = mergeDevice(first, { projectId: 'harness', title: 'ignored', deviceId: 'b', path: '/home/me/proj' })
  assert.equal(second.projects.harness.title, 'DeepSeek Harness')
  assert.deepEqual(second.projects.harness.devices, { a: 'E:\\DeepSeek Harness', b: '/home/me/proj' })

  const other = mergeDevice(second, { projectId: 'work', title: 'work', deviceId: 'a', path: 'D:\\work' })
  assert.deepEqual(Object.keys(other.projects).sort(), ['harness', 'work'])
})

test('проект из зеркала сопоставляется с папкой по имени', () => {
  const paths = ['E:\\DeepSeek Harness', 'D:\\projects\\another']
  assert.equal(matchProjectPath('harness', 'DeepSeek Harness', paths), 'E:\\DeepSeek Harness')
  assert.equal(matchProjectPath('deepseek-harness', 'DeepSeek Harness', paths), 'E:\\DeepSeek Harness')
  assert.equal(matchProjectPath('unknown', 'nope', paths), undefined)
})

test('метаданные читаются и пишутся, битый файл не ломает разбор', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-meta-'))
  try {
    assert.deepEqual(await readMeta(dir), { version: 1, projects: {} })
    const meta = mergeDevice({ version: 1, projects: {} }, { projectId: 'p', title: 'P', deviceId: 'd', path: '/x/y' })
    await writeMeta(dir, meta)
    const back = await readMeta(dir)
    assert.equal(back.projects.p.devices.d, '/x/y')

    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'projects.json'), '{broken', 'utf8')
    assert.deepEqual(await readMeta(dir), { version: 1, projects: {} })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
