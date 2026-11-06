/**
 * Browser half of `dsh-sync`.
 *
 * Карточка на странице «Плагины» в настройках: проверка окружения, поля для
 * адреса зеркала и пути к проекту, кнопка синхронизации и отчёт о последнем
 * запуске. Все действия идут через host-маршруты `/api/dsh-sync/*`; токены в
 * браузер не попадают.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshSync';
    const STATE_PATH = '/api/dsh-sync/state';
    const CONFIG_PATH = '/api/dsh-sync/config';
    const RUN_PATH = '/api/dsh-sync/run';

    const en = { title: 'Session sync' };
    const ru = { title: 'Синхронизация сессий' };

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13 },
      section: { display: 'flex', flexDirection: 'column', gap: 6 },
      title: { fontSize: 13, fontWeight: 600 },
      hint: { fontSize: 12, opacity: 0.75, lineHeight: 1.5 },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
      dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
      badge: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 500 },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 12, fontWeight: 500, opacity: 0.85 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      buttons: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      button: {
        padding: '6px 12px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      primary: {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid rgba(80,120,200,0.55)',
        background: 'rgba(80,120,200,0.16)',
        color: 'inherit',
        fontSize: 12.5,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      note: { fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: 'rgba(128,128,128,0.10)' },
      error: { fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: 'rgba(209,36,47,0.12)', border: '1px solid rgba(209,36,47,0.35)' },
      ok: { fontSize: 12, lineHeight: 1.5, padding: '8px 10px', borderRadius: 8, background: 'rgba(40,150,80,0.12)', border: '1px solid rgba(40,150,80,0.35)' },
      meta: { fontSize: 11.5, opacity: 0.65 },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 },
    };

    async function post(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const text = await response.text().catch(() => '');
      if (!response.ok) {
        const error = new Error(`${response.status} ${path}${text ? `: ${text.slice(0, 200)}` : ''}`);
        error.status = response.status;
        throw error;
      }
      try {
        return JSON.parse(text);
      } catch {
        const error = new Error(`ответ без JSON: ${text.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
    }

    function explain(error) {
      const message = String(error?.message ?? error);
      if (error?.status === 404) {
        return `${message}. Host-часть плагина не загрузилась — полностью закройте DSH (включая значок в трее) и запустите снова, обновления страницы недостаточно.`;
      }
      return message;
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'dsh-sync: card dictionaries');
      try {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = '@keyframes dsh-sync-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-sync: keyframes');
      } catch (error) {
        console.error('[dsh-sync] анимация недоступна:', error);
      }

      const listeners = new Set();
      let snapshot = { loading: true, data: null, error: '', busy: '', notice: '' };

      const publish = (next) => {
        snapshot = { ...snapshot, ...next };
        for (const listener of listeners) listener();
      };

      const refresh = async () => {
        try {
          const data = await post(STATE_PATH, {});
          publish({ data, loading: false, error: data?.ok === false ? String(data.message ?? '') : '' });
        } catch (error) {
          publish({ loading: false, error: `Не удалось получить состояние: ${explain(error)}` });
        }
      };

      const save = async (draft) => {
        publish({ busy: 'save', notice: '', error: '' });
        try {
          const data = await post(CONFIG_PATH, draft);
          publish({ data, busy: '', notice: 'Настройки сохранены' });
          return true;
        } catch (error) {
          publish({ busy: '', error: `Не удалось сохранить: ${explain(error)}` });
          return false;
        }
      };

      const run = async (action) => {
        publish({ busy: action, notice: '', error: '' });
        try {
          const result = await post(RUN_PATH, { action });
          if (result?.ok === true) {
            publish({ busy: '', notice: result.message || 'Готово' });
          } else {
            publish({ busy: '', error: result?.message ?? 'Синхронизация не удалась' });
          }
          await refresh();
        } catch (error) {
          publish({ busy: '', error: `Синхронизация не удалась: ${explain(error)}` });
        }
      };

      const useSnapshot = () => {
        const [, force] = React.useReducer((n) => n + 1, 0);
        React.useEffect(() => {
          listeners.add(force);
          return () => listeners.delete(force);
        }, []);
        return snapshot;
      };

      function SyncCard(props) {
        const view = props?.view;
        const state = useSnapshot();
        const data = state.data;
        const [draft, setDraft] = React.useState({ remote: '', projectPath: '', projectId: '', attachments: false, useExternal: true });
        const [touched, setTouched] = React.useState(false);

        React.useEffect(() => {
          void refresh();
        }, []);

        React.useEffect(() => {
          if (data?.config === undefined || touched) return;
          setDraft({
            remote: data.config.remote ?? '',
            projectPath: data.config.projectPath ?? '',
            projectId: data.config.projectId ?? '',
            attachments: data.config.attachments === true,
            useExternal: data.config.useExternal !== false,
          });
        }, [data?.config?.remote, data?.config?.projectPath, data?.config?.projectId, data?.config?.attachments, data?.config?.useExternal, touched]);

        if (view === 'summary') {
          const status = data?.status;
          const ready = data?.ready === true;
          const last = data?.lastRun;
          return h(
            'span',
            { style: { display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12.5 } },
            h('span', null, t('title')),
            h(
              'span',
              { style: { ...S.badge, background: ready ? 'rgba(40,150,80,0.16)' : 'rgba(200,140,0,0.16)' } },
              ready ? 'готово' : state.loading ? 'проверка…' : 'не настроено',
            ),
            status ? h('span', { style: S.meta }, `${status.local}/${status.mirror}`) : null,
            last ? h('span', { style: S.meta }, new Date(last.at).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' })) : null,
          );
        }

        const set = (patch) => {
          setTouched(true);
          setDraft((current) => ({ ...current, ...patch }));
        };

        const checks = data?.checks ?? [];
        const busy = state.busy !== '';
        const status = data?.status;
        const last = data?.lastRun;
        const external = data?.external;
        const mode = data?.mode;

        return h(
          'div',
          { style: S.page },

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, 'Проверка окружения'),
            checks.length === 0
              ? h('span', { style: S.hint }, state.loading ? 'Проверка…' : 'Не удалось получить данные от host-части.')
              : null,
            ...checks.map((check) =>
              h(
                'div',
                { key: check.id, style: S.row },
                h('span', { style: { ...S.dot, background: check.ok ? '#2f9e44' : '#d1242f' } }),
                h('span', { style: { minWidth: 150 } }, check.title),
                h('span', { style: S.meta }, check.detail),
              ),
            ),
            checks.some((check) => !check.ok)
              ? h('span', { style: S.note }, checks.filter((check) => !check.ok).map((check) => check.hint).join(' '))
              : null,
          ),

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, 'Настройки'),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, 'Адрес репозитория с сессиями (приватный)'),
              h('input', {
                style: S.input,
                value: draft.remote,
                placeholder: 'https://github.com/user/dsh-sessions.git',
                onChange: (event) => set({ remote: event.target.value }),
              }),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, 'Путь к проекту на этом компьютере'),
              h('input', {
                style: S.input,
                value: draft.projectPath,
                placeholder: 'C:\\work\\my-project',
                onChange: (event) => set({ projectPath: event.target.value }),
              }),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, 'Идентификатор проекта (одинаковый на всех устройствах)'),
              h('input', {
                style: S.input,
                value: draft.projectId,
                placeholder: 'harness',
                onChange: (event) => set({ projectId: event.target.value }),
              }),
            ),
            h(
              'label',
              { style: S.checkboxRow },
              h('input', {
                type: 'checkbox',
                checked: draft.attachments,
                onChange: (event) => set({ attachments: event.target.checked }),
              }),
              h('span', null, 'Синхронизировать вложения (картинки и файлы из чата)'),
            ),
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                {
                  style: S.button,
                  disabled: busy,
                  onClick: () => void save(draft),
                },
                state.busy === 'save' ? 'Сохранение…' : 'Сохранить',
              ),
            ),
          ),

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, 'Внешний плагин синхронизации'),
            external?.found
              ? h(
                  'span',
                  { style: S.hint },
                  external.callable
                    ? `Найден «${external.name}» с программным интерфейсом — синхронизация выполняется через него.`
                    : `Найден «${external.name}»${external.configured ? ' (настроен)' : ''}, но он не публикует интерфейс для вызова. Используется встроенный движок; чтобы плагины не мешали друг другу, оставьте активным один.`,
                )
              : h('span', { style: S.hint }, 'Не найден — используется встроенный движок.'),
            external?.callable
              ? h(
                  'label',
                  { style: S.checkboxRow },
                  h('input', {
                    type: 'checkbox',
                    checked: draft.useExternal,
                    onChange: (event) => set({ useExternal: event.target.checked }),
                  }),
                  h('span', null, 'Предпочитать внешний плагин, пока он доступен'),
                )
              : null,
            mode === 'external' ? h('span', { style: S.ok }, 'Активен режим: через внешний плагин') : null,
          ),

          h(
            'div',
            { style: S.section },
            h('span', { style: S.title }, 'Синхронизация'),
            status
              ? h('span', { style: S.hint }, `Сессий локально: ${status.local}, в зеркале: ${status.mirror}. Только локально: ${status.onlyLocal}, только в зеркале: ${status.onlyMirror}.`)
              : null,
            status && status.local === 0 && status.mirror > 0
              ? h(
                  'span',
                  { style: S.note },
                  `Диагностика: home=${data?.debug?.home ?? '?'}, просканировано сессий ${data?.debug?.sessionsScanned ?? '?'}, пути в сторе: ${(data?.debug?.cwds ?? []).join(' | ') || '—'}, путь проекта: ${data?.debug?.projectPath || '—'}`,
                )
              : null,
            h(
              'div',
              { style: S.buttons },
              h(
                'button',
                { style: S.primary, disabled: busy, onClick: () => void run('sync') },
                state.busy === 'sync' ? 'Синхронизация…' : 'Синхронизировать',
              ),
              h('button', { style: S.button, disabled: busy, onClick: () => void run('pull') }, 'Только принять'),
              h('button', { style: S.button, disabled: busy, onClick: () => void run('push') }, 'Только отправить'),
              h('button', { style: S.button, disabled: busy, onClick: () => void refresh() }, 'Обновить'),
            ),
            last
              ? h(
                  'span',
                  { style: last.ok ? S.ok : S.error },
                  `${new Date(last.at).toLocaleString('ru-RU')} — ${last.ok ? 'успешно' : 'ошибка'}: ${last.message}`,
                )
              : h('span', { style: S.hint }, 'Ещё не запускалось.'),
            h('span', { style: S.hint }, 'После приёма новых сессий перезапустите DSH — список обновляется при старте.'),
            data?.automation
              ? h(
                  'span',
                  { style: data.automation.lastError ? S.error : S.hint },
                  data.automation.enabled === false
                    ? 'Автосинхронизация выключена.'
                    : `Автосинхронизация: приём раз в ${data.automation.settings?.pullIntervalMinutes ?? 15} мин, отправка при изменениях (не чаще ${data.automation.settings?.pushMinIntervalMinutes ?? 5} мин)`
                      + (data.automation.lastPushAt
                        ? `; последняя отправка ${new Date(data.automation.lastPushAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
                        : '')
                      + (data.automation.lastError ? `; ошибка: ${data.automation.lastError}` : ''),
                )
              : null,
          ),

          state.notice ? h('span', { style: S.ok }, state.notice) : null,
          state.error ? h('span', { style: S.error }, state.error) : null,
        );
      }

      /** Короткое имя зеркала для подсказки: «github.com/user/repo». */
      let remoteHint;
      const loadRemoteHint = async () => {
        if (remoteHint !== undefined) return remoteHint;
        try {
          const data = await post(STATE_PATH, {});
          const remote = data?.config?.remote;
          remoteHint = typeof remote === 'string' && remote.length > 0
            ? remote.replace(/^https?:\/\//, '').replace(/^git@/, '').replace(/\.git$/, '').replace(':', '/')
            : null;
        } catch {
          remoteHint = null;
        }
        return remoteHint;
      };

      function HeaderSyncButton() {
        const [phase, setPhase] = React.useState('idle');
        const [hint, setHint] = React.useState('Синхронизировать сессии этого проекта с удалённым зеркалом');
        const [hover, setHover] = React.useState(false);

        const idleHint = 'Синхронизировать сессии этого проекта с удалённым зеркалом';

        React.useEffect(() => {
          void loadRemoteHint().then((target) => {
            if (target) setHint(`Синхронизировать сессии с ${target}`);
          });
        }, []);

        const run = async () => {
          if (phase === 'busy') return;
          setPhase('busy');
          setHint('Синхронизация сессий: приём и отправка…');
          try {
            const result = await post(RUN_PATH, { action: 'sync' });
            if (result?.ok === true) {
              setPhase('ok');
              setHint(result.message || 'Сессии синхронизированы');
            } else {
              setPhase('error');
              setHint(result?.message ?? 'Синхронизация не удалась');
            }
          } catch (error) {
            setPhase('error');
            setHint(explain(error));
          }
          setTimeout(() => {
            setPhase('idle');
            setHint(idleHint);
          }, 5000);
        };

        const tint = phase === 'error' ? '#d1242f' : phase === 'ok' ? '#2f9e44' : 'currentColor';
        const spin = phase === 'busy';
        const lamp = phase === 'ok' || phase === 'error' ? (phase === 'ok' ? '#2f9e44' : '#d1242f') : null;
        const label = phase === 'busy' ? 'Синхронизация сессий…' : 'Синхронизация сессий';

        return h(
          'button',
          {
            type: 'button',
            onClick: run,
            title: hint,
            'aria-label': hint,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 10px',
              borderRadius: 8,
              border: `1px solid ${hover ? 'rgba(128,128,128,0.45)' : 'rgba(128,128,128,0.32)'}`,
              background: hover ? 'rgba(128,128,128,0.18)' : 'rgba(128,128,128,0.10)',
              color: 'inherit',
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: 500,
              lineHeight: 1,
              cursor: phase === 'busy' ? 'progress' : 'pointer',
              transition: 'background 120ms ease, border-color 120ms ease',
            },
          },
          h(
            'svg',
            {
              width: 14,
              height: 14,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: tint,
              strokeWidth: 2,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              style: spin ? { animation: 'dsh-sync-spin 900ms linear infinite' } : undefined,
            },
            h('path', { d: 'M21 12a9 9 0 0 1-9 9 9 9 0 0 1-9-9 9 9 0 0 1 9-9' }),
            h('path', { d: 'M21 3v6h-6' }),
          ),
          h('span', null, label),
          lamp === null
            ? null
            : h('span', {
                style: {
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  background: lamp,
                  marginLeft: 2,
                  boxShadow: '0 0 0 1.5px rgba(0,0,0,0.12)',
                },
              }),
        );
      }

      ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'dsh-sync',
        order: 55,
        label: () => t('title'),
        locale: NS,
      }, SyncCard));

      // Настройки нужны и на странице плагина: там менеджер показывает README,
      // и без этой секции поля остаются только в строке списка.
      try {
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-sync-settings',
          order: 60,
          label: () => t('title'),
          locale: NS,
        }, SyncCard));
      } catch (error) {
        console.error('[dsh-sync] секция настроек на странице плагина недоступна:', error);
      }

      // Кнопка в шапке — необязательное украшение: если слот не отдаётся,
      // плагин должен продолжать работать, а не ломать загрузку приложения.
      try {
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-sync',
          order: 40,
          locale: NS,
        }, HeaderSyncButton));
      } catch (error) {
        console.error('[dsh-sync] кнопка в шапке недоступна:', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    exports.NS = NS;
    return module.exports;
  },
});
