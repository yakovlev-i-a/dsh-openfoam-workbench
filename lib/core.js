import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText } from './runtime.js'
import { resolveLanguage } from './discover.js'

export const DEFAULT_CORE_PATH = fileURLToPath(new URL('../CORE.md', import.meta.url))

export function mountCore(ctx, cfg) {
// --- thin core prompt section (always in context, sourced from CORE.md) ---
// The text is a function: DSH re-assembles the system prompt on every model
// step, so an edit to CORE.md takes effect on the next message, without a
// restart. A missing or empty file fails loudly at mount time; a file that
// becomes unreadable later keeps the last good text instead of breaking the
// request.
const corePath = cfg.corePath ? resolve(String(cfg.corePath)) : DEFAULT_CORE_PATH
const readCore = () => {
  const raw = readText(corePath)
  if (raw == null || !raw.trim()) return null
  return raw.trim()
}
let coreText = readCore()
if (coreText == null) {
  throw new Error(`[openfoam-workbench] CORE.md is missing or empty: ${corePath}`)
}
if (Buffer.byteLength(coreText) > 32768) {
  console.error(`[openfoam-workbench] CORE.md is ${Buffer.byteLength(coreText)} bytes; the system prompt should stay well under 32 KB`)
}
let coreWarned = false
const coreSectionText = () => {
  const next = readCore()
  if (next != null) {
    coreText = next
    coreWarned = false
  } else if (!coreWarned) {
    console.error(`[openfoam-workbench] cannot re-read CORE.md (${corePath}); keeping the last good version`)
    coreWarned = true
  }
  const language = cfg.responseLanguage || resolveLanguage(cfg)
  return coreText.replace(/\{\{language\}\}/g, language)
}
ctx.systemPrompt.section({
  name: 'openfoam-workbench:core',
  order: 250,
  text: coreSectionText,
  interpolate: false,
})
}
