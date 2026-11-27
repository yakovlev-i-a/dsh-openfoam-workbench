// The browser half: it must register one package-owned stylesheet and clean it up.
import { test } from 'node:test'
import assert from 'node:assert/strict'

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

    let cleanup = null
    const ctx = { effect: (fn) => { cleanup = fn() } }
    plugin.apply(ctx)
    assert.equal(head.children.length, 1)
    const style = head.children[0]
    assert.equal(style.attrs['data-plugin-css'], '@yakovlev-i-a/dsh-openfoam-workbench/tool-accent.css')
    assert.match(style.textContent, /\[data-tool\^="openfoam_"\]/)
    assert.match(style.textContent, /\[class\*="_summary"\] \{ color: #3b518c/, 'blue summary expected')
    assert.match(style.textContent, /#9db4e0/, 'dark palette variant expected')
    // The chip: a filled 3-letter block before the tool name, and no DOM change.
    assert.match(style.textContent, /\[class\*="_summary"\]::before \{/, 'the chip is a pseudo-element')
    assert.match(style.textContent, /content: "OFW"/, 'the chip reads OFW')
    assert.match(style.textContent, /background: #3b518c/, 'the chip is filled blue')
    assert.match(style.textContent, /color: #fff/, 'the chip letters are white')
    assert.equal((style.textContent.match(/::before/g) || []).length, 2, 'light and dark chips')
    assert.doesNotMatch(style.textContent, /box-shadow/, 'the ring was removed by request')
    assert.match(style.textContent, /data-ds-dark-theme/, 'dark palette variant expected')
    assert.equal(typeof cleanup, 'function')
    cleanup()
    assert.equal(head.children.length, 0, 'cleanup must remove the stylesheet')
  } finally {
    globalThis.window = prevWindow
    globalThis.document = prevDocument
  }
})
