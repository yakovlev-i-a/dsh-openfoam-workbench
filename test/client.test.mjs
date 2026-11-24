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
    assert.match(style.textContent, /box-shadow: 0 0 0 1px #c2410c/, 'orange ring expected')
    assert.match(style.textContent, /\[class\*="_title"\] \{ color: #c2410c/, 'orange tool name expected')
    assert.match(style.textContent, /#fb923c|#fdba74/, 'dark palette expected')
    assert.match(style.textContent, /data-ds-dark-theme/, 'dark palette variant expected')
    assert.equal(typeof cleanup, 'function')
    cleanup()
    assert.equal(head.children.length, 0, 'cleanup must remove the stylesheet')
  } finally {
    globalThis.window = prevWindow
    globalThis.document = prevDocument
  }
})
