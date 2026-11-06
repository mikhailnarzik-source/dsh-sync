/**
 * Сбор диагностики: один текстовый отчёт, который можно скопировать и
 * показать, даже если синхронизация на этом компьютере не работает.
 *
 * В отчёт попадают только факты о настройках и окружении: токенов в
 * конфигурации нет, а пароль из адреса репозитория вырезается.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.mjs'
import { git } from './git.mjs'

/** Убрать логин и пароль из URL репозитория. */
export function redactRemote(remote) {
  if (typeof remote !== 'string' || remote.length === 0) return '(не задан)'
  return remote.replace(/\/\/[^/@]+@/, '//')
}

async function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { broken: true }
  }
}

/**
 * Собрать текстовый отчёт.
 * @param home каталог DSH
 * @param options { gitVersion?: string }
 */
export async function collectDiagnostics(home, options = {}) {
  const lines = []
  const add = (line = '') => lines.push(line)

  add('=== dsh-sync: диагностика ===')
  add(`время: ${new Date().toISOString()}`)
  add(`платформа: ${process.platform} ${process.arch}`)
  add(`node: ${process.version}`)
  add(`git: ${options.gitVersion ?? 'не проверялся'}`)
  add(`DSH home: ${home}`)

  let config
  try {
    config = await loadConfig(home)
  } catch (error) {
    add(`конфиг: ОШИБКА ЧТЕНИЯ: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (config !== undefined) {
    add('')
    add('--- конфигурация ---')
    add(`backend: ${config.backend ?? 'git'}`)
    add(`remote: ${redactRemote(config.remote)}`)
    add(`ветка: ${config.branch ?? 'main'}`)
    add(`зеркало: ${config.repoDir ?? '?'}`)
    add(`вложения: ${config.attachments === true ? 'да' : 'нет'}`)
    add(`автосинхронизация: ${JSON.stringify(config.autoSync ?? {})}`)
    const projects = Object.entries(config.projects ?? {})
    add(`проекты: ${projects.length === 0 ? '(нет)' : ''}`)
    for (const [id, value] of projects) {
      add(`  ${id} -> ${value?.path ?? '?'}${value?.path && !existsSync(value.path) ? '  [ПАПКА НЕ СУЩЕСТВУЕТ]' : ''}`)
    }
  }

  add('')
  add('--- окружение ---')
  const projectPath = Object.values(config?.projects ?? {})[0]?.path
  add(`папка проекта: ${projectPath === undefined ? 'не задана' : existsSync(projectPath) ? 'существует' : 'НЕ СУЩЕСТВУЕТ'}`)
  add(`каталог зеркала: ${config?.repoDir && existsSync(config.repoDir) ? 'существует' : 'НЕ СОЗДАН'}`)
  add(`каталог сессий: ${existsSync(join(home, 'sessions')) ? 'существует' : 'НЕ НАЙДЕН'}`)

  if (config?.remote && config?.repoDir && existsSync(config.repoDir)) {
    const probe = await git(config.repoDir, ['ls-remote', '--heads', config.remote], { allowFailure: true })
    add(`доступ к репозиторию: ${probe.code === 0 ? 'есть' : `НЕТ (${(probe.stderr || probe.stdout).trim().split('\n')[0] ?? ''})`}`)
    const status = await git(config.repoDir, ['status', '--short'], { allowFailure: true })
    add(`рабочее дерево зеркала: ${status.stdout.trim() === '' ? 'чистое' : `${status.stdout.trim().split('\n').length} изменений`}`)
    const head = await git(config.repoDir, ['log', '-1', '--oneline'], { allowFailure: true })
    add(`последний коммит зеркала: ${head.stdout.trim() || '(нет)'}`)
  }

  const lastRun = await readJson(join(home, 'dsh-sync', 'last-run.json'))
  add('')
  add('--- последний запуск ---')
  if (lastRun === undefined) add('нет данных')
  else {
    add(`ok: ${lastRun.ok}  mode: ${lastRun.mode ?? '?'}  action: ${lastRun.action ?? '?'}`)
    add(`время: ${lastRun.at ?? lastRun.time ?? '?'}`)
    add(`сообщение: ${lastRun.message ?? ''}`)
    if (lastRun.nodePath) add(`node: ${lastRun.nodePath}`)
    if (lastRun.pull) add(`pull: ${JSON.stringify(lastRun.pull)}`)
    if (lastRun.push) add(`push: ${JSON.stringify(lastRun.push)}`)
  }

  const pluginStatus = await readJson(join(home, 'dsh-sync', 'plugin-status.json'))
  add('')
  add('--- host-часть плагина ---')
  if (pluginStatus === undefined) add('файл plugin-status.json отсутствует (host-часть не загружалась?)')
  else {
    add(`imported: ${pluginStatus.imported === true}  applied: ${pluginStatus.applied === true}  pid: ${pluginStatus.pid ?? '?'}`)
    add(`обновлено: ${pluginStatus.at ?? '?'}`)
    const failures = Array.isArray(pluginStatus.failures) ? pluginStatus.failures : []
    add(`ошибки регистрации: ${failures.length === 0 ? 'нет' : failures.join('; ')}`)
    if (pluginStatus.debug) add(`debug: ${JSON.stringify(pluginStatus.debug)}`)
  }

  add('')
  add('--- конец отчёта ---')
  return lines.join('\n')
}
