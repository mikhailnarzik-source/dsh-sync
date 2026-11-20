import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

import { sanitizeLog } from '../lib/sync.mjs'
import { splitLog } from '../lib/store.mjs'
import { acquireLock } from '../lib/lock.mjs'

function sessionLog(events) {
  const header = { type: 'session', version: 4, id: `session-${randomUUID()}`, createdAt: Date.now(), cwd: 'C:\\work\\x', isSeeded: false, delegationDepth: 0 }
  return {
    header,
    bytes: Buffer.concat([
      zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
      ...events.map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))),
    ]),
  }
}

test('недописанный последний кадр отрезается перед отправкой', () => {
  const { bytes } = sessionLog([{ seq: 0 }, { seq: 1 }])
  const partial = Buffer.concat([bytes, zstdCompressSync(Buffer.from('{"seq":2}\n')).subarray(0, 9)])

  const clean = sanitizeLog(partial)
  assert.ok(clean.dropped > 0, 'частичный хвост должен быть отброшен')
  assert.deepEqual(splitLog(clean.bytes).tail, splitLog(bytes).tail, 'полные кадры сохраняются')
})

test('целый лог не меняется', () => {
  const { bytes } = sessionLog([{ seq: 0 }, { seq: 1 }])
  const clean = sanitizeLog(bytes)
  assert.equal(clean.dropped, 0)
  assert.deepEqual(clean.bytes, bytes)
})

test('лок не даёт двум процессам войти одновременно', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  try {
    const first = await acquireLock(dir, 'test-1')
    assert.ok(first !== undefined, 'первый лок берётся')

    const second = await acquireLock(dir, 'test-2')
    assert.equal(second, undefined, 'второй получает отказ')

    await first.release()
    const third = await acquireLock(dir, 'test-3')
    assert.ok(third !== undefined, 'после освобождения лок снова доступен')
    await third.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('зависший лок старше порога снимается', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-lock-'))
  try {
    const path = join(dir, 'sync.lock')
    await mkdir(path)
    await writeFile(join(path, 'owner.json'), `${JSON.stringify({ pid: 1, at: Date.now() - 60 * 60_000, owner: 'dead' })}\n`)

    const lock = await acquireLock(dir, 'test')
    assert.ok(lock !== undefined, 'устаревший лок не блокирует')
    await lock.release()
    assert.equal(existsSync(path), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
