import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HERE, run } from './runtime.js'

export const SKILLS_DIR = join(HERE, '..', 'skills')

export function parseSkillMd(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return null
  const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]
  const description = (m[1].match(/^description:\s*(.+)$/m) || [])[1]
  if (!name || !description) return null
  return {
    name: name.trim().replace(/^["']|["']$/g, ''),
    description: description.trim().replace(/^["']|["']$/g, ''),
    content: m[2].trim(),
  }
}

// --- durable run registry (files are the source of truth) ---

export function mountSkills(ctx) {
// --- register the bundled skills so the `skill` tool can discover them ---
try {
  for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const p = join(SKILLS_DIR, d.name, 'SKILL.md')
    if (!existsSync(p)) continue
    const s = parseSkillMd(readFileSync(p, 'utf8'))
    if (!s) continue
    ctx.skills.register({
      name: s.name,
      description: s.description,
      content: s.content,
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  }
} catch (e) {
  console.error('[openfoam-workbench] skill registration skipped:', (e && e.message) || e)
}
}
