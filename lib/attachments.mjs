/**
 * Вложения DSH: `attachments/v1/{objects,file-objects,files}` — объекты,
 * адресуемые по sha256, поэтому копируются только недостающие файлы и никогда
 * не перезаписываются. `tmp` и `request-images` (кеш запросов) не синхронизируются.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const SYNCED_DIRS = ['objects', 'file-objects', 'files']

async function walk(dir, base, out) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) await walk(absolute, base, out)
    else if (entry.isFile()) out.push({ absolute, rel: relative(base, absolute).split(sep).join('/') })
  }
}

async function collect(root) {
  const files = []
  for (const name of SYNCED_DIRS) await walk(join(root, name), root, files)
  return files
}

async function copyMissing(source, target) {
  if (existsSync(target)) return false
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  return true
}

/** Локальные вложения → зеркало. Возвращает статистику. */
export async function pushAttachments({ home, repoDir }) {
  const source = join(home, 'attachments', 'v1')
  if (!existsSync(source)) return { added: 0, skipped: 0, bytes: 0 }
  const files = await collect(source)
  let added = 0
  let bytes = 0
  for (const file of files) {
    const target = join(repoDir, 'attachments', ...file.rel.split('/'))
    if (await copyMissing(file.absolute, target)) {
      added += 1
      bytes += (await stat(file.absolute)).size
    }
  }
  return { added, skipped: files.length - added, bytes }
}

/** Зеркало → локальные вложения (недостающие файлы). */
export async function pullAttachments({ home, repoDir }) {
  const mirror = join(repoDir, 'attachments')
  if (!existsSync(mirror)) return { restored: 0, skipped: 0 }
  const files = []
  await walk(mirror, mirror, files)
  const target = join(home, 'attachments', 'v1')
  let restored = 0
  for (const file of files) {
    if (await copyMissing(file.absolute, join(target, ...file.rel.split('/')))) restored += 1
  }
  return { restored, skipped: files.length - restored }
}
