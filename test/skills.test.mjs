// Guards for the bundled skill catalog: valid frontmatter, real tool references,
// bounded sizes. A broken SKILL.md used to disappear from the catalog silently.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { parseSkillMd, SKILLS_DIR } from '../lib/skills.js'

const skillDirs = () => readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const skillText = (name) => readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')

test('every bundled skill has valid frontmatter, a kebab-case name and a bounded body', () => {
  const names = skillDirs()
  assert.ok(names.length >= 11, `expected at least 11 skills, got ${names.length}`)
  const seen = new Set()
  for (const dir of names) {
    const s = parseSkillMd(skillText(dir))
    assert.ok(s, `${dir}: frontmatter with name/description is required`)
    assert.match(s.name, /^openfoam-[a-z0-9-]+$/, `${dir}: name must be openfoam-kebab-case`)
    assert.equal(s.name, dir, `${dir}: name must match the directory`)
    assert.ok(!seen.has(s.name), `${dir}: duplicate skill name`)
    seen.add(s.name)
    assert.ok(s.description.length >= 40 && s.description.length <= 500, `${dir}: description length ${s.description.length}`)
    assert.match(s.description, /Use (when|for|to|it when|before|after)/i, `${dir}: description needs a trigger phrase ("Use when …")`)
    assert.ok(Buffer.byteLength(s.content) <= 8192, `${dir}: body is ${Buffer.byteLength(s.content)} bytes (max 8192)`)
    assert.ok(s.content.split('\n').length >= 10, `${dir}: body looks empty`)
  }
})

test('skills only reference tools that are actually registered', () => {
  const tools = {}
  apply({ systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } }, { caseRoots: [] })
  const known = new Set(Object.keys(tools))
  const unknown = []
  for (const dir of skillDirs()) {
    for (const m of skillText(dir).matchAll(/openfoam_[a-z0-9_]+/g)) {
      if (!known.has(m[0])) unknown.push(`${dir}: ${m[0]}`)
    }
  }
  assert.deepEqual(unknown, [], 'skills reference unregistered tools')
})

test('the catalog stays within the always-on budget', () => {
  let catalog = 0
  for (const dir of skillDirs()) {
    const s = parseSkillMd(skillText(dir))
    catalog += s.name.length + s.description.length + 6
  }
  assert.ok(catalog <= 4096, `skill catalog grew to ${catalog} bytes; keep it under 4 KB`)
})

test('parseSkillMd rejects a SKILL.md without name/description frontmatter', () => {
  assert.equal(parseSkillMd('# no frontmatter\n'), null)
  assert.equal(parseSkillMd('---\nname: x\n---\nbody\n'), null)
  const ok = parseSkillMd('---\nname: openfoam-demo\ndescription: Use when testing.\n---\n\nbody\n')
  assert.equal(ok.name, 'openfoam-demo')
  assert.equal(ok.content, 'body')
})
