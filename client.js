// Browser half of the OpenFOAM Workbench.
//
// The Host half registers the tools; this half is pure presentation: every row
// that belongs to this package gets the same small mark in front of its name, so
// the CFD work stands out from bash/read/edit calls at a glance.
//
// The row contract comes from @deepseek-ai/dsh-client-ui-tool: the root of every
// atomic tool row carries data-tool="<wire name>" and data-state. The shipped UI
// already styles by that attribute prefix (`[data-tool^=cordis_]`), so tools need
// no slot registration and no per-tool view here.
//
// Skill rows come from @deepseek-ai/dsh-client-ui-skill and carry only
// data-tool="skill" plus data-state — the skill name lives in the summary text and
// in no attribute, so CSS alone cannot tell our skills from anyone else's. A tiny
// observer tags the rows whose summary is one of our `openfoam-*` skills with
// data-ofw-skill, and the stylesheet does the rest.
//
// Styles are package-owned: the tag carries data-plugin-css and is removed with
// the Client run through ctx.effect's cleanup.
window.__ModuleLoader__.load({
  id: '@yakovlev-i-a/dsh-openfoam-workbench',
  factory() {
    const TAG = '@yakovlev-i-a/dsh-openfoam-workbench/tool-accent.css'
    // The row shows `Tool call` (or `Skill`) as the title and the name in the
    // summary element (css-module local name `_summary`; its hash prefix changes
    // between builds).
    //
    // One presentation rule: a small mark in front of the name, and nothing else —
    // the row keeps whatever colour DSH gives it (label colour, red for an error,
    // the theme's own palette), so the mark inherits it through `currentColor`
    // instead of introducing a second identity colour.
    //
    // The mark is an SVG *mask*, not a background image, because only a mask can
    // be painted with `currentColor`; it costs ~900 bytes of drawing, inlined as a
    // data URI, so it needs no file, no package `assets/` export and no request.
    // Source: inline-icon.svg — `node scripts/make-icon-mask.mjs` regenerates the
    // constant below from it.
    const MARK_URL = 'url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MDAgMjAwIj48cGF0aCBkPSJNIDAsNTMuMzA4NzE1IEMgOTkuODY3NjYzLDUzLjMwODcxNSAxMjQuMTU5MTQsNy41IDE4NC4xOTEzNCw3LjUgYyA2MC4wMzIyLDAgOTcuMDEyODksNDAuMDg1NTc1IDE1My45MDI5LDQwLjA4NTU3NSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjE1Ii8+PHBhdGggZD0ibSAzMzEuNTk1MDEsNzEuODQ2MzQ3IDYuNDk5MjMsLTI0LjI2MDc3MiAtNi40OTkyMywtMjQuMjU3NjU5IDQyLjAxNjE5LDI0LjI1NzY1OSB6IiBmaWxsPSIjMDAwIi8+PHBhdGggZD0iTSAzNTcuOTgzODEsMTI0LjI2MDc3IDM2NC40ODMwNCwxMDAgMzU3Ljk4MzgxLDc1Ljc0MjM0IDQwMCwxMDAgWiIgZmlsbD0iIzAwMCIvPjxjaXJjbGUgY3g9IjE4Ni43OTc1OSIgY3k9Ijk5Ljk5OTk5MiIgcj0iNTQuOTM2MTk5IiBmaWxsPSIjMDAwIi8+PHBhdGggZD0ibSAwLDEwMCAxMDQuMjA5NDIsLThlLTYgbSAxNjUuMTc2MzQsMCBoIDk5LjU4ODI1IiBmaWxsPSJub25lIiBzdHJva2U9IiMwMDAiIHN0cm9rZS13aWR0aD0iMjUiLz48cGF0aCBkPSJtIDAsMTQ2LjY5MTI4IGMgOTkuODY3NjYzLDAgMTI0LjE1OTE0LDQ1LjgwODcyIDE4NC4xOTEzNCw0NS44MDg3MiA2MC4wMzIyLDAgOTcuMDEyODksLTQwLjA4NTU4IDE1My45MDI5LC00MC4wODU1OCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMDAwIiBzdHJva2Utd2lkdGg9IjE1Ii8+PHBhdGggZD0ibSAzMzEuNTk1MDEsMTI4LjE1MzY1IDYuNDk5MjMsMjQuMjYwNzcgLTYuNDk5MjMsMjQuMjU3NjYgNDIuMDE2MTksLTI0LjI1NzY2IHoiIGZpbGw9IiMwMDAiLz48L3N2Zz4=")'
    // The mark geometry lives in one place; both selectors only decide who gets it.
    const MARK = [
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
    ].join('\n')
    const CSS = [
      '/* OpenFOAM Workbench: the mark on every openfoam_* tool row, and on the rows',
      '   of this package\'s own skills (tagged by the observer below — a skill row',
      '   carries no name attribute CSS could match on). */',
      '[data-tool^="openfoam_"] [class*="_summary"]::before,',
      '[data-ofw-skill] [class*="_summary"]::before {',
      MARK,
      '}',
    ].join('\n')

    // Skill rows expose no name attribute, so the name is read from the summary
    // text. `openfoam-` is this package's skill prefix (openfoam-case-builder,
    // openfoam-cht, ...); anything else keeps the plain row.
    const SKILL_PREFIX = 'openfoam-'
    const CARD = '[data-tool="skill"]'
    const SUMMARY = '[class*="_summary"]'
    const FLAG = 'data-ofw-skill'

    // Tag stale rows and untag rows React may have reused for another skill: a
    // full re-scan of the (few) skill cards per mutation batch is cheaper and more
    // reliable than tracking individual nodes.
    function syncSkills(doc) {
      const cards = doc.querySelectorAll(CARD)
      for (const card of cards) {
        const summary = card.querySelector(SUMMARY)
        const name = (summary ? summary.textContent : '').trim()
        const mine = name.startsWith(SKILL_PREFIX)
        if (mine && !card.hasAttribute(FLAG)) card.setAttribute(FLAG, '')
        else if (!mine && card.hasAttribute(FLAG)) card.removeAttribute(FLAG)
      }
    }

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

        ctx.effect(() => {
          if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
            return () => {}
          }
          // Coalesce a burst of mutations into one scan of the next frame.
          let queued = false
          const run = () => {
            queued = false
            try {
              syncSkills(document)
            } catch {
              // A re-render mid-scan is not worth surfacing to the user; the next
              // batch tags whatever is on screen then.
            }
          }
          const schedule = () => {
            if (queued) return
            queued = true
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
            else setTimeout(run, 16)
          }
          const observer = new MutationObserver((records) => {
            // Our own setAttribute/removeAttribute are attribute records, which we
            // do not observe, so this cannot feed itself.
            for (const record of records) {
              if (record.type === 'childList' || record.type === 'characterData') {
                schedule()
                return
              }
            }
          })
          observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          run()
          return () => {
            observer.disconnect()
            for (const card of document.querySelectorAll('[' + FLAG + ']')) {
              card.removeAttribute(FLAG)
            }
          }
        }, 'openfoam skill mark')
      },
    }
  },
})
