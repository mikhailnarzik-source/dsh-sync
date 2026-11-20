import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWebdavBackend, parsePropfind } from '../lib/webdav.mjs'

/** Поддельный WebDAV: дерево в памяти, ответы PROPFIND в формате Яндекса. */
function fakeWebdav() {
  const files = new Map() // '/dsh-sync/a/b' -> Buffer
  const dirs = new Set(['/dsh-sync'])

  const handler = async (url, init = {}) => {
    const parsed = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const path = decodeURIComponent(parsed.pathname)

    if (!String(init.headers?.authorization ?? '').startsWith('Basic ')) {
      return new Response('unauthorized', { status: 401 })
    }
    const decoded = Buffer.from(String(init.headers.authorization).slice(6), 'base64').toString('utf8')
    if (decoded !== 'user:app-pass') return new Response('unauthorized', { status: 401 })

    if (method === 'PROPFIND') {
      const target = path.replace(/\/+$/, '') || '/'
      if (!dirs.has(target)) return new Response('not found', { status: 404 })
      const prefix = target === '/' ? '/' : `${target}/`
      const parts = ['<d:response><d:href>/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>']
      // сам каталог
      parts.push(`<d:response><d:href>${target}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`)
      for (const dir of dirs) {
        if (dir === target || !dir.startsWith(prefix)) continue
        if (dir.slice(prefix.length).includes('/')) continue
        parts.push(`<d:response><d:href>${dir}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`)
      }
      for (const [file, buffer] of files) {
        if (!file.startsWith(prefix)) continue
        if (file.slice(prefix.length).includes('/')) continue
        parts.push(`<d:response><d:href>${file}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${buffer.length}</d:getcontentlength><d:getlastmodified>Fri, 20 Nov 2026 09:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>`)
      }
      return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${parts.join('')}</d:multistatus>`, { status: 207 })
    }

    if (method === 'PUT') {
      files.set(path, Buffer.from(init.body))
      return new Response(null, { status: 201 })
    }

    if (method === 'GET') {
      const buffer = files.get(path)
      if (buffer === undefined) return new Response('not found', { status: 404 })
      return new Response(buffer, { status: 200 })
    }

    if (method === 'MKCOL') {
      const target = path.replace(/\/+$/, '')
      if (dirs.has(target)) return new Response(null, { status: 405 })
      dirs.add(target)
      return new Response(null, { status: 201 })
    }

    if (method === 'DELETE') {
      files.delete(path)
      return new Response(null, { status: 204 })
    }

    return new Response('unexpected', { status: 500 })
  }

  return { dirs, files, handler }
}

test('разбор PROPFIND: файлы, каталоги и корень', () => {
  const xml = '<d:multistatus xmlns:d="DAV:">' +
    '<d:response><d:href>/dsh-sync/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
    '<d:response><d:href>/dsh-sync/a.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength></d:prop></d:propstat></d:response>' +
    '</d:multistatus>'
  const items = parsePropfind(xml, '/dsh-sync')
  assert.equal(items.length, 1)
  assert.equal(items[0].href, '/dsh-sync/a.txt')
  assert.equal(items[0].size, 12)
})

test('WebDAV переносит файлы и удаляет исчезнувшие', async () => {
  const disk = fakeWebdav()
  globalThis.fetch = disk.handler

  const root = await mkdtemp(join(tmpdir(), 'dsh-webdav-'))
  const cacheA = join(root, 'a')
  const cacheB = join(root, 'b')
  try {
    const base = { backend: 'webdav', webdavLogin: 'user', webdavPassword: 'app-pass', webdavPath: 'dsh-sync' }

    await mkdir(join(cacheA, 'sessions', 'p', 'session-1'), { recursive: true })
    await writeFile(join(cacheA, 'sessions', 'p', 'session-1', 'session.v4.jsonl.zstd'), 'лог')
    await writeFile(join(cacheA, 'projects.json'), '{}')

    const backendA = createWebdavBackend({ ...base, repoDir: cacheA })
    const uploaded = await backendA.commit()
    assert.equal(uploaded.uploaded, 2)
    assert.ok(disk.files.has('/dsh-sync/sessions/p/session-1/session.v4.jsonl.zstd'))

    const backendB = createWebdavBackend({ ...base, repoDir: cacheB })
    await backendB.sync()
    assert.equal(await readFile(join(cacheB, 'sessions', 'p', 'session-1', 'session.v4.jsonl.zstd'), 'utf8'), 'лог')

    await rm(join(cacheA, 'sessions', 'p', 'session-1'), { recursive: true, force: true })
    const removed = await backendA.commit()
    assert.ok(removed.removed >= 1)
    assert.equal(disk.files.has('/dsh-sync/sessions/p/session-1/session.v4.jsonl.zstd'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    delete globalThis.fetch
  }
})

test('неверный пароль приложения даёт понятную ошибку', async () => {
  const disk = fakeWebdav()
  globalThis.fetch = disk.handler
  const root = await mkdtemp(join(tmpdir(), 'dsh-webdav-'))
  try {
    const backend = createWebdavBackend({ backend: 'webdav', repoDir: root, webdavLogin: 'user', webdavPassword: 'bad', webdavPath: 'dsh-sync' })
    await assert.rejects(() => backend.sync(), /не принял логин или пароль/)
  } finally {
    await rm(root, { recursive: true, force: true })
    delete globalThis.fetch
  }
})
