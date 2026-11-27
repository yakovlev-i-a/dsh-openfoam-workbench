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
    // The mark is the simplified flow-around-obstacle drawing, inlined as a
    // 667-byte SVG mask. A mask (not a background image) is what lets the glyph
    // take `currentColor`: the pseudo-element paints its own box with the colour
    // the row already has, so the mark is blue on a normal row, red on an errored
    // one and follows the theme without a second rule.
    // Source: inline-icon.svg (the guide path stripped); base64 -w0 regenerates it.
    const MARK_URL = 'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MDAgMjAwIj48cGF0aCBkPSJtIDAsMTQ0LjI3Njg3IGMgNzguNTQzMzk2LDAgMTI0LjE1OTE0LDQ1LjgwODcgMTg0LjE5MTM0LDQ1LjgwODcgNjAuMDMyMiwwIDcxLjI3NTcsLTQ0Ljc4NjYzIDE4MC4yOTE3LC00NC43ODY2MyIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjE1Ii8+PHBhdGggZD0ibSAzNTcuOTgzODEsMTIxLjAzODE4IDYuNDk5MjMsMjQuMjYwNzYgLTYuNDk5MjMsMjQuMjU3NjUgTCA0MDAsMTQ1LjI5ODk0IFoiIGZpbGw9IiMwMDAiLz48cGF0aCBkPSJtIDAsNTUuNzIzMTQgYyA3OC41NDMzOTYsMCAxMjQuMTU5MTQsLTQ1LjgwODcxNSAxODQuMTkxMzQsLTQ1LjgwODcxNSA2MC4wMzIyLDAgNzEuMjc1Nyw0NC43ODY2MzUgMTgwLjI5MTcsNDQuNzg2NjM1IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMTUiLz48cGF0aCBkPSJNIDM1Ny45ODM4MSw3OC45NjE4MzIgMzY0LjQ4MzA0LDU0LjcwMTA2IDM1Ny45ODM4MSwzMC40NDM0MDEgNDAwLDU0LjcwMTA2IFoiIGZpbGw9IiMwMDAiLz48Y2lyY2xlIGN4PSIxODYuNzk3NTkiIGN5PSI5OS45OTk5OTIiIHI9IjU0LjkzNjE5OSIgZmlsbD0iIzAwMCIvPjwvc3ZnPg==")'
    const CSS = [
      '/* OpenFOAM Workbench: the OpenFOAM mark on every openfoam_* tool row */',
      // The state classes DSH puts on the summary (errorSummary / stoppedSummary)
      // keep their own colour: the mark follows the text, so an errored row must
      // stay red rather than turn blue.
      '[data-tool^="openfoam_"] [class*="_summary"]:not([class*="errorSummary"]):not([class*="stoppedSummary"]) { color: #3b518c; }',
      'body[data-ds-dark-theme] [data-tool^="openfoam_"] [class*="_summary"]:not([class*="errorSummary"]):not([class*="stoppedSummary"]) { color: #9db4e0; }',
      '[data-tool^="openfoam_"] [class*="_summary"]::before {',
      '  content: "";',
      '  display: inline-block;',
      '  width: 26px;',
      '  height: 13px;',
      '  margin-right: 7px;',
      '  vertical-align: -2px;',
      '  background-color: currentColor;',
      '  -webkit-mask-image: ' + MARK_URL + ';',
      '  mask-image: ' + MARK_URL + ';',
      '  -webkit-mask-repeat: no-repeat;',
      '  mask-repeat: no-repeat;',
      '  -webkit-mask-position: center;',
      '  mask-position: center;',
      '  -webkit-mask-size: contain;',
      '  mask-size: contain;',
      '}',
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
