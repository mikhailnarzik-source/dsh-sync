/**
 * Дымовой прогон клиентской половины: загружаем client.js в поддельном окне,
 * вызываем factory с заглушкой React и проверяем, что карточка регистрируется
 * и рендерится без ошибок.
 *
 * Запуск: node test/client-smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let loaded
globalThis.window = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }

// eslint-disable-next-line no-new-func
new Function(source)()
assert.equal(loaded?.id, 'dsh-sync')
assert.equal(typeof loaded.factory, 'function')

// Мини-React: ровно то, что использует карточка.
let stateSlots = []
globalThis.document = { createElement: () => ({ textContent: '', remove() {} }), head: { appendChild() {} } }
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useReducer: (reducer, initial) => [initial, () => {}],
}

const modules = { react: React }
const requireStub = (id) => {
  if (modules[id] === undefined) throw new Error(`неожиданный require: ${id}`)
  return modules[id]
}

const exported = loaded.factory(requireStub)
assert.equal(typeof exported.apply, 'function')
assert.deepEqual(exported.inject, ['slots', 'locale'])

const registrations = []
const effects = []
let boundNs = ''
const ctx = {
  effect: (fn, label) => { effects.push(label); fn() },
  locale: {
    bind: (ns) => { boundNs = ns; return (key) => key },
    register: (ns, dict) => { assert.ok(dict.ru || dict.en, `нет словаря для ${ns}`) },
  },
  slots: {
    inject: (name, register) => { assert.equal(name, 'plugins.item'); register() },
    register: (options, component) => { registrations.push({ options, component }) },
  },
}

exported.apply(ctx)

assert.equal(boundNs, 'dshSync')
assert.equal(registrations.length, 2)
const cardRegistration = registrations.find(entry => entry.options.name === 'plugins.item')
const headerRegistration = registrations.find(entry => entry.options.name === 'conversation.session.header.actions')
assert.ok(cardRegistration, 'карточка плагина регистрируется')
assert.ok(headerRegistration, 'кнопка в шапке сессии регистрируется')
const { options, component } = cardRegistration
assert.equal(options.id, 'dsh-sync')
assert.equal(options.name, 'plugins.item')
assert.equal(typeof component, 'function')
assert.equal(typeof options.label(), 'string')
assert.ok(effects.length > 0, 'эффект с словарями должен регистрироваться')

// Рендер сводки и полной карточки на пустом снимке состояния.
const summary = component({ view: 'summary' })
assert.equal(summary.type, 'span')
const page = component({ view: 'page' })
assert.equal(page.type, 'div')
assert.ok(page.children.length >= 3, 'страница карточки содержит проверку, настройки и синхронизацию')

const headerButton = headerRegistration.component({})
assert.equal(headerButton.type, 'button')
assert.equal(headerButton.props['aria-label'], 'Синхронизировать сессии')
console.log('client smoke: OK')
console.log('  слот:', options.name, '| id:', options.id, '| label:', options.label())
console.log('  элементов на странице:', page.children.length)
