// Tool-level tests: boot the plugin with a fake ctx and drive the tools
// against synthetic cases (no OpenFOAM install needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
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
    'system/fvSchemes': 'ddtSchemes { default Euler; }\ndivSchemes { default none; div(phi,k) bounded Gauss limitedLinear 0.05; }\n',
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

test('version_info reports the bundle version and accepts distribution', async () => {
  const tools = registry()
  assert.ok(tools.openfoam_version_info.parameters.properties.distribution)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const r = await tools.openfoam_version_info.execute({})
  assert.equal(r.plugin.name, pkg.name)
  assert.equal(r.plugin.version, pkg.version)
})

test('version_info answers with the plugin identity even without OpenFOAM', async () => {
  // CI has no OpenFOAM: the tool must still say which build is loaded instead of
  // failing with no identity at all (that broke the release pipeline once).
  const tools = registry({ foamRoots: { org: '/nonexistent/openfoam14' } })
  const r = await tools.openfoam_version_info.execute({})
  assert.equal(r.ok, false)
  assert.match(r.error, /bashrc|foamRoot/)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(r.plugin.name, pkg.name)
  assert.equal(r.plugin.version, pkg.version)
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


// DSH rejects tool output that is not lossless JSON: an `undefined` field makes
// the whole tool call fail ("returned invalid output"). Guard every new tool.
function assertJsonSafe(value, path = 'value') {
  if (value === undefined) assert.fail(`${path} is undefined`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach((v, i) => assertJsonSafe(v, `${path}[${i}]`)); return }
  for (const [k, v] of Object.entries(value)) assertJsonSafe(v, `${path}.${k}`)
}

function multiRegionCase() {
  return makeCase({
    'system/controlDict': 'application foamMultiRun;\nstartTime 0;\nendTime 10;\nregionSolvers { fluid multicomponentFluid; solid solid; }\n',
    'system/fluid/fvSchemes': 'ddtSchemes { default localEuler; }\n',
    'system/solid/fvSchemes': 'ddtSchemes { default Euler; }\n',
    'constant/fluid/polyMesh/boundary': BOUNDARY,
    'constant/solid/polyMesh/boundary': '2\n(\n    solid_to_fluid { type mappedWall; nFaces 4; startFace 0; }\n    outlet_solid { type patch; nFaces 4; startFace 4; }\n)\n',
    'constant/fluid/thermophysicalProperties': 'thermoType { type hePsiThermo; }\n',
    '0/fluid/T': 'internalField uniform 300;\nboundaryField { inlet { type fixedValue; value uniform 300; } }\n',
    '0/solid/T': 'internalField uniform 300;\n',
  })
}

test('multi-region case: inspect_case and case_probe_facts expose regions', async () => {
  const dir = multiRegionCase()
  try {
    const tools = registry()
    const i = await tools.openfoam_inspect_case.execute({ casePath: dir })
    assert.deepEqual(i.regions, ['fluid', 'solid'])
    assert.equal(i.regionSolvers.fluid, 'multicomponentFluid')
    assert.equal(i.regionDetails.length, 2)
    assert.equal(i.regionDetails[0].patches.length, 3)
    assert.ok(i.fields.includes('T'))
    const p = await tools.openfoam_inspect_case.execute({ case_path: dir, facts: true })
    assert.deepEqual(p.regions, ['fluid', 'solid'])
    assert.equal(p.region_governing.find((g) => g.region === 'fluid').compressible, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read_dict resolves multi-region paths without double prefixes', async () => {
  const dir = multiRegionCase()
  try {
    const tools = registry()
    for (const f of ['fluid/fvSchemes', 'system/fluid/fvSchemes']) {
      const r = await tools.openfoam_read_dict.execute({ casePath: dir, file: f })
      assertJsonSafe(r)
      assert.equal(r.ok, true, f)
      assert.equal(r.dict.ddtSchemes.default, 'localEuler')
    }
    const c = await tools.openfoam_read_dict.execute({ casePath: dir, file: 'fluid/thermophysicalProperties' })
    assert.equal(c.ok, true)
    const zero = await tools.openfoam_read_dict.execute({ casePath: dir, file: '0/fluid/T' })
    assert.equal(zero.ok, true)
    assert.equal(zero.dict.internalField, 'uniform 300')
    const reg = await tools.openfoam_read_dict.execute({ casePath: dir, file: 'fvSchemes', region: 'solid' })
    assertJsonSafe(reg)
    assert.equal(reg.ok, true)
    assert.equal(reg.dict.ddtSchemes.default, 'Euler')
    const bad = await tools.openfoam_read_dict.execute({ casePath: dir, file: 'nope' })
    assertJsonSafe(bad)
    assert.equal(bad.ok, false)
    assert.ok(bad.hint.includes('multi-region'))
    assert.ok(bad.available.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dict_set rewrites one entry atomically, keeps a backup and appends on demand', async () => {
  const dir = makeCase({ 'system/controlDict': 'application icoFoam;\nwriteInterval 1;\n' })
  try {
    const tools = registry()
    const dry = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'controlDict', entry: 'writeInterval', value: '0.01', dryRun: true })
    assertJsonSafe(dry)
    assert.equal(dry.ok, true)
    assert.equal(dry.old, '1')
    assert.ok(!readFileSync(join(dir, 'system/controlDict'), 'utf8').includes('0.01'))
    const real = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'controlDict', entry: 'writeInterval', value: '0.01' })
    assert.equal(real.ok, true)
    assert.ok(readFileSync(join(dir, 'system/controlDict'), 'utf8').includes('writeInterval 0.01;'))
    assert.ok(existsSync(join(dir, 'system/controlDict.bak')))
    const miss = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'controlDict', entry: 'noSuchKey', value: '1' })
    assertJsonSafe(miss)
    assert.equal(miss.ok, false)
    assert.ok(miss.hint.includes('append'))
    const added = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'controlDict', entry: 'writeFormat', value: 'ascii', append: true })
    assert.equal(added.ok, true)
    assert.ok(readFileSync(join(dir, 'system/controlDict'), 'utf8').includes('writeFormat ascii;'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clean lists artefacts in a dry run and removes them on demand', async () => {
  const dir = makeCase({
    'system/controlDict': 'application icoFoam;\n',
    '0/U': '',
    '1/U': '',
    '2.5/U': '',
    'log.run': 'x',
    'postProcessing/forces/0/forces.dat': '0 0 0\n',
  })
  mkdirSync(join(dir, 'processor0'), { recursive: true })
  try {
    const tools = registry()
    const dry = await tools.openfoam_clean.execute({ casePath: dir })
    assertJsonSafe(dry)
    assert.equal(dry.dryRun, true)
    assert.deepEqual(dry.candidates.map((c) => c.rel).sort(), ['1', '2.5', 'log.run'])
    assert.ok(existsSync(join(dir, '1')))
    const real = await tools.openfoam_clean.execute({ casePath: dir, what: ['logs', 'timeDirs', 'processorDirs', 'postProcessing'], dryRun: false })
    assert.equal(real.ok, true)
    for (const gone of ['1', '2.5', 'log.run', 'processor0', 'postProcessing']) assert.ok(!existsSync(join(dir, gone)), gone)
    for (const kept of ['0', 'system']) assert.ok(existsSync(join(dir, kept)), kept)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('solve_verify reports RUNNING on a live multi-region log', async () => {
  const dir = makeCase({ 'system/controlDict': 'application foamMultiRun;\nendTime 300;\n' })
  try {
    const log = join(dir, 'log.foamMultiRun')
    writeFileSync(log, readFileSync(new URL('./fixtures/log.foamMultiRun.running', import.meta.url), 'utf8'))
    const tools = registry()
    const p = await tools.openfoam_solve_verify.execute({ log_path: log })
    assertJsonSafe(p)
    assert.equal(p.ok, true)
    assert.equal(p.state, 'running')
    assert.ok(p.time > 0)
    assert.ok(p.steps >= 5)
    assert.ok(p.secondsPerStep > 0)
    assert.equal(p.endTime, 300)
    assert.ok(p.eta)
    const v = await tools.openfoam_solve_verify.execute({ log_path: log })
    assertJsonSafe(v)
    assert.equal(v.state, 'running')
    assert.equal(v.decision, 'RUNNING')
    assert.equal(v.pass, null)
    assert.equal(v.metrics.finished, false)
    assert.equal(v.metrics.diverged, false)
    assert.ok(v.metrics.timeSteps >= 5)
    assert.equal(v.casePath, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('usage_report counts tool calls and lists unused tools', async () => {
  const tools = registry()
  await tools.openfoam_usage_report.execute({ reset: true })
  await tools.openfoam_compute_first_layer.execute({ U_ref: 1, L_ref: 1 })
  const u = await tools.openfoam_usage_report.execute({})
  assert.ok(u.called.some((c) => c.name === 'openfoam_compute_first_layer'))
  assert.ok(u.unused.includes('openfoam_render'))
  assert.ok(u.calls >= 2)
})

test('command whitelist allows mpirun-wrapped apps and rejects the rest', async () => {
  const { commandAllowed } = await import('../lib/of-case.js')
  const ok = commandAllowed('mpirun -np 5 foamMultiRun -parallel')
  assert.equal(ok.ok, true)
  assert.equal(ok.app, 'foamMultiRun')
  assert.equal(commandAllowed('mpirun -np 0 foamMultiRun -parallel').ok, false)
  // without -parallel each rank would run its own serial copy of the case
  assert.equal(commandAllowed('mpirun -np 5 foamMultiRun').ok, false)
  assert.equal(commandAllowed('bash -c ls').ok, false)
  assert.equal(commandAllowed('checkMesh && rm -rf /').ok, false)
  assert.equal(commandAllowed('mySolver', ['mySolver']).ok, true)
})

test('core prompt comes from CORE.md and reloads without a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-core-'))
  const file = join(dir, 'CORE.md')
  writeFileSync(file, '# core v1\nuse openfoam_read_dict\n')
  try {
    const captured = []
    apply(
      { systemPrompt: { section: (s) => captured.push(s) }, skills: { register() {} }, tools: { register() {} } },
      { caseRoots: [], corePath: file },
    )
    assert.equal(captured.length, 1)
    const section = captured[0]
    assert.equal(section.name, 'openfoam-workbench:core')
    assert.equal(section.order, 250)
    assert.equal(section.interpolate, false)
    assert.equal(typeof section.text, 'function')
    assert.equal(section.text(), '# core v1\nuse openfoam_read_dict')
    writeFileSync(file, '# core v2\nuse openfoam_source_search\n')
    assert.equal(section.text(), '# core v2\nuse openfoam_source_search')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply fails loudly when CORE.md is missing or empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-core2-'))
  const ctx = { systemPrompt: { section() {} }, skills: { register() {} }, tools: { register() {} } }
  try {
    assert.throws(() => apply(ctx, { caseRoots: [], corePath: join(dir, 'nope.md') }), /CORE\.md is missing or empty/)
    writeFileSync(join(dir, 'CORE.md'), '   \n\n')
    assert.throws(() => apply(ctx, { caseRoots: [], corePath: join(dir, 'CORE.md') }), /CORE\.md is missing or empty/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the shipped CORE.md stays within the prompt budget and keeps the routing markers', () => {
  const text = readFileSync(new URL('../CORE.md', import.meta.url), 'utf8')
  assert.ok(Buffer.byteLength(text) <= 3072, `CORE.md grew to ${Buffer.byteLength(text)} bytes; keep the always-on prompt under 3 KB`)
  for (const marker of ['openfoam_source_search', 'openfoam_read_dict', 'openfoam_dict_set', 'openfoam_run_watch', 'openfoam_solve_verify', 'openfoam_usage_report', 'openfoam_clean']) {
    assert.ok(text.includes(marker), `CORE.md lost the routing marker ${marker}`)
  }
  // The maths rule is a user requirement, not decoration: it must survive the
  // 3 KB budget trimming that keeps happening to this file.
  assert.match(text, /LaTeX/, 'CORE.md lost the LaTeX rule for maths')
  assert.match(text, /\$x\^2\$/, 'CORE.md no longer shows the inline form')
  assert.match(text, /\$\$\.\.\.\$\$/, 'CORE.md no longer shows the display form')
})

test('an explicit foamRoot wins over environment discovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-explicit-'))
  try {
    mkdirSync(join(root, 'applications/modules/incompressibleFluid'), { recursive: true })
    mkdirSync(join(root, 'applications/legacy/incompressible/icoFoam/Make'), { recursive: true })
    writeFileSync(join(root, 'applications/legacy/incompressible/icoFoam/Make/files'), 'icoFoam.C\n\nEXE = $(FOAM_APPBIN)/icoFoam\n')
    const tools = registry({ foamRoot: root })
    const r = await tools.openfoam_list_solvers.execute({})
    const names = r.solvers.map((s) => s.name)
    assert.ok(names.includes('incompressibleFluid'), 'the fixture module must be listed, not a discovered install')
    assert.ok(names.includes('icoFoam'))
    assert.ok(!names.includes('chtMultiRegionFoam'), 'no discovered solver may leak in when foamRoot is set')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply never reads an uninjected service property', () => {
  const tools = {}
  const target = {
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register(t) { tools[t.name] = t } },
    get: () => undefined,
  }
  // Cordis' restricted context throws on any property that is not injected;
  // reading ctx.approval directly would abort the whole plugin mount.
  const ctx = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  apply(ctx, { caseRoots: [] })
  assert.ok(tools.openfoam_dict_set, 'the tool set must mount')
  assert.ok(tools.openfoam_dict_undo)
})
