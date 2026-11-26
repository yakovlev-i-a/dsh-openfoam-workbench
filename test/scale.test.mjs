// Case-creation conventions: the <case>.foam file and the geometry-scale gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { ensureFoamFile, findFoamFile, caseBBox } from '../lib/of-case.js'

function makeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}
function points(mn, mx) {
  return `FoamFile { format ascii; class vectorField; object points; }\n\n2\n(\n(${mn.join(' ')})\n(${mx.join(' ')})\n)\n`
}
function registry(config = {}) {
  const tools = {}
  apply({ systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } }, { caseRoots: [], ...config })
  return tools
}

test('ensureFoamFile writes <case>.foam exactly once and ignores case.foam', () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-foam-')), { 'case.foam': '', 'system/controlDict': 'application icoFoam;\n' })
  const caseDir = join(dir, 'myCase')
  mkdirSync(caseDir)
  writeFileSync(join(caseDir, 'case.foam'), '')
  try {
    const first = ensureFoamFile(caseDir)
    assert.equal(first.ok, true)
    assert.equal(first.name, 'myCase.foam')
    assert.equal(first.created, true)
    assert.equal(ensureFoamFile(caseDir).created, false)
    assert.deepEqual(readdirSync(caseDir).sort(), ['case.foam', 'myCase.foam'])
    assert.equal(findFoamFile(caseDir), join(caseDir, 'myCase.foam'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('caseBBox reads the polyMesh points and reports the largest extent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-bbox-'))
  try {
    makeTree(dir, { 'constant/polyMesh/points': points([0, 0, 0], [5, 2, 1]) })
    const b = caseBBox(dir)
    assert.equal(b.ok, true)
    assert.deepEqual(b.extent, [5, 2, 1])
    assert.equal(b.maxExtent, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the geometry-scale payload is identical in every language', async () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-scale-lang-')), {
    'system/controlDict': 'application icoFoam;\nendTime 1;\ndeltaT 1;\n',
    'system/fvSchemes': 'ddtSchemes { default Euler; }\n',
    'constant/polyMesh/points': points([0, 0, 0], [5, 2, 1]),
  })
  try {
    // ru/en differ only in the agent's wording, never in the tool payload
    const ru = await registry({ scaleAskAbove: 0.1, language: 'ru' }).openfoam_check.execute({ casePath: dir })
    const en = await registry({ scaleAskAbove: 0.1, language: 'en' }).openfoam_check.execute({ casePath: dir })
    assert.deepEqual(ru.needs_input, en.needs_input)
    assert.equal(ru.needs_input.kind, 'geometry-scale')
    assert.deepEqual(ru.needs_input.data, { extent_m: 5, askAbove_m: 0.1 })
    assert.deepEqual(ru.needs_input.options.map((o) => o.id), ['metres-ok', 'millimetres', 'other'])
    assert.equal(ru.needs_input.question, undefined, 'no user-facing prose belongs in the payload')

    // mesh_plan raises the same decision through the same payload
    const planTools = registry({ scaleAskAbove: 0.1, language: 'ru', caseRoots: [join(dir, '..')] })
    const stl = await planTools.openfoam_stl_generate.execute({ casePath: dir, name: 'big', shape: 'box', params: { lx: 5, ly: 2, lz: 1 } })
    assert.equal(stl.ok, true)
    const plan = await planTools.openfoam_mesh_plan.execute({
      casePath: dir,
      stl_path: join(dir, 'constant/triSurface/big.stl'),
      domain: { type: 'external', upstream: 2, downstream: 3, lateral: 2, vertical_top: 2, vertical_bottom: 2 },
      target_cell_size: 0.5,
    })
    assert.equal(plan.ok, true, JSON.stringify(plan).slice(0, 200))
    assert.deepEqual(plan.needs_input, ru.needs_input)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check asks about units when the mesh box is bigger than scaleAskAbove', async () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-scale-')), {
    'system/controlDict': 'application icoFoam;\nendTime 1;\ndeltaT 1;\n',
    'system/fvSchemes': 'ddtSchemes { default Euler; }\n',
    'constant/polyMesh/points': points([0, 0, 0], [5, 2, 1]),
  })
  try {
    const tools = registry({ scaleAskAbove: 0.1 })
    const big = await tools.openfoam_check.execute({ casePath: dir })
    assert.equal(big.ok, true)
    assert.ok(big.findings.some((f) => f.rule === 'geometry-scale'), 'expected the geometry-scale finding')
    assert.equal(big.needs_input.kind, 'geometry-scale')
    assert.equal(big.needs_input.options.length, 3)
    const rendered = tools.openfoam_check.output.render({}, big)
    assert.match(rendered[0].text, /ask_user_question/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check stays quiet on a small mesh and when the gate is disabled', async () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-scale2-')), {
    'system/controlDict': 'application icoFoam;\nendTime 1;\ndeltaT 1;\n',
    'system/fvSchemes': 'ddtSchemes { default Euler; }\n',
    'constant/polyMesh/points': points([0, 0, 0], [0.05, 0.02, 0.01]),
  })
  try {
    assert.equal((await registry({ scaleAskAbove: 0.1 }).openfoam_check.execute({ casePath: dir })).needs_input, undefined)
    const big = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-scale3-')), {
      'system/controlDict': 'application icoFoam;\nendTime 1;\ndeltaT 1;\n',
      'constant/polyMesh/points': points([0, 0, 0], [5, 2, 1]),
    })
    try {
      assert.equal((await registry({ scaleAskAbove: 0 }).openfoam_check.execute({ casePath: big })).needs_input, undefined)
    } finally {
      rmSync(big, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mesh_plan creates <case>.foam and asks about units for a metre-sized STL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-plan-'))
  const caseDir = join(dir, 'duct')
  mkdirSync(caseDir)
  try {
    const tools = registry({ scaleAskAbove: 0.1, caseRoots: [dir] })
    const big = await tools.openfoam_stl_generate.execute({ casePath: 'duct', name: 'big', shape: 'box', params: { lx: 5, ly: 2, lz: 1 } })
    assert.equal(big.ok, true)
    const plan = await tools.openfoam_mesh_plan.execute({
      casePath: 'duct',
      stl_path: 'constant/triSurface/big.stl',
      domain: { type: 'external', upstream: 2, downstream: 3, lateral: 2, vertical_top: 2, vertical_bottom: 2 },
      target_cell_size: 0.5,
    })
    assert.equal(plan.ok, true)
    assert.ok(plan.needs_input && plan.needs_input.kind === 'geometry-scale', 'expected a unit question')
    assert.equal(plan.foamFile, 'duct.foam')
    assert.ok(existsSync(join(caseDir, 'duct.foam')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('caseBBox reads only the vertices block and applies scale', () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-bbox-scl-')), {
    'system/blockMeshDict': [
      'vertices',
      '(',
      '    (0 0 0) (0.1 0 0) (0.1 0.04 0) (0 0.04 0)',
      '    (0 0 0.05) (0.1 0 0.05) (0.1 0.04 0.05) (0 0.04 0.05)',
      ');',
      'blocks',
      '(',
      '    hex (0 1 2 3 4 5 6 7) (30 10 10) simpleGrading (1 1 1);',
      ');',
      'scale 0.146;',
    ].join('\n') + '\n',
  })
  try {
    const b = caseBBox(dir)
    assert.equal(b.ok, true, JSON.stringify(b))
    // 0.1 * 0.146 = 0.0146 (NOT the 30 from the block resolution)
    assert.ok(b.max[0] < 0.02, `expected a scaled ~0.0146 m, got ${JSON.stringify(b.max)}`)
    assert.equal(b.scale, 0.146)
    assert.ok(b.maxExtent < 0.02, 'extent must come from scaled vertices, not the hex resolution')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the scale gate ignores floating-point noise at the threshold', async () => {
  const { scaleGateApplies } = await import('../lib/needs-input.js')
  assert.equal(scaleGateApplies(0.1, 0.1), false)
  assert.equal(scaleGateApplies(0.10000000005, 0.1), false, '5e-11 above the limit is noise')
  assert.equal(scaleGateApplies(0.11, 0.1), true)
  assert.equal(scaleGateApplies(5, 0), false, '0 disables the gate')

  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-scale-exact-')), {
    'system/controlDict': 'application icoFoam;\nendTime 1;\ndeltaT 1;\n',
    'system/fvSchemes': 'ddtSchemes { default Euler; }\n',
    'constant/polyMesh/points': points([0, 0, 0], [0.1, 0.05, 0.05]),
  })
  try {
    const tools = registry({ scaleAskAbove: 0.1 })
    const r = await tools.openfoam_check.execute({ casePath: dir })
    assert.equal(r.needs_input, undefined, 'exactly at the threshold must not ask')
    assert.ok(!r.findings.some((f) => f.rule === 'geometry-scale'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mesh_plan writes a runnable snappy dict and a placeholder controlDict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-plan2-'))
  const caseDir = join(root, 'box')
  mkdirSync(caseDir)
  try {
    const tools = registry({ scaleAskAbove: 0, caseRoots: [root] })
    const stl = await tools.openfoam_stl_generate.execute({ casePath: 'box', name: 'ball', shape: 'sphere', params: { r: 0.02, segments: 32, rings: 16 } })
    assert.equal(stl.ok, true)
    const plan = await tools.openfoam_mesh_plan.execute({
      casePath: 'box',
      stl_path: 'constant/triSurface/ball.stl',
      domain: { type: 'box', bbox_min: [-0.05, -0.05, -0.05], bbox_max: [0.05, 0.05, 0.05] },
      target_cell_size: 0.01,
      location_in_mesh: [-0.045, 0, 0],
    })
    assert.equal(plan.ok, true, JSON.stringify(plan).slice(0, 200))
    const snappy = readFileSync(join(caseDir, 'system/snappyHexMeshDict'), 'utf8')
    assert.match(snappy, /errorReduction\s+0\.75;/)
    assert.match(snappy, /nSmoothScale\s+4;/)
    assert.match(snappy, /maxIter\s+100;/)
    assert.ok(plan.written.includes('system/controlDict'), 'the placeholder controlDict must be reported')
    assert.ok(plan.notes.some((n) => /placeholder system\/controlDict/.test(n)))
    const cd = readFileSync(join(caseDir, 'system/controlDict'), 'utf8')
    assert.match(cd, /application\s+foamRun;/)
    // a second plan must not overwrite the existing controlDict
    const again = await tools.openfoam_mesh_plan.execute({
      casePath: 'box', stl_path: 'constant/triSurface/ball.stl',
      domain: { type: 'box', bbox_min: [-0.05, -0.05, -0.05], bbox_max: [0.05, 0.05, 0.05] },
      target_cell_size: 0.01, location_in_mesh: [-0.045, 0, 0],
    })
    assert.equal(again.ok, true)
    assert.ok(!again.written.includes('system/controlDict'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
