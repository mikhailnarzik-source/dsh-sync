/**
 * Тонкая обёртка над git. Зеркало — рабочее дерево, которое считается
 * производным: перед каждой операцией оно приводится к состоянию удалённой
 * ветки, локальных коммитов там не бывает.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Вывод git собираем через временные файлы, а не через pipe: так вызов
// одинаково работает и в обычной консоли, и под песочницей, где программы
// не могут открывать именованные каналы.
async function runCapture(args, cwd) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-git-'))
  const outPath = join(dir, 'out')
  const errPath = join(dir, 'err')
  const out = await open(outPath, 'w')
  const err = await open(errPath, 'w')
  try {
    const code = await new Promise((resolvePromise) => {
      const child = spawn('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', out.fd, err.fd],
        windowsHide: true,
      })
      child.on('error', error => resolvePromise({ code: -1, message: String(error.message) }))
      child.on('close', exitCode => resolvePromise({ code: exitCode }))
    })
    const [stdout, stderr] = await Promise.all([readFile(outPath, 'utf8'), readFile(errPath, 'utf8')])
    return { code: code.code, stdout, stderr: code.message ?? stderr }
  } finally {
    await out.close().catch(() => {})
    await err.close().catch(() => {})
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// Тесты подменяют исполнителя, чтобы проверять последовательность команд на
// машине, где запуск настоящего git недоступен (например, под песочницей).
let runnerOverride = null

export function __setRunnerForTest(fn) {
  runnerOverride = fn
}

export async function git(repoDir, args, { allowFailure = false } = {}) {
  const runner = runnerOverride ?? runCapture
  const result = await runner(['-C', repoDir, ...args], repoDir)
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} → ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result
}

export async function ensureRepo({ repoDir, branch = 'main' }) {
  if (!existsSync(repoDir)) {
    await mkdir(repoDir, { recursive: true })
    await git(repoDir, ['init', '-b', branch])
  }
}

export async function setRemote(repoDir, remote) {
  const current = await git(repoDir, ['remote', 'get-url', 'origin'], { allowFailure: true })
  if (current.code === 0) {
    if (current.stdout.trim() !== remote) await git(repoDir, ['remote', 'set-url', 'origin', remote])
    return
  }
  await git(repoDir, ['remote', 'add', 'origin', remote])
}

/** Состояние удалённой ветки; false — если ветки/римоута ещё нет. */
export async function fetchRemote(repoDir, branch) {
  const fetched = await git(repoDir, ['fetch', '--quiet', 'origin', branch], { allowFailure: true })
  if (fetched.code !== 0) return false
  const reset = await git(repoDir, ['reset', '--hard', '--quiet', 'FETCH_HEAD'], { allowFailure: true })
  return reset.code === 0
}

export async function hasChanges(repoDir) {
  const status = await git(repoDir, ['status', '--porcelain'])
  return status.stdout.trim() !== ''
}

/**
 * Закоммитить и отправить изменения.
 *
 * Проверяем не «есть ли изменения в рабочем дереве», а «есть ли что-то в
 * индексе после `add -A`: на Windows `status` показывает файлы из-за разницы
 * переводов строк, а после нормализации коммитить нечего — тогда коммит падал
 * с «nothing to commit».
 */
export async function commitAndPush({ repoDir, branch, message, name = 'dsh-sync', email = 'dsh-sync@localhost' }) {
  await git(repoDir, ['add', '-A'])
  const staged = await git(repoDir, ['diff', '--cached', '--name-only'])
  if (staged.stdout.trim() === '') return { committed: false, pushed: false }

  const commit = await git(repoDir, ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '--quiet', '-m', message], { allowFailure: true })
  if (commit.code !== 0) {
    // Гонка с внешним изменением: коммитить больше нечего — это не ошибка.
    if (/nothing to commit|no changes added/i.test(`${commit.stdout}${commit.stderr}`)) {
      return { committed: false, pushed: false }
    }
    throw new Error(`git commit → ${commit.code}: ${commit.stderr.trim() || commit.stdout.trim()}`)
  }

  const pushed = await git(repoDir, ['push', '--quiet', 'origin', `HEAD:${branch}`], { allowFailure: true })
  if (pushed.code !== 0) {
    throw new Error(`git push отклонён: ${pushed.stderr.trim()} (сначала выполните pull)`)
  }
  return { committed: true, pushed: true }
}
