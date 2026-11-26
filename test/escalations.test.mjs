import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { consumeEscalation, createEscalation, escalationsReport, resetEscalations } from '../lib/escalations.js'

function mount(cfg = {}) {
  const tools = {}
  const listeners = []
  apply({
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register(t) { tools[t.name] = t } },
    on: (event, fn) => listeners.push([event, fn]),
    get: () => undefined,
  }, { caseRoots: [], scaleAskAbove: 0, ...cfg })
  return { tools, hook: listeners.find(([e]) => e === 'tools/pre-execute')?.[1] }
}

function makeCase() {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-esc-'))
  const dir = join(root, 'caseA')
  mkdirSync(join(dir, 'system'), { recursive: true })
  writeFileSync(join(dir, 'system/controlDict'), 'application foamRun;\nwriteInterval 100;\n')
  return { root, dir }
}

test('an escalation without a failed tool call is refused', async () => {
  resetEscalations()
  const { tools } = mount({ enforceToolRouting: 'strict' })
  const r = await tools.openfoam_escalate.execute({ target: 'system/controlDict', operation: 'edit', toolsTried: ['openfoam_dict_set'], why: 'test' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not verified/)
  assert.equal(r.evidence.tried[0].calls, 0)
})

test('a failed plugin call is the evidence the escalation needs', async () => {
  resetEscalations()
  const { root, dir } = makeCase()
  try {
    const { tools, hook } = mount({ enforceToolRouting: 'strict', caseRoots: [root] })
    // make openfoam_dict_set fail on purpose (multi-line value)
    const bad = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '10\nlibs (x);' })
    assert.equal(bad.ok, false)
    const esc = await tools.openfoam_escalate.execute({ target: 'system/controlDict', operation: 'edit-multiline', toolsTried: ['openfoam_dict_set'], why: 'dict_set refuses multi-line values' })
    assert.equal(esc.ok, true, JSON.stringify(esc).slice(0, 200))
    assert.equal(esc.authority, 'auto')
    assert.equal(esc.evidence.tried[0].failed, 1)

    // the hook now lets exactly one direct write through
    const first = hook({ toolName: 'bash', args: { command: 'echo x >> system/controlDict' } }, () => ({ kind: 'allow' }))
    assert.equal(first.kind, 'allow')
    assert.match(first.escalation || esc.escalationId, /esc_/)
    const second = hook({ toolName: 'bash', args: { command: 'echo y >> system/controlDict' } }, () => ({ kind: 'allow' }))
    assert.equal(second.kind, 'deny', 'the token is single use')
    assert.match(second.reason, /openfoam_escalate/)
    assert.ok(dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('strict mode denies covered writes and allows a matching target only', async () => {
  resetEscalations()
  const { root } = makeCase()
  try {
    const { tools, hook } = mount({ enforceToolRouting: 'strict', caseRoots: [root] })
    await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'deltaT', value: '{ }' }).catch(() => {})
    const denied = hook({ toolName: 'bash', args: { command: 'echo x >> system/controlDict' } }, () => ({ kind: 'allow' }))
    assert.equal(denied.kind, 'deny')
    const allowedRead = hook({ toolName: 'bash', args: { command: 'ls system' } }, () => ({ kind: 'allow' }))
    assert.equal(allowedRead.kind, 'allow')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tokens expire and are scoped to their target', () => {
  resetEscalations()
  const registry = { history: () => [{ at: Date.now(), ok: false }] }
  const now = Date.now()
  const a = createEscalation({ target: 'system/controlDict', toolsTried: ['openfoam_dict_set'], registry, now })
  assert.equal(a.ok, true)
  assert.equal(consumeEscalation({ target: 'constant/physicalProperties', now }).ok, false, 'wrong target')
  assert.equal(consumeEscalation({ target: 'system/controlDict', now }).ok, true)
  const b = createEscalation({ target: 'system/fvSolution', toolsTried: ['openfoam_dict_set'], registry, now })
  assert.equal(consumeEscalation({ target: 'system/fvSolution', now: now + 11 * 60 * 1000 }).ok, false, 'expired')
  assert.equal(b.ok, true)
  const report = escalationsReport(now)
  assert.ok(report.count >= 2)
})

test('escalationAuthority=ask without an approval service fails closed', async () => {
  resetEscalations()
  const { root } = makeCase()
  try {
    const { tools } = mount({ enforceToolRouting: 'strict', escalationAuthority: 'ask', caseRoots: [root] })
    await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'deltaT', value: '{ }' }).catch(() => {})
    const esc = await tools.openfoam_escalate.execute({ target: 'system/controlDict', toolsTried: ['openfoam_dict_set'], why: 'x' })
    assert.equal(esc.ok, false)
    assert.match(esc.error, /approval service/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
