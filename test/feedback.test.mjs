// Regressions from the first external review (BFER series, ESI v2512).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { firstFatalLine } from '../lib/of-engine.js'

function makeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

function registry(config = {}) {
  const tools = {}
  apply({ systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } }, { caseRoots: [], ...config })
  return tools
}

// 2.7: initial fields in 0_orig/ must be seen by every reader, and patches come
// from the boundary file, not from a field that may not exist yet.
test('0_orig is read like 0/ (fields, patches, restore)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-zero-'))
  try {
    const caseDir = join(root, 'case0orig')
    makeTree(caseDir, {
      'system/controlDict': 'application icoFoam;\n',
      'system/fvSchemes': 'ddtSchemes { default Euler; }\n',
      'system/fvSolution': 'PISO { nCorrectors 2; }\n',
      'constant/polyMesh/boundary': '2\n(\n    inlet { type patch; nFaces 1; startFace 0; }\n    outlet { type patch; nFaces 1; startFace 1; }\n)\n',
      'constant/polyMesh/points': '2\n(\n(0 0 0)\n(1 1 1)\n)\n',
      '0_orig/U': 'boundaryField { inlet { type fixedValue; value uniform (1 0 0); } outlet { type zeroGradient; } }\n',
      '0_orig/p': 'boundaryField { inlet { type zeroGradient; } outlet { type fixedValue; value uniform 0; } }\n',
    })
    const tools = registry({ caseRoots: [root] })
    const inspect = await tools.openfoam_inspect_case.execute({ casePath: 'case0orig' })
    assert.deepEqual(inspect.fields.sort(), ['U', 'p'], 'inspect_case must read 0_orig/')

    const facts = await tools.openfoam_case_probe_facts.execute({ casePath: 'case0orig' })
    assert.deepEqual([...facts.fields_in_0].sort(), ['U', 'p'])
    assert.equal(facts.fields_from, '0_orig')
    assert.deepEqual([...facts.patches].sort(), ['inlet', 'outlet'], 'patches come from polyMesh/boundary')

    const restored = await tools.openfoam_run.execute({ casePath: 'case0orig', command: 'restore0Dir' })
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.ok(existsSync(join(caseDir, '0', 'U')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 2.5: a wrong parameter name must name the accepted ones instead of "cannot read ".
test('log tools accept path/log_path and explain a wrong name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-logarg-'))
  try {
    const log = join(root, 'run.log')
    writeFileSync(log, 'Time = 0.1\nsolving for Ux, Initial residual = 0.01, Final residual = 1e-09, No Iterations 3\nTime = 0.2\nsolving for Ux, Initial residual = 1e-05, Final residual = 1e-10, No Iterations 2\nEnd\n')
    const tools = registry({ caseRoots: [root] })
    const viaPath = await tools.openfoam_residual_series.execute({ path: log })
    assert.equal(viaPath.ok, true)
    const viaLogPath = await tools.openfoam_residual_series.execute({ log_path: log })
    assert.equal(viaLogPath.ok, true)
    assert.equal(viaLogPath.timeSteps, viaPath.timeSteps)

    const wrong = await tools.openfoam_residual_series.execute({ log: log })
    assert.equal(wrong.ok, false)
    assert.match(wrong.error, /log_path \(alias: path\) is required/)
    assert.match(wrong.error, /got: log/)

    const progress = await tools.openfoam_run_progress.execute({ path: log })
    assert.equal(progress.ok, true, JSON.stringify(progress))
    const verdict = await tools.openfoam_solve_verify.execute({ path: log })
    assert.equal(verdict.ok, true, JSON.stringify(verdict))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 2.6: the machine-readable verdict must agree with the header.
test('mesh_verify on a case without polyMesh reports failed:true with the reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-meshfail-'))
  try {
    const caseDir = join(root, 'nomesh')
    makeTree(caseDir, { 'system/controlDict': 'application icoFoam;\n', 'system/fvSchemes': 'ddtSchemes { default Euler; }\n' })
    const tools = registry({ caseRoots: [root] })
    const env = await tools.openfoam_env_check.execute({})
    if (!env.ok) return // no OpenFOAM on this host
    const r = await tools.openfoam_mesh_verify.execute({ casePath: 'nomesh' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.pass, false)
    assert.equal(r.failed, true, 'failed must mirror pass')
    assert.ok(r.problems.length > 0, 'the OpenFOAM error must reach the result')
    assert.match(r.problems.join(' '), /FOAM FATAL ERROR|cannot find|not found/i)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 2.8: a near miss lists similar files and points at the discovery tool.
test('read_source suggests near misses and names find_source', async () => {
  const tools = registry({})
  const env = await tools.openfoam_version_info.execute({})
  if (!env.ok) return
  const r = await tools.openfoam_read_source.execute({ path: 'src/finiteVolume/limitedLinearLimiter.H' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not found/)
  assert.match(r.hint, /openfoam_find_source/)
  if (r.suggestions) assert.ok(r.suggestions.some((s) => /limitedLinear\.H$/.test(s)), JSON.stringify(r.suggestions))
})

test('firstFatalLine keeps the OpenFOAM message and drops the stack', () => {
  const text = 'Create time\n\n--> FOAM FATAL ERROR: \ncannot find file "/tmp/case/system/controlDict"\n\n    From function ...\n    file: ...\n'
  const line = firstFatalLine(text)
  assert.match(line, /^FOAM FATAL ERROR: cannot find file/)
  assert.ok(line.length < 300)
  assert.equal(firstFatalLine(''), '')
})

// 2.4: on a log larger than the tail window, steps must describe the whole run
// and the window must say so.
test('steps counts the whole log while the window is reported separately', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'ofwb-steps-'))
  try {
    const log = join(root, 'big.log')
    const lines = []
    for (let i = 1; i <= 3000; i += 1) {
      lines.push(`Time = ${i}`)
      lines.push(`solving for Ux, Initial residual = ${(1e-3 / (i + 1)).toExponential(3)}, Final residual = 1e-12, No Iterations 2`)
    }
    lines.push('End')
    writeFileSync(log, lines.join('\n') + '\n')
    const tools = registry({ caseRoots: [root], logTailBytes: 4000 })
    const progress = await tools.openfoam_run_progress.execute({ log_path: log })
    assert.equal(progress.ok, true, JSON.stringify(progress).slice(0, 300))
    assert.equal(progress.logScan.truncated, true, 'the fixture must exceed the tail window')
    assert.equal(progress.stepsTotal, 3000)
    assert.equal(progress.steps, 3000)
    assert.ok(progress.stepsInWindow < 3000, `window should be smaller, got ${progress.stepsInWindow}`)
    assert.deepEqual(progress.logWindow.truncated, true)
    const verdict = await tools.openfoam_solve_verify.execute({ log_path: log })
    assert.equal(verdict.steps, 3000)
    assert.equal(verdict.metrics.timeSteps, 3000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
