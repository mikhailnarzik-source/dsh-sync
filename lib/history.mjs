/**
 * История запусков: последний результат плюс журнал из нескольких записей.
 * Журнал показывает, что происходило ночью или час назад, а не только сейчас.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const LAST_RUN_FILE = 'last-run.json'
export const HISTORY_FILE = 'history.jsonl'
const HISTORY_LIMIT = 50

/**
 * Записать результат запуска: обновляет last-run.json и дописывает журнал.
 * @param home каталог DSH
 * @param record результат { ok, action, message, ... }
 */
export async function recordRun(home, record) {
  const dir = join(home, 'dsh-sync')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, LAST_RUN_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    const file = join(dir, HISTORY_FILE)
    let lines = []
    try {
      lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim() !== '')
    } catch {
      lines = []
    }
    lines.push(JSON.stringify(record))
    await writeFile(file, `${lines.slice(-HISTORY_LIMIT).join('\n')}\n`, 'utf8')
  } catch {
    // история — вспомогательные данные, сбой записи не критичен
  }
}

/** Последние записи журнала, свежие в конце. */
export async function readHistory(home, limit = 5) {
  try {
    const file = join(home, 'dsh-sync', HISTORY_FILE)
    const lines = (await readFile(file, 'utf8')).split('\n').filter(line => line.trim() !== '')
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
