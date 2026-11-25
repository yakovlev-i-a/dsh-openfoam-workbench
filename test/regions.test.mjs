// The doctor must look inside regions: system/<r>/, 0/<r>/, constant/<r>/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkCase, checkPhysics } from '../lib/of-engine.js'
import { apply } from '../lib/index.js'

function makeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

function multiRegionCase() {
  return makeTree(mkdtempSync(join(tmpdir(), 'ofwb-regions-')), {
    'system/controlDict': 'application foamMultiRun;\nendTime 1;\ndeltaT 0.01;\n',
    'system/fluid/fvSchemes': 'ddtSchemes { default Euler; }\ndivSchemes { default none; div(phi,U) bounded Gauss limitedLinear 0.05; }\n',
    'system/solid/fvSchemes': 'ddtSchemes { default steadyState; }\ndivSchemes { default Gauss linear; }\n',
    'system/fluid/fvSolution': 'PIMPLE { nCorrectors 2; }\n',
    'system/solid/fvSolution': 'PIMPLE { nCorrectors 2; }\n',
    'constant/fluid/polyMesh/boundary': '1\n(\n    inlet { type patch; nFaces 1; startFace 0; }\n)\n',
    'constant/solid/polyMesh/boundary': '1\n(\n    wall { type wall; nFaces 1; startFace 0; }\n)\n',
    '0/fluid/U': 'boundaryField { inlet { type fixedValue; value uniform (1 0 0); } }\n',
    '0/solid/T': 'boundaryField { wall { type fixedValue; value uniform 300; } }\n',
  })
}

test('checkCase tags findings with their region and checks region dicts', () => {
  const dir = multiRegionCase()
  try {
    const findings = checkCase(dir, { regions: ['fluid', 'solid'] })
    assert.ok(findings.every((f) => !f.region || ['fluid', 'solid'].includes(f.region)))
    const limiter = findings.filter((f) => f.rule === 'limiter-wide-open')
    assert.equal(limiter.length, 1, 'only the fluid region disables the limiter (k<0.1)')
    assert.equal(limiter[0].region, 'fluid')
    assert.ok(!findings.some((f) => f.rule === 'missing-file'), 'region fvSchemes exist, so nothing is missing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a region without its own fvSchemes reports the regional path', () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-regions2-')), {
    'system/controlDict': 'application foamMultiRun;\n',
    'system/fluid/fvSchemes': 'ddtSchemes { default Euler; }\n',
  })
  try {
    const findings = checkCase(dir, { regions: ['fluid', 'solid'] })
    const missing = findings.filter((f) => f.rule === 'missing-file' && /fvSchemes/.test(f.title))
    assert.ok(missing.some((f) => f.region === 'solid' && /system\/solid\/fvSchemes/.test(f.title)), JSON.stringify(missing))
    assert.ok(!missing.some((f) => f.region === 'fluid'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the openfoam_check tool checks every region and accepts region=', async () => {
  const dir = multiRegionCase()
  try {
    const tools = {}
    apply({ systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } }, { caseRoots: [dir], scaleAskAbove: 0 })
    const all = await tools.openfoam_check.execute({ casePath: dir })
    assert.deepEqual(all.regions, ['fluid', 'solid'])
    assert.ok(all.findings.some((f) => f.region === 'fluid' && f.rule === 'limiter-wide-open'))
    const solid = await tools.openfoam_check.execute({ casePath: dir, region: 'solid' })
    assert.equal(solid.region, 'solid')
    assert.ok(!solid.findings.some((f) => f.rule === 'limiter-wide-open'))
    const unknown = await tools.openfoam_check.execute({ casePath: dir, region: 'nope' })
    assert.equal(unknown.ok, false)
    assert.deepEqual(unknown.regions, ['fluid', 'solid'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('named dimension sets and steady PIMPLE do not trigger false positives', () => {
  const dir = makeTree(mkdtempSync(join(tmpdir(), 'ofwb-regions3-')), {
    'system/controlDict': 'application foamMultiRun;\n',
    'system/fluid/fvSchemes': 'ddtSchemes { default steadyState; }\n',
    'system/fluid/fvSolution': 'PIMPLE { nCorrectors 2; nNonOrthogonalCorrectors 1; }\n',
    'constant/fluid/g': 'dimensions [acceleration];\nvalue (0 -9.81 0);\n',
    '0/fluid/p_rgh': 'boundaryField { outlet { type fixedValue; value uniform 0; } }\n',
  })
  try {
    const findings = checkPhysics(dir, 'fluid')
    assert.ok(!findings.some((f) => f.rule === 'buoyant-g-dimensions'), 'named dimensions are valid in OpenFOAM.com')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
