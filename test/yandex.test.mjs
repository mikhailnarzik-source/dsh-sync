import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import { createYandexBackend } from '../lib/yandex.mjs'

/** Поддельный Яндекс.Диск: дерево в памяти и те же маршруты, что у API. */
function fakeDisk() {
  const dirs = new Set(['/dsh-sync'])
  const files = new Map()

  const handler = async (url, init = {}) => {
    const parsed = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()

    if (parsed.hostname === 'dl.test') {
      const buffer = files.get(parsed.pathname)
      if (buffer === undefined) return new Response('нет файла', { status: 404 })
      return new Response(buffer, { status: 200 })
    }

    if (parsed.hostname === 'up.test') {
      files.set(parsed.pathname, Buffer.from(init.body))
      return new Response(null, { status: 201 })
    }

    const path = parsed.searchParams.get('path')

    if (parsed.pathname === '/v1/disk/resources' && method === 'GET') {
      if (!dirs.has(path) && !files.has(path)) return new Response('{"error":"NotFound"}', { status: 404 })
      const prefix = path === '/' ? '/' : `${path}/`
      const items = []
      for (const dir of dirs) {
        if (dir !== path && dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/')) {
          items.push({ type: 'dir', name: dir.slice(prefix.length), path: dir })
        }
      }
      for (const [file, buffer] of files) {
        if (!file.startsWith(prefix)) continue
        const name = file.slice(prefix.length)
        if (name.includes('/')) continue
        items.push({
          type: 'file',
          name,
          path: file,
          size: buffer.length,
          sha256: createHashHex(buffer),
        })
      }
      return Response.json({ _embedded: { items } })
    }

    if (parsed.pathname === '/v1/disk/resources/download') {
      return Response.json({ href: `https://dl.test${path}` })
    }

    if (parsed.pathname === '/v1/disk/resources/upload') {
      return Response.json({ href: `https://up.test${path}` })
    }

    if (parsed.pathname === '/v1/disk/resources' && method === 'PUT') {
      if (dirs.has(path)) return new Response('exists', { status: 409 })
      dirs.add(path)
      return new Response(null, { status: 201 })
    }

    if (parsed.pathname === '/v1/disk/resources' && method === 'DELETE') {
      files.delete(path)
      return new Response(null, { status: 204 })
    }

    return new Response('unexpected', { status: 500 })
  }

  return { dirs, files, handler }
}

function createHashHex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

test('бэкенд Яндекс.Диска переносит файлы и удаляет исчезнувшие', async () => {
  const disk = fakeDisk()
  globalThis.fetch = disk.handler

  const root = await mkdtemp(join(tmpdir(), 'dsh-yandex-'))
  const cacheA = join(root, 'a')
  const cacheB = join(root, 'b')
  try {
    const configA = { backend: 'yandex', repoDir: cacheA, yandexToken: 'token', yandexPath: 'dsh-sync' }
    const configB = { backend: 'yandex', repoDir: cacheB, yandexToken: 'token', yandexPath: 'dsh-sync' }

    await mkdir(join(cacheA, 'sessions', 'p', 'session-1'), { recursive: true })
    await writeFile(join(cacheA, 'sessions', 'p', 'session-1', 'session.v4.jsonl.zstd'), 'лог сессии')
    await writeFile(join(cacheA, 'projects.json'), '{"version":1}')

    const backendA = createYandexBackend(configA)
    const committed = await backendA.commit()
    assert.equal(committed.uploaded, 2)
    assert.ok(disk.files.has('/dsh-sync/sessions/p/session-1/session.v4.jsonl.zstd'))

    const backendB = createYandexBackend(configB)
    await backendB.sync()
    assert.equal(
      await readFile(join(cacheB, 'sessions', 'p', 'session-1', 'session.v4.jsonl.zstd'), 'utf8'),
      'лог сессии',
    )

    // Удалили сессию в A и отправили — на Диске её быть не должно.
    await rm(join(cacheA, 'sessions', 'p', 'session-1'), { recursive: true, force: true })
    const afterDelete = await backendA.commit()
    assert.ok(afterDelete.removed >= 1)
    assert.equal(disk.files.has('/dsh-sync/sessions/p/session-1/session.v4.jsonl.zstd'), false)

    // Повторная отправка без изменений ничего не делает.
    const idle = await backendA.commit()
    assert.equal(idle.committed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
    delete globalThis.fetch
  }
})

test('без токена бэкенд говорит об этом прямо', async () => {
  const backend = createYandexBackend({ backend: 'yandex', repoDir: tmpdir(), yandexToken: '', yandexPath: 'dsh-sync' })
  await assert.rejects(() => backend.sync(), /не задан токен/)
})

test('неверный токен даёт понятную ошибку', async () => {
  globalThis.fetch = async () => new Response('{"error":"Unauthorized"}', { status: 401 })
  const root = await mkdtemp(join(tmpdir(), 'dsh-yandex-'))
  try {
    const backend = createYandexBackend({ backend: 'yandex', repoDir: root, yandexToken: 'bad', yandexPath: 'dsh-sync' })
    await assert.rejects(() => backend.sync(), /не принял токен/)
  } finally {
    await rm(root, { recursive: true, force: true })
    delete globalThis.fetch
  }
})
