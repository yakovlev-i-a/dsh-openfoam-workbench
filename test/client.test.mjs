// The browser half: it must register one package-owned stylesheet and clean it up.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function fakeDom() {
  const head = { children: [], appendChild(el) { this.children.push(el); el.parentNode = this } }
  const makeEl = () => ({
    tagName: 'STYLE', attrs: {}, textContent: '', parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this) },
  })
  const document = {
    querySelector: (sel) => head.children.find((el) => `style[data-plugin-css=${JSON.stringify(el.attrs['data-plugin-css'])}]` === sel) || null,
    createElement: () => makeEl(),
    head,
  }
  return { document, head }
}

test('client.js registers the openfoam accent stylesheet and removes it on cleanup', async () => {
  const { document, head } = fakeDom()
  const prevWindow = globalThis.window
  const prevDocument = globalThis.document
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  globalThis.document = document
  try {
    await import('../client.js')
    assert.ok(loaded, 'the loader must be called')
    assert.equal(loaded.id, '@yakovlev-i-a/dsh-openfoam-workbench')
    const plugin = loaded.factory(() => ({}))
    assert.equal(typeof plugin.apply, 'function')

    const cleanups = []
    const ctx = { effect: (fn) => { cleanups.push(fn()) } }
    plugin.apply(ctx)
    assert.equal(head.children.length, 1)
    const style = head.children[0]
    assert.equal(style.attrs['data-plugin-css'], '@yakovlev-i-a/dsh-openfoam-workbench/tool-accent.css')
    assert.match(style.textContent, /\[data-tool\^="openfoam_"\]/)
    // `background-color: currentColor` is not a colour rule; a bare `color:` is.
    assert.doesNotMatch(style.textContent, /(?<![-\w])color:/u, 'the row keeps the DSH colour')
    // The mark: a masked pseudo-element before the tool name, and no DOM change.
    assert.match(style.textContent, /\[class\*="_summary"\]::before \{/, 'the mark is a pseudo-element')

    // The mark travels inside the stylesheet: no file, no assets export, no request.
    assert.match(style.textContent, /mask-image: url\("data:image\/svg\+xml;base64,/, 'the mark is an inline mask')
    assert.match(style.textContent, /-webkit-mask-image: url\("data:image\/svg\+xml;base64,/, 'the webkit prefix is present')
    assert.match(style.textContent, /background-color: currentColor/, 'the mark takes the text colour')
    assert.doesNotMatch(style.textContent, /content: "OFW"/u, 'the mark carries no letters')
    // One rule body, two selector lines (tool rows and this package's skill rows).
    assert.equal((style.textContent.match(/::before \{/g) || []).length, 1, 'one mark rule, coloured by currentColor')
    // The same rule covers this package's skills: their rows expose no name
    // attribute, so the observer tags them with data-ofw-skill.
    assert.match(style.textContent, /\[data-ofw-skill\] \[class\*="_summary"\]::before/, 'skill rows share the mark rule')
    const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(source, /const SKILL_PREFIX = 'openfoam-'/, 'only this package\'s skills are tagged')
    assert.match(source, /name\.startsWith\(SKILL_PREFIX\)/, 'the tag follows the summary text')
    assert.match(source, /data-ofw-skill.*=.*FLAG|FLAG = 'data-ofw-skill'|const FLAG = 'data-ofw-skill'/, 'the tag attribute is named')
    assert.doesNotMatch(style.textContent, /box-shadow/, 'the ring was removed by request')
    assert.doesNotMatch(style.textContent, /data-ds-dark-theme/, 'no theme override: the row colour is the mark colour')
    assert.equal(cleanups.length, 2, 'one effect for the stylesheet, one for the skill observer')
    for (const cleanup of cleanups) assert.equal(typeof cleanup, 'function')
    for (const cleanup of cleanups) cleanup()
    assert.equal(head.children.length, 0, 'cleanup must remove the stylesheet')
  } finally {
    globalThis.window = prevWindow
    globalThis.document = prevDocument
  }
})

// The skill half is behavioural: a skill row carries no name attribute, so the
// observer must tag exactly this package's `openfoam-*` rows and untag a row that
// React reused for another skill.
test('client.js tags only openfoam-* skill rows', async () => {
  const el = (text, attrs = {}) => ({
    textContent: text,
    attrs: { ...attrs },
    hasAttribute(k) { return k in this.attrs },
    setAttribute(k, v) { this.attrs[k] = v },
    removeAttribute(k) { delete this.attrs[k] },
    querySelector(sel) {
      if (!sel.includes('_summary')) throw new Error('unexpected selector ' + sel)
      return this.children ? this.children[0] : null
    },
  })
  const card = (name, attrs = { 'data-tool': 'skill' }) => {
    const summary = el(name)
    const node = el(name, attrs)
    node.children = [summary]
    return node
  }
  const ours = card('openfoam-cht')
  const other = card('fluent-tui-knowledge')
  const tool = card('openfoam_run', { 'data-tool': 'openfoam_run' })
  const cards = [ours, other, tool]

  const body = { children: cards }
  let observed = null
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: (sel) => {
      if (sel === '[data-tool="skill"]') return cards.filter((c) => c.attrs['data-tool'] === 'skill')
      if (sel === '[data-ofw-skill]') return cards.filter((c) => 'data-ofw-skill' in c.attrs)
      return []
    },
    createElement: () => el('', {}),
    head: { children: [], appendChild() {} },
    body,
  }
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; observed = this } observe() {} disconnect() { this.disconnected = true } }
  globalThis.requestAnimationFrame = (fn) => fn()

  const prevWindow = globalThis.window
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  try {
    await import('../client.js?skills')
    const plugin = loaded.factory(() => ({}))
    const cleanups = []
    plugin.apply({ effect: (fn) => { cleanups.push(fn()) } })
    assert.equal(ours.attrs['data-ofw-skill'], '', 'our skill row is tagged on mount')
    assert.equal(other.attrs['data-ofw-skill'], undefined, 'another plugin\'s skill is left alone')
    assert.equal(tool.attrs['data-ofw-skill'], undefined, 'tool rows keep their own selector')

    // React reuses the node for a different skill: the next batch must untag it.
    ours.children[0].textContent = 'openfoam-case-builder'
    observed.cb([{ type: 'characterData' }])
    assert.equal(ours.attrs['data-ofw-skill'], '', 'still ours after the name change inside the family')
    other.children[0].textContent = 'openfoam-mesh-independence'
    observed.cb([{ type: 'childList' }])
    assert.equal(other.attrs['data-ofw-skill'], '', 'a renamed row is picked up')
    other.children[0].textContent = 'edit'
    observed.cb([{ type: 'childList' }])
    assert.equal(other.attrs['data-ofw-skill'], undefined, 'a row that stopped being ours is untagged')

    // Attribute records must never re-trigger a scan: the observer writes them itself.
    const before = other.children.length
    observed.cb([{ type: 'attributes' }])
    assert.equal(other.children.length, before)

    for (const cleanup of cleanups) cleanup()
    assert.equal(observed.disconnected, true, 'the observer stops with the Client run')
    assert.equal(ours.attrs['data-ofw-skill'], undefined, 'the tag is removed on cleanup')
  } finally {
    globalThis.window = prevWindow
    delete globalThis.MutationObserver
    delete globalThis.requestAnimationFrame
  }
})
