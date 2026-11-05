/**
 * Два бэкенда хранения зеркала:
 *
 * - `git` — репозиторий (рабочее дерево считается производным: перед каждой
 *   операцией приводится к состоянию удалённой ветки, после — коммит и push);
 * - `folder` — обычная папка на диске (OneDrive, Яндекс.Диск, Syncthing, сетевой
 *   шар). Никакого git и никаких бинарников: синхронизацией занимается
 *   клиент облака.
 */
import { commitAndPush, ensureRepo, fetchRemote, setRemote } from './git.mjs'

export async function createRemote(config) {
  if (config.backend === 'folder') {
    return {
      kind: 'folder',
      async sync() {
        return true
      },
      async commit() {
        return { committed: false, pushed: false }
      },
    }
  }

  await ensureRepo({ repoDir: config.repoDir, branch: config.branch })
  const remote = {
    kind: 'git',
    async sync() {
      if (config.remote) {
        await setRemote(config.repoDir, config.remote)
        return fetchRemote(config.repoDir, config.branch)
      }
      return true
    },
    async commit(message) {
      return commitAndPush({ repoDir: config.repoDir, branch: config.branch, message })
    },
  }
  return remote
}
