// Settings schema: DSH renders the plugin form only for a native schemastery
// schema, so this test checks the real host library and that every runtime
// default has a field.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { DEFAULTS } from '../lib/runtime.js'
import { geometryScalePrompt } from '../lib/needs-input.js'

function dshBin() {
  try {
    const which = execSync('command -v dsh', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return which ? realpathSync(which) : ''
  } catch {
    return ''
  }
}

test('the geometry-scale payload is language-neutral', () => {
  const p = geometryScalePrompt({ extent: 5, askAbove: 0.1 })
  assert.equal(p.kind, 'geometry-scale')
  assert.deepEqual(p.data, { extent_m: 5, askAbove_m: 0.1 })
  assert.deepEqual(p.options.map((o) => o.id), ['metres-ok', 'millimetres', 'other'])
  assert.match(p.ask, /5\.000 m across/)
  // no user-facing prose in a specific language: the agent phrases the question
  assert.equal(p.question, undefined)
  assert.ok(p.options.every((o) => typeof o.label === 'string' && o.label.length > 0))
})

test('Config is a native schemastery schema with a field for every default', async () => {
  const bin = dshBin()
  if (!bin) return // no host installation to borrow the library from
  process.argv[1] = bin
  const mod = await import('../lib/settings-schema.js?host=' + Date.now())
  const schema = mod.Config
  assert.ok(schema, 'Config must be exported when the host library is reachable')
  assert.equal(schema[Symbol.for('schemastery')], true, 'DSH requires the native marker')
  const fields = Object.keys(schema.dict || {})
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(fields.includes(key), `Config is missing the "${key}" field`)
  }
})

test('without the host library the plugin still loads (graceful degradation)', async () => {
  const { buildConfigSchema } = await import('../lib/settings-schema.js')
  const savedArgv = process.argv[1]
  const savedCwd = process.cwd()
  try {
    process.argv[1] = '/nonexistent/bin.js'
    process.chdir(process.env.TMPDIR || '/tmp')
    const schema = buildConfigSchema()
    // either the library was found locally (schema) or it was not (undefined);
    // both are valid, but it must never throw
    // schemastery object() returns a callable schema (typeof 'function')
    assert.ok(schema === undefined || typeof schema === 'function' || typeof schema === 'object')
  } finally {
    process.argv[1] = savedArgv
    process.chdir(savedCwd)
  }
})
