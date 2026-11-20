/**
 * Реестр «что уже синхронизировано»: для каждой сессии запоминаем время и
 * размер файла на момент последней удачной отправки или приёма.
 *
 * Индикатор в списке сессий строится по нему, а не сравнением содержимого:
 * иначе на каждую отрисовку строки пришлось бы читать десятки мегабайт.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const LEDGER_FILE = 'ledger.json'

export async function readLedger(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'dsh-sync', LEDGER_FILE), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object' && parsed.sessions !== null) {
      return { version: 1, sessions: parsed.sessions }
    }
  } catch {
    // нет файла или он повреждён — начинаем с пустого
  }
  return { version: 1, sessions: {} }
}

export async function writeLedger(home, ledger) {
  try {
    const dir = join(home, 'dsh-sync')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  } catch {
    // реестр — вспомогательные данные
  }
}

/** Канонический вид идентификатора: DSH всегда хранит его с префиксом. */
function normalizeId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
}
/** Отметить сессию как синхронизированную (по текущему состоянию файла). */
export function markSynced(ledger, sessionId, stat) {
  ledger.sessions[normalizeId(sessionId)] = { at: Date.now(), mtimeMs: Math.round(stat.mtimeMs), size: stat.size }
  return ledger
}

/**
 * Состояние сессии для индикатора.
 * @param sessionId идентификатор
 * @param stat текущий stat файла (может отсутствовать)
 * @param ledger реестр
 * @param problemIds сессии с ошибками последнего запуска
 * @returns 'green' | 'orange' | 'red'
 */
export function sessionState(sessionId, stat, ledger, problemIds = new Set()) {
  if (problemIds.has(sessionId)) return 'orange'
  const entry = ledger.sessions[normalizeId(sessionId)] ?? ledger.sessions[sessionId]
  if (entry === undefined) return 'red'
  if (stat === undefined) return 'orange'
  if (Math.round(stat.mtimeMs) > entry.mtimeMs + 500) return 'orange'
  return 'green'
}
