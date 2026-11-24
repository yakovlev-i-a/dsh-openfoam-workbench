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
    // Light/dark come from the Host palette attribute on <body>.
    const CSS = [
      '/* OpenFOAM Workbench: orange accent on every openfoam_* tool row */',
      '[data-tool^="openfoam_"] { box-shadow: inset 3px 0 0 0 #c2410c; }',
      'body[data-ds-dark-theme] [data-tool^="openfoam_"] { box-shadow: inset 3px 0 0 0 #fb923c; }',
      '[data-tool^="openfoam_"][data-state="running"] { box-shadow: inset 3px 0 0 0 #ea580c; }',
      'body[data-ds-dark-theme] [data-tool^="openfoam_"][data-state="running"] { box-shadow: inset 3px 0 0 0 #fdba74; }',
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
