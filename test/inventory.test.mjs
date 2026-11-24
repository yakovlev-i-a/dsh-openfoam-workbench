// Refactor guard: the model-facing surface must not change when code moves.
// Compares every registered tool (name + description + parameters hashes), the
// core prompt section and the skill catalog against test/fixtures/inventory.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'

const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16)

test('registered tools, core section and skills match the inventory fixture', () => {
  const tools = {}
  let section = null
  const skills = []
  apply(
    { systemPrompt: { section: (s) => { section = s } }, skills: { register: (s) => skills.push(s) }, tools: { register: (t) => { tools[t.name] = t } } },
    { caseRoots: [] },
  )
  const expected = JSON.parse(readFileSync(new URL('./fixtures/inventory.json', import.meta.url), 'utf8'))
  const actual = {
    tools: Object.keys(tools).sort().map((n) => ({ name: n, description: sha(String(tools[n].description || '')), parameters: sha(tools[n].parameters || {}) })),
    section: { name: section.name, order: section.order, interpolate: section.interpolate, text: sha(section.text()) },
    skills: skills.map((s) => ({ name: s.name, description: sha(String(s.description || '')) })).sort((a, b) => a.name.localeCompare(b.name)),
  }
  assert.deepEqual(actual, expected)
  assert.equal(actual.tools.length, 61)
  assert.equal(actual.skills.length, 10)
})
