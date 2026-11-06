/**
 * dsh-sync — переносимый между устройствами формат сессий.
 *
 * В зеркале каждая сессия лежит с нейтральным абсолютным путём
 * `/dsh-sync/projects/<projectId>`: он считается абсолютным и на Windows
 * (win32.isAbsolute("/x") === true), и на POSIX. На устройстве путь
 * подставляется локальный — тем же приёмом, что и в session-remap.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, platform } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'

export const CONFIG_FILE = 'dsh-sync.json'

export function resolveDshHome(cliHome) {
  if (cliHome) return resolve(cliHome)
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

export function defaultConfig(home) {
  return {
    version: 1,
    deviceId: `device-${createHash('sha256').update(`${platform()}-${homedir()}-${Date.now()}`).digest('hex').slice(0, 12)}`,
    backend: 'git',
    repoDir: join(home, 'dsh-sync', 'repo'),
    remote: '',
    branch: 'main',
    attachments: false,
    useExternal: true,
    autoSync: {
      enabled: true,
      pullOnStart: true,
      pushOnChange: true,
      pushMinIntervalMinutes: 5,
      pullIntervalMinutes: 15,
    },
    projects: {},
  }
}

export async function loadConfig(home) {
  const path = join(home, CONFIG_FILE)
  if (!existsSync(path)) {
    const config = defaultConfig(home)
    await saveConfig(home, config)
    return config
  }
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (config === null || typeof config !== 'object') throw new Error(`битый конфиг: ${path}`)
  config.projects ??= {}
  return config
}

export async function saveConfig(home, config) {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

/** Идентификатор проекта: стабильный, безопасный для пути. */
export function normalizeProjectId(raw) {
  const id = String(raw).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (id === '' || id === '.' || id === '..') throw new Error(`недопустимый id проекта: ${raw}`)
  return id
}

/** Нейтральный абсолютный путь, одинаково валидный на Windows и POSIX. */
export function canonicalCwd(projectId) {
  return `/dsh-sync/projects/${projectId}`
}

export function newId() {
  return randomUUID()
}
