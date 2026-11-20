/**
 * Бэкенд Яндекс.Диска по WebDAV — без регистрации приложения.
 *
 * Достаточно логина и «пароля приложения» (id.yandex.ru → Безопасность →
 * Пароли приложений → Файлы). WebDAV отдаёт список файлов, размер и дату
 * изменения; этого хватает, чтобы держать локальный кеш в актуальном виде.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

const BASE = 'https://webdav.yandex.ru'
const TIMEOUT_MS = 180_000
const TRANSFER_TIMEOUT_MS = 20 * 60_000
const CONCURRENCY = 1
const MIN_GAP_MS = 400
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'

async function walkFiles(dir, base, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) await walkFiles(absolute, base, out)
    else if (entry.isFile()) out.push({ absolute, rel: relative(base, absolute).split(sep).join('/') })
  }
}

async function mapLimit(items, limit, worker) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        await worker(item)
      }
    }),
  )
}

/** Разобрать XML-ответ PROPFIND в плоский список. */
export function parsePropfind(xml, basePath) {
  const items = []
  for (const match of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const block = match[1]
    const hrefMatch = /<d:href>([^<]+)<\/d:href>/.exec(block)
    if (hrefMatch === null) continue
    const href = decodeURIComponent(hrefMatch[1])
    const isDir = /<d:collection\s*\/>/.test(block)
    const size = Number(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(block)?.[1] ?? 0)
    const modified = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(block)?.[1] ?? ''
    if (href.replace(/\/+$/, '') === basePath.replace(/\/+$/, '')) continue
    items.push({ href: href.replace(/\/+$/, ''), isDir, size, modified })
  }
  return items
}

/**
 * Создать WebDAV-бэкенд.
 * @param config поля: repoDir (локальный кеш), webdavLogin, webdavPassword, webdavPath
 */
export function createWebdavBackend(config) {
  const login = (config.webdavLogin ?? '').trim()
  const password = (config.webdavPassword ?? '').trim()
  const root = `/${(config.webdavPath ?? 'dsh-sync').replace(/^\/+|\/+$/g, '')}`

  const auth = () => `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`

  let lastRequestAt = 0
  const pause = async (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const throttle = async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await pause(wait)
    lastRequestAt = Date.now()
  }

  const request = async (path, init = {}) => {
    if (login === '' || password === '') throw new Error('не заданы логин и пароль приложения Яндекс.Диска')
    const send = () =>
      fetch(`${BASE}${encodeURI(path)}`, {
        ...init,
        headers: { authorization: auth(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(init.signal === undefined ? TIMEOUT_MS : TRANSFER_TIMEOUT_MS),
      })

    // Яндекс ограничивает частоту запросов (429) и иногда отвечает 503:
    // повторяем с паузой, уважая Retry-After.
    await throttle()
    let response = await send()
    for (let attempt = 0; attempt < 4 && (response.status === 429 || response.status === 503); attempt++) {
      const retryAfter = Number(response.headers.get('retry-after') ?? 0)
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(120_000, 10_000 * (attempt + 1))
      await pause(wait)
      await throttle()
      response = await send()
    }
    return response
  }

  const listRemote = async () => {
    const files = new Map()
    const walk = async (dir) => {
      const response = await request(`${dir}/`, { method: 'PROPFIND', headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' }, body: PROPFIND_BODY })
      if (response.status === 404) return
      if (response.status === 401) throw new Error('Яндекс.Диск не принял логин или пароль приложения (401)')
      if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): HTTP ${response.status}`)
      const xml = await response.text()
      for (const item of parsePropfind(xml, dir)) {
        if (item.isDir) await walk(item.href)
        else {
          const rel = item.href.replace(`${root}/`, '')
          if (rel !== '') files.set(rel, { size: item.size, modified: item.modified })
        }
      }
    }
    await walk(root)
    return files
  }

  const dirExists = async (path) => {
    const response = await request(`${path}/`, {
      method: 'PROPFIND',
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    })
    return response.ok
  }

  const ensureDir = async (relDir) => {
    const parts = relDir.split('/').filter(Boolean)
    let current = root
    // Корень тоже создаём: без него Яндекс отвечает 409 на вложенные MKCOL.
    const targets = [current, ...parts.map(part => {
      current = `${current}/${part}`
      return current
    })]
    for (const target of targets) {
      const response = await request(`${target}/`, { method: 'MKCOL' })
      if (response.ok || response.status === 405) continue
      // 409 бывает и «уже есть», и «нет родителя» — проверяем фактически.
      if (await dirExists(target)) continue
      throw new Error(`Яндекс.Диск (WebDAV): не удалось создать папку ${target} (${response.status})`)
    }
  }

  const download = async (rel) => {
    const response = await request(`/${root.replace(/^\/+/, '')}/${rel}`, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): не удалось скачать ${rel} (${response.status})`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const target = join(config.repoDir, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buffer)
  }

  const upload = async (rel, absolute) => {
    const buffer = await readFile(absolute)
    const response = await request(`/${root.replace(/^\/+/, '')}/${rel}`, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Яндекс.Диск (WebDAV): не удалось загрузить ${rel} (${response.status})`)
  }

  return {
    kind: 'webdav',

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

    async commit() {
      const remote = await listRemote()
      const local = []
      await walkFiles(config.repoDir, config.repoDir, local)

      let uploaded = 0
      const dirs = new Set()
      const pending = []
      for (const file of local) {
        const meta = remote.get(file.rel)
        if (meta !== undefined) {
          const info = await stat(file.absolute)
          if (info.size === meta.size) continue
        }
        pending.push(file)
      }

      // Сначала сессии (главное), потом служебные файлы, вложения в конце.
      const priority = (rel) => (rel.startsWith('sessions/') ? 0 : rel.startsWith('attachments/') ? 2 : 1)
      pending.sort((a, b) => priority(a.rel) - priority(b.rel))

      // Файлы отправляем параллельно: у Яндекса на каждый уходит два запроса,
      // последовательная отправка сотен файлов занимает часы.
      // Бюджет времени: не держим лок бесконечно, остальное уедет в следующий раз.
      const budget = Number(config.maxUploadMs ?? 120_000)
      const startedAt = Date.now()
      await mapLimit(pending, CONCURRENCY, async (file) => {
        if (Date.now() - startedAt > budget) return
        const dir = file.rel.split('/').slice(0, -1).join('/')
        if (dir !== '' && !dirs.has(dir)) {
          await ensureDir(dir)
          dirs.add(dir)
        }
        await upload(file.rel, file.absolute)
        uploaded += 1
      })

      let removed = 0
      // Пустой кеш — почти наверняка сбой чтения, а не «удалили всё».
      if (local.length === 0 && remote.size > 0) return { committed: false, uploaded, removed: 0, warning: 'локальный кеш пуст — удаление на Диске пропущено' }
      const localSet = new Set(local.map(file => file.rel))
      for (const rel of remote.keys()) {
        if (localSet.has(rel)) continue
        const response = await request(`${root}/${rel}`, { method: 'DELETE' })
        if (response.ok || response.status === 404) removed += 1
      }

      return { committed: uploaded > 0 || removed > 0, uploaded, removed }
    },
  }
}

/** Проверка доступа к WebDAV. */
export async function probeWebdav(config) {
  try {
    const backend = createWebdavBackend(config)
    await backend.sync()
    return { ok: true, message: 'доступ к Яндекс.Диску подтверждён' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
