import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posix, win32 } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { canonicalCwd, defaultConfig, loadConfig, saveConfig } from '../lib/config.mjs'
import { localSessionDir, canonicalize, remapTo, splitLog } from '../lib/store.mjs'
import { pull, push } from '../lib/sync.mjs'

// --- helpers ---------------------------------------------------------------

function makeLog(header, events) {
  const frames = [zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`))]
  for (const event of events) frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  return Buffer.concat(frames)
}

function appendEvent(bytes, event) {
  return Buffer.concat([bytes, zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`))])
}

function headerFor(cwd, id = `session-${randomUUID()}`) {
  return { type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 }
}

async function writeSession(home, cwd, id, bytes) {
  const dir = localSessionDir(home, cwd, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), bytes)
  return dir
}

async function gitRun(dir, args) {
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, ...args], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(stderr))))
  })
}

async function makeEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-test-'))
  const homeA = join(root, 'home-a')
  const homeB = join(root, 'home-b')
  // Бэкенд folder: одна общая папка, как у облачного диска.
  const shared = join(root, 'shared')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  await mkdir(shared, { recursive: true })

  const projectPathA = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha'
  const projectPathB = process.platform === 'win32' ? 'D:\\projects\\alpha' : '/home/user/alpha'

  const configA = { ...defaultConfig(homeA), backend: 'folder', deviceId: 'device-a', repoDir: shared }
  configA.projects = { alpha: { path: projectPathA, title: 'alpha' } }
  const configB = { ...defaultConfig(homeB), backend: 'folder', deviceId: 'device-b', repoDir: shared }
  configB.projects = { alpha: { path: projectPathB, title: 'alpha' } }

  await saveConfig(homeA, configA)
  await saveConfig(homeB, configB)

  return { root, homeA, homeB, shared, configA, configB, projectPathA, projectPathB }
}

// --- tests -----------------------------------------------------------------

test('нейтральный путь абсолютен и на Windows, и на POSIX', () => {
  const canonical = canonicalCwd('alpha')
  assert.equal(win32.isAbsolute(canonical), true)
  assert.equal(posix.isAbsolute(canonical), true)
})

test('canonicalize и remapTo сохраняют хвост байт-в-байт', () => {
  const original = makeLog(headerFor('E:\\work\\x'), [{ type: 'a', seq: 0 }, { type: 'b', seq: 1 }])
  const canonical = canonicalize(original, 'alpha')
  const local = remapTo(canonical, '/home/user/x')

  assert.equal(splitLog(canonical).header.cwd, canonicalCwd('alpha'))
  assert.equal(splitLog(local).header.cwd, '/home/user/x')
  assert.deepEqual(splitLog(canonical).tail, splitLog(original).tail)
  assert.deepEqual(splitLog(local).tail, splitLog(original).tail)
})

