import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __setRunnerForTest, commitAndPush, ensureRepo, fetchRemote, git, setRemote } from '../lib/git.mjs'

function recorder(responses = {}) {
  const calls = []
  const runner = async (args) => {
    calls.push(args.join(' '))
    for (const [pattern, value] of Object.entries(responses)) {
      if (args.join(' ').includes(pattern)) return typeof value === 'function' ? value(args) : value
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { calls, runner }
}

test('git: инициализация, remote, fetch и коммит идут в нужном порядке', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    const { calls, runner } = recorder({
      'remote get-url origin': { code: 128, stdout: '', stderr: 'no such remote' },
      'status --porcelain': { code: 0, stdout: ' M sessions/alpha/x\n', stderr: '' },
    })
    __setRunnerForTest(runner)

    const repoDir = join(root, 'repo')
    await ensureRepo({ repoDir, branch: 'main' })
    await setRemote(repoDir, 'git@github.com:me/sessions.git')
    await fetchRemote(repoDir, 'main')
    const result = await commitAndPush({ repoDir, branch: 'main', message: 'test' })

    assert.equal(result.committed, true)
    assert.equal(result.pushed, true)
    assert.deepEqual(calls.map(call => `git ${call}`), [
      'git -C ' + repoDir + ' init -b main',
      'git -C ' + repoDir + ' remote get-url origin',
      'git -C ' + repoDir + ' remote add origin git@github.com:me/sessions.git',
      'git -C ' + repoDir + ' fetch --quiet origin main',
      'git -C ' + repoDir + ' reset --hard --quiet FETCH_HEAD',
      'git -C ' + repoDir + ' status --porcelain',
      'git -C ' + repoDir + ' add -A',
      'git -C ' + repoDir + ' -c user.name=dsh-sync -c user.email=dsh-sync@localhost commit --quiet -m test',
      'git -C ' + repoDir + ' push --quiet origin HEAD:main',
    ])
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: без изменений коммит не создаётся', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    const { calls, runner } = recorder({ 'status --porcelain': { code: 0, stdout: '', stderr: '' } })
    __setRunnerForTest(runner)
    const repoDir = join(root, 'repo')
    await ensureRepo({ repoDir, branch: 'main' })
    const result = await commitAndPush({ repoDir, branch: 'main', message: 'empty' })
    assert.equal(result.committed, false)
    assert.equal(calls.some(call => call.includes('commit')), false)
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: отклонённый push сообщает о необходимости pull', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-git-test-'))
  try {
    const { runner } = recorder({
      'status --porcelain': { code: 0, stdout: ' M x\n', stderr: '' },
      'push --quiet': { code: 1, stdout: '', stderr: 'rejected: non-fast-forward' },
    })
    __setRunnerForTest(runner)
    const repoDir = join(root, 'repo')
    await ensureRepo({ repoDir, branch: 'main' })
    await assert.rejects(() => commitAndPush({ repoDir, branch: 'main', message: 'x' }), /сначала выполните pull/)
  } finally {
    __setRunnerForTest(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('git: allowFailure возвращает код вместо исключения', async () => {
  __setRunnerForTest(async () => ({ code: 1, stdout: '', stderr: 'boom' }))
  try {
    const result = await git('.', ['status'], { allowFailure: true })
    assert.equal(result.code, 1)
    await assert.rejects(() => git('.', ['status']), /boom/)
  } finally {
    __setRunnerForTest(null)
  }
})
