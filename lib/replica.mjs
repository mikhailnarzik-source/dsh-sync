/**
 * Дублирование синхронизации в два хранилища.
 *
 * Основное хранилище — то, что выбрано в настройках. Резервное указывается
 * отдельным блоком `secondary`: туда уезжают сессии и метаданные, но не
 * вложения (их много, а для восстановления достаточно самих сессий).
 *
 * Приём идёт из основного; если оно недоступно — из резервного.
 */
import { join } from 'node:path'
import { pull, push } from './sync.mjs'

const BACKENDS = ['git', 'folder', 'yandex', 'webdav']

/** Настройки резервного хранилища или undefined, если оно выключено. */
export function secondaryConfig(config) {
  const secondary = config?.secondary
  if (secondary === undefined || secondary === null || secondary.enabled === false) return undefined
  if (!BACKENDS.includes(secondary.backend)) return undefined
  const repoDir = typeof secondary.repoDir === 'string' && secondary.repoDir !== ''
    ? secondary.repoDir
    : join(config.repoDir ?? '.', '..', `replica-${secondary.backend}`)

  return {
    ...config,
    ...secondary,
    repoDir,
    // Вложения дублировать не нужно: они восстанавливаются из основного.
    attachments: false,
  }
}

/** Отправить в оба хранилища: ошибка резервного не ломает основной цикл. */
export async function pushReplicated({ home, config, sessions, prune = true, message }) {
  const summary = await push({ home, config, sessions, prune, message })
  const secondary = secondaryConfig(config)
  if (secondary === undefined) return summary
  try {
    summary.secondary = await push({ home, config: secondary, sessions, prune, message })
  } catch (error) {
    summary.secondaryError = error instanceof Error ? error.message : String(error)
  }
  return summary
}

/** Принять из основного, а при его недоступности — из резервного. */
export async function pullReplicated({ home, config, dryRun = false }) {
  try {
    return await pull({ home, config, dryRun })
  } catch (error) {
    const secondary = secondaryConfig(config)
    if (secondary === undefined) throw error
    const result = await pull({ home, config: secondary, dryRun })
    result.viaSecondary = true
    result.primaryError = error instanceof Error ? error.message : String(error)
    return result
  }
}