test('push и pull переносят сессию на другой путь', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const log = makeLog(headerFor(env.projectPathA, id), [{ type: 'text', seq: 0 }])
    await writeSession(env.homeA, env.projectPathA, id, log)

    await push({ home: env.homeA, config: env.configA })
    const mirrored = await readFile(join(env.configA.repoDir, 'sessions', 'alpha', id, 'session.v4.jsonl.zstd'))
    assert.equal(splitLog(mirrored).header.cwd, canonicalCwd('alpha'))

    const result = await pull({ home: env.homeB, config: env.configB })
    assert.equal(result.imported, 1)

    const importedPath = join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd')
    const imported = await readFile(importedPath)
    assert.equal(splitLog(imported).header.cwd, env.projectPathB)
    assert.deepEqual(splitLog(imported).tail, splitLog(log).tail)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('дописанные события приезжают fast-forward без конфликта', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const base = makeLog(headerFor(env.projectPathA, id), [{ type: 'text', seq: 0 }])
    await writeSession(env.homeA, env.projectPathA, id, base)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    const appended = appendEvent(base, { type: 'text', seq: 1, from: 'A' })
    await writeSession(env.homeA, env.projectPathA, id, appended)
    await push({ home: env.homeA, config: env.configA })

    const result = await pull({ home: env.homeB, config: env.configB })
    assert.equal(result.updated, 1)
    assert.equal(result.conflicts, 0)

    const local = await readFile(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd'))
    assert.deepEqual(splitLog(local).tail, splitLog(appended).tail)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('расхождение сохраняет обе стороны: локальная остаётся, удалённая приезжает fork-сессией', async () => {
  const env = await makeEnvironment()
  try {
    const id = `session-${randomUUID()}`
    const base = makeLog(headerFor(env.projectPathA, id), [{ type: 'text', seq: 0 }])
    await writeSession(env.homeA, env.projectPathA, id, base)
    await push({ home: env.homeA, config: env.configA })
    await pull({ home: env.homeB, config: env.configB })

    // обе стороны дописали разное
    const fromA = appendEvent(base, { type: 'text', seq: 1, from: 'A' })
    const fromB = appendEvent(base, { type: 'text', seq: 1, from: 'B' })
    await writeSession(env.homeA, env.projectPathA, id, fromA)
    await writeSession(env.homeB, env.projectPathB, id, fromB)
    await push({ home: env.homeA, config: env.configA })

    const result = await pull({ home: env.homeB, config: env.configB })
    assert.equal(result.conflicts, 1)
    assert.equal(result.forkIds.length, 1)

    const localKept = await readFile(join(localSessionDir(env.homeB, env.projectPathB, id), 'session.v4.jsonl.zstd'))
    assert.deepEqual(splitLog(localKept).tail, splitLog(fromB).tail)

    const forkId = result.forkIds[0].to
    const fork = await readFile(join(localSessionDir(env.homeB, env.projectPathB, forkId), 'session.v4.jsonl.zstd'))
    assert.equal(splitLog(fork).header.id, forkId)
    assert.equal(splitLog(fork).header.cwd, env.projectPathB)
    assert.deepEqual(splitLog(fork).tail, splitLog(fromA).tail)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})

test('лог без сжатия (JSONL) тоже переносится', () => {
  const header = headerFor(process.platform === 'win32' ? 'C:\\work\\plain' : '/work/plain')
  const plain = Buffer.from(`${JSON.stringify(header)}\n${JSON.stringify({ seq: 0 })}\n${JSON.stringify({ seq: 1 })}\n`)
  const canonical = canonicalize(plain, 'alpha')
  const parsed = splitLog(canonical)

  assert.equal(parsed.header.cwd, canonicalCwd('alpha'))
  assert.equal(parsed.plain, true)
  assert.deepEqual(parsed.tail, plain.subarray(plain.indexOf(0x0a) + 1))

  const back = remapTo(canonical, process.platform === 'win32' ? 'D:\\plain' : '/home/user/plain')
  assert.equal(splitLog(back).header.cwd, process.platform === 'win32' ? 'D:\\plain' : '/home/user/plain')
  assert.deepEqual(splitLog(back).tail, parsed.tail)
})

test('push удаляет из зеркала сессии, удалённые локально', async () => {
  const env = await makeEnvironment()
  try {
    const keep = `session-${randomUUID()}`
    const drop = `session-${randomUUID()}`
    await writeSession(env.homeA, env.projectPathA, keep, makeLog(headerFor(env.projectPathA, keep), [{ seq: 0 }]))
    const dropDir = await writeSession(env.homeA, env.projectPathA, drop, makeLog(headerFor(env.projectPathA, drop), [{ seq: 0 }]))
    await push({ home: env.homeA, config: env.configA })
    assert.equal(existsSync(join(env.configA.repoDir, 'sessions', 'alpha', drop, 'session.v4.jsonl.zstd')), true)

    await rm(dropDir, { recursive: true, force: true })
    const result = await push({ home: env.homeA, config: env.configA })
    assert.equal(result.removed, 1)
    assert.equal(existsSync(join(env.configA.repoDir, 'sessions', 'alpha', drop, 'session.v4.jsonl.zstd')), false)
    assert.equal(existsSync(join(env.configA.repoDir, 'sessions', 'alpha', keep, 'session.v4.jsonl.zstd')), true)
  } finally {
    await rm(env.root, { recursive: true, force: true })
  }
})
