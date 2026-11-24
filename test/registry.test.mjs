// The registration choke point: lossless JSON, schema, safety flag, telemetry.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRegistry, toLosslessJson } from '../lib/registry.js'

function fakeCtx() {
  const tools = {}
  return { tools: { register: (t) => { tools[t.name] = t } }, registered: tools }
}
function tool(over = {}) {
  return { name: 'openfoam_demo', description: 'demo tool', parameters: { type: 'object' }, execute: async () => ({ ok: true }), ...over }
}

test('toLosslessJson drops undefined, keeps null and rejects what JSON cannot carry', () => {
  assert.deepEqual(toLosslessJson({ a: 1, b: undefined, c: null }), { a: 1, c: null })
  assert.deepEqual(toLosslessJson([1, undefined, null]), [1, null, null])
  assert.throws(() => toLosslessJson({ f: () => 1 }), /cannot be a tool result/)
  assert.throws(() => toLosslessJson({ n: Number.NaN }), /non-finite/)
})

test('register validates the definition and refuses duplicates', () => {
  const ctx = fakeCtx()
  const reg = makeRegistry(ctx)
  assert.throws(() => reg.register(tool({ name: 'bad_name' })), /bad tool name/)
  assert.throws(() => reg.register(tool({ description: ' ' })), /description is required/)
  assert.throws(() => reg.register(tool({ parameters: null })), /parameters schema/)
  assert.throws(() => reg.register(tool({ execute: null })), /execute\(\) is required/)
  reg.register(tool())
  assert.throws(() => reg.register(tool()), /duplicate tool/)
})

test('register normalizes output: strict schema, render fallback, exclusive by default', () => {
  const ctx = fakeCtx()
  const reg = makeRegistry(ctx, { RENDERS: {} })
  reg.register(tool())
  const t = ctx.registered.openfoam_demo
  assert.deepEqual(t.output.schema.required, ['ok'])
  assert.equal(typeof t.output.render, 'function')
  assert.equal(t.isConcurrencySafe({}), false)
  assert.deepEqual(t.output.render({}, { ok: true }), [{ type: 'text', text: '{\n  "ok": true\n}' }])
})

test('register keeps a custom render and a custom safety classifier', () => {
  const ctx = fakeCtx()
  const render = () => [{ type: 'text', text: 'custom' }]
  const reg = makeRegistry(ctx, { RENDERS: { openfoam_demo: render } })
  reg.register(tool({ isConcurrencySafe: () => true }))
  const t = ctx.registered.openfoam_demo
  assert.equal(t.output.render, render)
  assert.equal(t.isConcurrencySafe({}), true)
})

test('wrapped execute strips undefined from results and counts calls', async () => {
  const ctx = fakeCtx()
  const reg = makeRegistry(ctx)
  reg.register(tool({ execute: async () => ({ ok: true, region: undefined, n: 1 }) }))
  const r = await ctx.registered.openfoam_demo.execute({})
  assert.deepEqual(r, { ok: true, n: 1 })
  const rep = reg.report()
  assert.equal(rep.calls, 1)
  assert.deepEqual(rep.called, [{ name: 'openfoam_demo', count: 1, failed: 0 }])
  assert.deepEqual(rep.unused, [])
  reg.register(tool({ name: 'openfoam_never', execute: async () => ({ ok: true }) }))
  assert.deepEqual(reg.report().unused, ['openfoam_never'])
  reg.reset()
  assert.equal(reg.report().calls, 0)
})

test('wrapped execute records a failure and rethrows', async () => {
  const ctx = fakeCtx()
  const reg = makeRegistry(ctx)
  reg.register(tool({ name: 'openfoam_boom', execute: async () => { throw new Error('boom') } }))
  await assert.rejects(() => ctx.registered.openfoam_boom.execute({}), /boom/)
  const rep = reg.report()
  assert.equal(rep.called[0].failed, 1)
})
