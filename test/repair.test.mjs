import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { frameSlices, decodeFrame, encodeFrame } from '../lib/frames.mjs'
import { repairLog } from '../lib/repair.mjs'
import { remapTo } from '../lib/store.mjs'

function buildLog(id, cwd, events) {
  const header = { type: 'session', version: 4, id, createdAt: 1793000000000, cwd, isSeeded: false, delegationDepth: 0 }
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    ...events.map(event => encodeFrame(`${JSON.stringify(event)}\n`)),
  ])
}

function markers(bytes) {
  const slices = frameSlices(bytes)
  let header
  const found = []
  for (let index = 0; index < slices.length; index++) {
    const text = decodeFrame(bytes, slices[index][0], slices[index][1])
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (header === undefined) {
        header = event
        continue
      }
      if (event.type === 'session-log-deepseek/delivery-accepted') found.push(event.data.sessionId)
    }
  }
  return { header, found }
}

test('копия с новым id получает исправленные события', () => {
  const originalId = `session-${randomUUID()}`
  const bytes = buildLog(originalId, 'C:\\work\\a', [
    { type: 'user/message', seq: 1, data: { text: 'привет' } },
    { type: 'session-log-deepseek/delivery-accepted', seq: 2, data: { sessionId: originalId, sessionFormatVersion: 4 } },
  ])

  const forkId = `session-${randomUUID()}`
  const fork = remapTo(bytes, 'C:\\work\\b', { id: forkId })

  // До починки: заголовок уже новый, а событие всё ещё называет исходную сессию.
  assert.equal(markers(fork).header.id, forkId)
  assert.deepEqual(markers(fork).found, [originalId])

  const repaired = repairLog(fork)
  assert.equal(repaired.changed, 1)
  assert.deepEqual(markers(repaired.bytes).found, [forkId])
  assert.equal(markers(repaired.bytes).header.id, forkId)
})

test('целый лог не меняется', () => {
  const id = `session-${randomUUID()}`
  const bytes = buildLog(id, 'C:\\work\\a', [
    { type: 'session-log-deepseek/delivery-accepted', seq: 1, data: { sessionId: id, sessionFormatVersion: 4 } },
  ])
  const result = repairLog(bytes)
  assert.equal(result.changed, 0)
  assert.deepEqual(result.bytes, bytes)
})

test('наследие родительской сессии не переписывается', () => {
  const id = `session-${randomUUID()}`
  const parent = `session-${randomUUID()}`
  const header = { type: 'session', version: 4, id, parentSession: parent, createdAt: 1793000000000, cwd: 'C:\\work\\a', isSeeded: false, delegationDepth: 1 }
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
    encodeFrame(`${JSON.stringify({ type: 'session-log-deepseek/delivery-accepted', seq: 0, data: { sessionId: parent, sessionFormatVersion: 4, inheritedEventCount: 5 } })}\n`),
  ])

  const result = repairLog(bytes)
  assert.equal(result.changed, 0)
  assert.deepEqual(markers(result.bytes).found, [parent])
})
