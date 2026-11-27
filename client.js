// Browser half of the OpenFOAM Workbench.
//
// The Host half registers the tools; this half is pure presentation: every tool
// row whose wire name starts with `openfoam_` gets an orange accent bar, so the
// CFD tools are distinguishable from bash/read/edit calls at a glance.
//
// The row contract comes from @deepseek-ai/dsh-client-ui-tool: the root of every
// atomic tool row carries data-tool="<wire name>" and data-state. The shipped UI
// already styles by that attribute prefix (`[data-tool^=cordis_]`), so no slot
// registration and no per-tool view is needed here.
//
// Styles are package-owned: the tag carries data-plugin-css and is removed with
// the Client run through ctx.effect's cleanup.
window.__ModuleLoader__.load({
  id: '@yakovlev-i-a/dsh-openfoam-workbench',
  factory() {
    const TAG = '@yakovlev-i-a/dsh-openfoam-workbench/tool-accent.css'
    // Light/dark come from the Host palette attribute on <body>. The row shows
    // `Tool call` as the title and `openfoam_x · <argument summary>` in the
    // summary element (css-module local name `_summary`; its hash prefix changes
    // between builds). Blue marks the call itself; the ring and the orange title
    // are gone by request.
    //
    // The chip is a `::before` on the summary, so it needs no slot, no React
    // component and no per-tool view: the summary starts with the tool name, and
    // a pseudo-element puts a filled 3-letter block in front of it.
    const CSS = [
      '/* OpenFOAM Workbench: blue "OFW" chip on every openfoam_* tool row */',
      '[data-tool^="openfoam_"] [class*="_summary"] { color: #3b518c; }',
      '[data-tool^="openfoam_"] [class*="_summary"]::before {',
      '  content: "OFW";',
      '  display: inline-block;',
      '  box-sizing: border-box;',
      '  min-width: 27px;',
      '  margin-right: 6px;',
      '  padding: 0 5px;',
      '  border-radius: 3px;',
      '  background: #3b518c;',
      '  color: #fff;',
      '  font-size: 10px;',
      '  font-weight: 700;',
      '  line-height: 15px;',
      '  letter-spacing: 0.5px;',
      '  text-align: center;',
      '  vertical-align: 1px;',
      '}',
      'body[data-ds-dark-theme] [data-tool^="openfoam_"] [class*="_summary"] { color: #9db4e0; }',
      'body[data-ds-dark-theme] [data-tool^="openfoam_"] [class*="_summary"]::before { background: #4b63a6; color: #fff; }',
    ].join('\n')

    return {
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const selector = 'style[data-plugin-css=' + JSON.stringify(TAG) + ']'
          let tag = document.querySelector(selector)
          if (!tag) {
            tag = document.createElement('style')
            tag.setAttribute('data-plugin-css', TAG)
            tag.textContent = CSS
            document.head.appendChild(tag)
          }
          return () => {
            if (tag && typeof tag.remove === 'function') tag.remove()
          }
        }, 'openfoam tool accent')
      },
    }
  },
})
