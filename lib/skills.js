import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { HERE } from './runtime.js'

export const SKILLS_DIR = join(HERE, '..', 'skills')

/** Parse `--- frontmatter --- body` from a SKILL.md; null when the shape is wrong. */
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

// Register the bundled skills so the `skill` tool can discover them. A broken
// SKILL.md is reported with its path instead of silently disappearing from the
// catalog; test/skills.test.mjs keeps the shipped ones valid.
export function mountSkills(ctx) {
  let count = 0
  let entries = []
  try { entries = readdirSync(SKILLS_DIR, { withFileTypes: true }) } catch (e) {
    console.error('[openfoam-workbench] cannot read skills dir:', SKILLS_DIR, (e && e.message) || e)
    return 0
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue
    const p = join(SKILLS_DIR, d.name, 'SKILL.md')
    if (!existsSync(p)) continue
    const s = parseSkillMd(readFileSync(p, 'utf8'))
    if (!s) {
      console.error('[openfoam-workbench] malformed SKILL.md (name/description frontmatter required):', p)
      continue
    }
    if (!/^openfoam-[a-z0-9-]+$/.test(s.name)) {
      console.error('[openfoam-workbench] suspicious skill name (expected openfoam-kebab-case):', s.name, 'in', p)
    }
    ctx.skills.register({
      name: s.name,
      description: s.description,
      content: s.content,
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    count += 1
  }
  return count
}
