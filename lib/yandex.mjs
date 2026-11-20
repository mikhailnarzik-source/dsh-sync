/**
 * Бэкенд Яндекс.Диска через REST API — без установленного клиента.
 *
 * Работает как «папка, которая живёт в облаке»: локальный каталог
 * (`repoDir`) служит кешем, а перед приёмом мы догружаем изменения из Диска и
 * после отправки загружаем свои. Файлы сравниваются по sha256, поэтому
 * лишнего трафика нет.
 *
 * Токен: OAuth пользователя с доступом к Диску. Берётся из настроек плагина
 * или из переменной окружения YANDEX_DISK_TOKEN.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

const API_BASE = 'https://cloud-api.yandex.net/v1/disk'
const TIMEOUT_MS = 30_000
const CONCURRENCY = 4

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function toRemotePath(root, rel) {
  const clean = rel.split(sep).join('/')
  return `${root.replace(/\/+$/, '')}/${clean}`.replace(/\/{2,}/g, '/')
}

async function walkFiles(dir, base, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Служебные каталоги локального кеша в облако не отправляем.
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      await walkFiles(absolute, base, out)
    }
    else if (entry.isFile()) out.push({ absolute, rel: relative(base, absolute).split(sep).join('/') })
  }
}

async function mapLimit(items, limit, worker) {
  const queue = [...items]
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(runners)
}

/**
 * Создать бэкенд Яндекс.Диска.
 * @param config поля: repoDir (локальный кеш), yandexToken, yandexPath (папка на Диске)
 */
export function createYandexBackend(config) {
  const token = (config.yandexToken ?? process.env.YANDEX_DISK_TOKEN ?? '').trim()
  const root = `/${(config.yandexPath ?? 'dsh-sync').replace(/^\/+|\/+$/g, '')}`

  const request = async (path, init = {}) => {
    if (token === '') throw new Error('не задан токен Яндекс.Диска')
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `OAuth ${token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return response
  }

  const json = async (path) => {
    const response = await request(path)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) throw new Error('Яндекс.Диск не принял токен (401)')
      throw new Error(`Яндекс.Диск: HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    return response.json()
  }

  /** Все файлы Диска под корнем: rel → { size, sha256 }. */
  const listRemote = async () => {
    const files = new Map()
    const walk = async (remotePath) => {
      let payload
      try {
        payload = await json(`/resources?path=${encodeURIComponent(remotePath)}&limit=1000&sort=name`)
      } catch (error) {
        // 404 — папки ещё нет, это нормально для первой синхронизации
        if (String(error.message).includes('404')) return
        throw error
      }
      const items = payload?._embedded?.items ?? []
      for (const item of items) {
        if (item.type === 'dir') await walk(item.path)
        else if (item.type === 'file') {
          const rel = item.path.replace(`${root}/`, '').replace(/^\/+/, '')
          if (rel !== '') files.set(rel, { size: item.size ?? 0, sha256: item.sha256 ?? null })
        }
      }
    }
    await walk(root)
    return files
  }

  const ensureRemoteDir = async (relDir) => {
    const parts = relDir.split('/').filter(Boolean)
    let current = root
    for (const part of parts) {
      current = `${current}/${part}`
      const response = await request(`/resources?path=${encodeURIComponent(current)}`, { method: 'PUT' })
      // 409 — папка уже есть
      if (!response.ok && response.status !== 409) {
        const text = await response.text().catch(() => '')
        throw new Error(`Яндекс.Диск: не удалось создать папку ${current} (${response.status}) ${text.slice(0, 120)}`)
      }
    }
  }

  const download = async (rel) => {
    const meta = await json(`/resources/download?path=${encodeURIComponent(toRemotePath(root, rel))}`)
    const response = await fetch(meta.href, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск: не удалось скачать ${rel} (${response.status})`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const target = join(config.repoDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
  }

  const upload = async (rel, absolute) => {
    const meta = await json(`/resources/upload?path=${encodeURIComponent(toRemotePath(root, rel))}&overwrite=true`)
    const buffer = await readFile(absolute)
    const response = await fetch(meta.href, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск: не удалось загрузить ${rel} (${response.status})`)
  }

  return {
    kind: 'yandex',

    /** Диск → локальный кеш: догружаем новое и изменённое. */
    async sync() {
      const remote = await listRemote()
      const toDownload = []
      for (const [rel, meta] of remote) {
        const target = join(config.repoDir, ...rel.split('/'))
        let local = null
        try {
          local = await stat(target)
        } catch {
          local = null
        }
        if (local === null || local.size !== meta.size) toDownload.push(rel)
      }
      await mapLimit(toDownload, CONCURRENCY, (rel) => download(rel))
      return true
    },

    /** Локальный кеш → Диск: загружаем изменённое, удаляем исчезнувшее. */
    async commit() {
      const remote = await listRemote()
      const local = []
      await walkFiles(config.repoDir, config.repoDir, local)

      let uploaded = 0
      const dirs = new Set()
      for (const file of local) {
        const meta = remote.get(file.rel)
        if (meta !== undefined) {
          const buffer = await readFile(file.absolute)
          if (meta.sha256 === sha256(buffer)) continue
        }
        const dir = file.rel.split('/').slice(0, -1).join('/')
        if (dir !== '' && !dirs.has(dir)) {
          await ensureRemoteDir(dir)
          dirs.add(dir)
        }
        await upload(file.rel, file.absolute)
        uploaded += 1
      }

      let removed = 0
      if (local.length === 0 && remote.size > 0) return { committed: false, uploaded, removed: 0, warning: 'локальный кеш пуст — удаление на Диске пропущено' }
      const localSet = new Set(local.map(file => file.rel))
      for (const rel of remote.keys()) {
        if (localSet.has(rel)) continue
        const response = await request(`/resources?path=${encodeURIComponent(toRemotePath(root, rel))}&permanently=true`, { method: 'DELETE' })
        if (response.ok || response.status === 404) removed += 1
      }

      return { committed: uploaded > 0 || removed > 0, uploaded, removed }
    },
  }
}

/** Проверка доступа: список корневой папки и её создание при необходимости. */
export async function probeYandex(config) {
  const backend = createYandexBackend(config)
  try {
    await backend.sync()
    return { ok: true, message: 'доступ к Яндекс.Диску подтверждён' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
