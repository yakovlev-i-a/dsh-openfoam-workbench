// Tool-level tests: boot the plugin with a fake ctx and drive the tools
// against synthetic cases (no OpenFOAM install needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function makeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}
function makeCase(files) {
  return makeTree(mkdtempSync(join(tmpdir(), 'ofwb-tools-')), files)
}
function registry(config = {}) {
  const tools = {}
  apply(
    { systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } },
    { foamRoot: '', openfoamBash: '', caseRoots: [], ...config },
  )
  return tools
}

const BOUNDARY = `5
(
    inlet { type patch; nFaces 4; startFace 0; }
    outlet { type patch; nFaces 4; startFace 4; }
    walls { type wall; nFaces 8; startFace 8; }
)
`

test('inspect_case parses solver, fields and patches', async () => {
  const dir = makeCase({
    'system/controlDict': 'solver multicomponentFluid;\nstartTime 0;\nendTime 2e-6;\ndeltaT 1e-6;\n',
    '0/U': 'boundaryField { inlet { type fixedValue; value uniform (1 0 0); } }\n',
    '0/p': 'boundaryField { outlet { type zeroGradient; } }\n',
    'constant/polyMesh/boundary': BOUNDARY,
  })
  try {
    const r = await registry().openfoam_inspect_case.execute({ casePath: dir })
    assert.equal(r.ok, true)
    assert.equal(r.solver, 'multicomponentFluid')
    assert.ok(r.fields.includes('U') && r.fields.includes('p'))
    assert.ok(r.patches.some((p) => p.name === 'inlet' && p.type === 'patch'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch_diff returns patches and diffs against a snapshot', async () => {
  const dir = makeCase({ 'constant/polyMesh/boundary': BOUNDARY })
  try {
    const tools = registry()
    const r = await tools.openfoam_patch_diff.execute({ casePath: dir })
    assert.equal(r.ok, true)
    assert.equal(r.patches.length, 3)
    const snap = JSON.stringify(r.patches.slice(0, 2))
    const d = await tools.openfoam_patch_diff.execute({ casePath: dir, snapshot_before: snap })
    assert.deepEqual(d.diff.added, ['walls'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check flags limiter=1 on a synthetic case', async () => {
  const dir = makeCase({
    'system/controlDict': 'application icoFoam;\nstartTime 0;\nendTime 100;\ndeltaT 1;\nwriteControl timeStep;\nwriteInterval 10;\n',
    'system/fvSchemes': 'ddtSchemes { default Euler; }\ndivSchemes { default none; div(phi,k) bounded Gauss limitedLinear 1; }\n',
    '0/k': 'boundaryField { inlet { type fixedValue; value uniform 0; } }\n',
  })
  try {
    const r = await registry().openfoam_check.execute({ casePath: dir })
    assert.ok(r.findings.some((f) => f.rule === 'limiter-wide-open'))
    const scoped = await registry().openfoam_check.execute({ casePath: dir, file: 'controlDict' })
    assert.ok(!scoped.findings.some((f) => f.rule === 'limiter-wide-open'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('compute_first_layer returns a positive thickness and layer count', async () => {
  const r = await registry().openfoam_compute_first_layer.execute({ U_ref: 10, L_ref: 1 })
  assert.equal(r.ok, true)
  assert.ok(r.first_layer_thickness > 0 && r.first_layer_thickness < 1e-3)
  assert.ok(r.n_layers >= 1)
})

test('diagnose_error matches the FPE pattern and a learned pattern', async () => {
  const tools = registry()
  const r = await tools.openfoam_diagnose_error.execute({ text: '--> FOAM FATAL ERROR: Floating point exception (FPE)' })
  assert.equal(r.matched, true)
  assert.ok(r.hits.some((h) => /FPE|NaN\/Inf/.test(h.category)))

  const dir = mkdtempSync(join(tmpdir(), 'ofwb-exp-'))
  try {
    const t2 = registry({ experienceDir: dir })
    await t2.openfoam_learn_error_pattern.execute({ pattern: 'ZZZ-9911', category: 'test pattern' })
    const d = await t2.openfoam_diagnose_error.execute({ text: 'boom ZZZ-9911 boom' })
    assert.ok(d.hits.some((h) => /learned/.test(h.category)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read_dict parses controlDict', async () => {
  const dir = makeCase({ 'system/controlDict': 'application icoFoam;\nendTime 3000;\n' })
  try {
    const r = await registry().openfoam_read_dict.execute({ casePath: dir, file: 'controlDict' })
    assert.equal(r.ok, true)
    assert.equal(r.dict.application, 'icoFoam')
    assert.equal(r.dict.endTime, '3000')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('experience save/recall/list round-trip and dedup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-exp2-'))
  try {
    const tools = registry({ experienceDir: dir })
    const card = { title: 'Box mesh quick check', triggers: ['box', 'blockmesh'], recipe: ['stl', 'plan'] }
    const s1 = await tools.openfoam_experience_save.execute(card)
    const s2 = await tools.openfoam_experience_save.execute(card)
    assert.equal(s1.ok, true)
    assert.equal(s2.deduped, true)
    const rec = await tools.openfoam_experience_recall.execute({ query: 'box blockmesh' })
    assert.equal(rec.count, 1)
    const list = await tools.openfoam_experience_list.execute({})
    assert.equal(list.count, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('list_solvers classifies modules and reports distribution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-foam-'))
  try {
    mkdirSync(join(root, 'applications/modules/incompressibleFluid'), { recursive: true })
    mkdirSync(join(root, 'applications/solvers/chemFoam'), { recursive: true })
    mkdirSync(join(root, 'applications/legacy/incompressible/icoFoam/Make'), { recursive: true })
    writeFileSync(join(root, 'applications/legacy/incompressible/icoFoam/Make/files'), 'icoFoam.C\n\nEXE = $(FOAM_APPBIN)/icoFoam\n')
    const tools = registry({ foamRoot: root })
    const r = await tools.openfoam_list_solvers.execute({})
    assert.equal(r.ok, true)
    assert.equal(r.modular, true)
    assert.ok(/org/.test(r.distribution))
    const byName = new Map(r.solvers.map((s) => [s.name, s]))
    assert.equal(byName.get('incompressibleFluid').governing, 'incompressible single-phase')
    assert.equal(byName.get('icoFoam').governing, 'incompressible single-phase')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('durable registry: apply reconciles a dead run with End to success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-runs-'))
  try {
    writeFileSync(join(dir, 'runA.json'), JSON.stringify({ id: 'runA', casePath: '/x', command: 'echo', pid: 999999, startedAt: Date.now() - 5000, status: 'running' }))
    writeFileSync(join(dir, 'runA.log'), 'Time = 1\nsolving...\nEnd\n')
    const tools = registry({ runsDir: dir })
    const s = await tools.openfoam_solver_status.execute({ run_id: 'runA' })
    assert.equal(s.status, 'success')
    const list = await tools.openfoam_run_list.execute({})
    assert.equal(list.count, 1)
    assert.equal(list.runs[0].runId, 'runA')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('durable registry: dead pid without End becomes interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-runs2-'))
  try {
    writeFileSync(join(dir, 'runB.json'), JSON.stringify({ id: 'runB', casePath: '/x', command: 'echo', pid: 999999, startedAt: Date.now(), status: 'running' }))
    writeFileSync(join(dir, 'runB.log'), 'Time = 1\nsolving...\n')
    const tools = registry({ runsDir: dir })
    const s = await tools.openfoam_solver_status.execute({ run_id: 'runB' })
    assert.equal(s.status, 'interrupted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
