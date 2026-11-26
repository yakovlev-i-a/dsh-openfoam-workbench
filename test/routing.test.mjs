import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyToolCall, evaluateToolCall, resetRoutingReport, routingReport } from '../lib/routing-guard.js'

test('direct writes to case dictionaries are detected', () => {
  const hits = [
    ['bash', { command: 'echo \'libs ("x.so");\' >> system/controlDict' }],
    ['bash', { command: 'sed -i s/a/b/ constant/physicalProperties' }],
    ['bash', { command: 'python3 -c "open(\'0/U\',\'w\').write(x)"' }],
    ['write', { file_path: '/case/a/system/fvSchemes' }],
    ['edit', { file_path: 'constant/momentumTransport' }],
  ]
  for (const [tool, args] of hits) {
    assert.equal(classifyToolCall(tool, args).hit, true, `${tool} ${JSON.stringify(args)}`)
  }
})

test('reads, runs and the plugin tools themselves are not flagged', () => {
  const clean = [
    ['bash', { command: 'ls system; blockMesh; foamRun' }],
    ['bash', { command: 'grep -n libs system/controlDict' }],
    ['read', { file_path: 'system/controlDict' }],
    ['openfoam_dict_set', { file: 'controlDict', entry: 'writeInterval', value: '10' }],
    ['openfoam_run', { command: 'blockMesh' }],
    ['write', { file_path: 'notes/README.md' }],
  ]
  for (const [tool, args] of clean) {
    assert.equal(classifyToolCall(tool, args).hit, false, `${tool} ${JSON.stringify(args)}`)
  }
})

test('warn allows and records; deny refuses with a redirect; off ignores', () => {
  resetRoutingReport()
  const bashWrite = { toolName: 'bash', args: { command: 'echo x >> system/controlDict' } }
  assert.equal(evaluateToolCall({ ...bashWrite, mode: 'warn' }).decision, 'warn')
  assert.equal(routingReport().count, 1)
  const denied = evaluateToolCall({ ...bashWrite, mode: 'deny' })
  assert.equal(denied.decision, 'deny')
  assert.match(denied.reason, /openfoam_read_dict|openfoam_dict_set/)
  const before = routingReport().count
  assert.equal(evaluateToolCall({ ...bashWrite, mode: 'off' }).decision, 'allow')
  assert.equal(routingReport().count, before, 'off records nothing')
  resetRoutingReport()
  assert.equal(routingReport().count, 0)
})

test('apply registers a pre-execute hook that honours enforceToolRouting', async () => {
  const { apply } = await import('../lib/index.js')
  for (const [mode, expected] of [['deny', 'deny'], ['warn', 'allow'], ['off', 'allow']]) {
    const listeners = []
    apply({ systemPrompt: { section() {} }, skills: { register() {} }, tools: { register() {} }, on: (e, f) => listeners.push([e, f]), get: () => undefined }, { caseRoots: [], enforceToolRouting: mode })
    const hook = listeners.find(([e]) => e === 'tools/pre-execute')
    if (mode === 'off') {
      assert.equal(hook, undefined, 'off installs no listener')
      continue
    }
    assert.ok(hook, `${mode}: hook installed`)
    const out = hook[1]({ toolName: 'bash', args: { command: 'echo x >> system/controlDict' } }, () => ({ kind: 'allow' }))
    assert.equal(out.kind, expected, mode)
  }
  resetRoutingReport()
})
