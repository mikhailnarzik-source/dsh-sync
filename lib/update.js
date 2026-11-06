/**
 * Самопроверка версии dsh-sync.
 *
 * Плагин установлен из GitHub и pnpm закрепил конкретный коммит. Этот модуль
 * сравнивает его с текущим `main` и, по явному действию пользователя, просит
 * штатный менеджер плагинов переустановить пакет. Сам себя он не обновляет.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Репозиторий, из которого ставится плагин. */
export const UPDATE_REPOSITORY = 'mikhailnarzik-source/dsh-sync'
/** Спека установки — единственная, которую разрешено применять. */
export const UPDATE_SPEC = `github:${UPDATE_REPOSITORY}`
/** Имя пакета в профиле. */
export const UPDATE_NAME = 'dsh-sync'

const BRANCH = 'main'
const MAX_LOCK_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 8_000

let state = { status: 'unknown', installed: null, latest: null, message: '', date: '', detail: '' }
let scheduled = false

/** Короткая форма коммита. */
function short(sha) {
  return sha === null || sha === undefined ? '?' : String(sha).slice(0, 7)
}

/** Текущее состояние проверки. */
export function updateState() {
  return state
}

/** Строка для карточки. */
export function describeUpdate() {
  if (state.status === 'current') return `обновление не требуется (${short(state.installed)})`
  if (state.status === 'behind') return `доступно обновление: ${short(state.installed)} → ${short(state.latest)}`
  if (state.status === 'error') return `проверка не удалась: ${state.detail}`
  return 'проверка ещё не выполнялась'
}

/** Путь к lockfile профиля рядом с этим пакетом. */
function lockfilePath() {
  try {
    const here = fileURLToPath(import.meta.url)
    const packageDir = path.dirname(path.dirname(here))
    const profileDir = path.dirname(path.dirname(packageDir))
    const candidate = path.join(profileDir, 'pnpm-lock.yaml')
    if (fs.existsSync(candidate)) return candidate
  } catch {
    // переход к запасному пути
  }
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const fallback = path.join(home, 'profiles', 'desktop', 'pnpm-lock.yaml')
  return fs.existsSync(fallback) ? fallback : undefined
}

/** Коммит, закреплённый pnpm за этим пакетом. */
function installedCommit() {
  const lock = lockfilePath()
  if (lock === undefined) return null
  const stat = fs.statSync(lock)
  if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return null
  const text = fs.readFileSync(lock, 'utf8')
  const pattern = new RegExp(
    `${UPDATE_NAME}:[\\s\\S]{0,240}?codeload\\.github\\.com/${UPDATE_REPOSITORY}/tar\\.gz/([0-9a-f]{40})`,
  )
  const match = pattern.exec(text)
  return match === null ? null : match[1]
}

/**
 * Сравнить установленный коммит с `main`.
 * @param resolveToken - необязательный провайдер токена GitHub.
 * @returns новое состояние.
 */
export async function checkForUpdate(resolveToken) {
  try {
    const installed = installedCommit()
    if (installed === null) {
      state = { ...state, status: 'unknown', detail: 'коммит не найден в lockfile' }
      return state
    }
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-sync/update-check' }
    const token = typeof resolveToken === 'function' ? await resolveToken() : undefined
    if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`

    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/commits/${BRANCH}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      state = { ...state, status: 'error', installed, detail: `HTTP ${response.status}` }
      return state
    }
    const data = await response.json()
    const latest = data.sha
    const message = String(data.commit?.message ?? '').split('\n')[0].slice(0, 120)
    const date = String(data.commit?.committer?.date ?? '')
    state = latest === installed
      ? { status: 'current', installed, latest, message, date, detail: '' }
      : { status: 'behind', installed, latest, message, date, detail: '' }
    return state
  } catch (error) {
    state = { ...state, status: 'error', detail: String(error?.message ?? error).slice(0, 160) }
    return state
  }
}

/**
 * Запросить переустановку через штатный менеджер плагинов.
 *
 * Плагин при этом снимается, поэтому работа планируется после ответа: сначала
 * уходит HTTP-ответ, затем пакет удаляется и ставится заново.
 * @param ctx - контекст плагина.
 * @returns `{ started, reason }`.
 */
export function applyUpdate(ctx) {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) return { started: false, reason: 'менеджер плагинов недоступен' }
  if (scheduled) return { started: false, reason: 'обновление уже запущено' }
  if (state.status !== 'behind') return { started: false, reason: 'обновление не требуется' }

  scheduled = true
  setTimeout(() => {
    void (async () => {
      try {
        await manager.removeBundle(UPDATE_NAME)
        await manager.installBundle(UPDATE_SPEC, { enabled: true })
      } catch (error) {
        console.error('[dsh-sync] self-update failed:', error?.message ?? error)
      }
    })()
  }, 150)

  return { started: true, reason: 'обновление запущено' }
}
