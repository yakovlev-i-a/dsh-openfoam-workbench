// openfoam_case_scaffold: the dictionaries a fresh case needs, branched by
// distribution (org foamRun vs com simpleFoam) and built from the case patches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { classifyPatch, distributionKind } from '../lib/scaffold.js'

function registry(config = {}) {
  const tools = {}
  apply({ systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } }, { caseRoots: [], ...config })
  return tools
}

function boundaryOf(patches) {
  const lines = patches.map(([name, type], i) => `    ${name} { type ${type}; nFaces ${i + 1}; startFace ${i}; }`)
  return `${patches.length}\n(\n${lines.join('\n')}\n)\n`
}

function makeCase(root, name, patches, { mesh = true } = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (mesh) {
    mkdirSync(join(dir, 'constant/polyMesh'), { recursive: true })
    writeFileSync(join(dir, 'constant/polyMesh/boundary'), boundaryOf(patches))
  }
  return dir
}

test('distribution and patch classification', () => {
  assert.equal(distributionKind('org'), 'org')
  assert.equal(distributionKind('14'), 'org')
  assert.equal(distributionKind('com'), 'com')
  assert.equal(distributionKind('v2606'), 'com')
  assert.equal(classifyPatch('inlet', 'patch'), 'inlet')
  assert.equal(classifyPatch('outlet', 'patch'), 'outlet')
  assert.equal(classifyPatch('walls', 'wall'), 'wall')
  assert.equal(classifyPatch('frontAndBack', 'empty'), 'empty')
  assert.equal(classifyPatch('symmetry1', 'symmetryPlane'), 'symmetry')
})

test('org scaffold writes foamRun + incompressibleFluid and org constant files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-org-'))
  try {
    makeCase(root, 'caseA', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall']])
    const tools = registry({ caseRoots: [root], defaultDistribution: 'org' })
    const r = await tools.openfoam_case_scaffold.execute({ casePath: 'caseA', U: [2, 0, 0] })
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300))
    assert.equal(r.distribution, 'org')
    assert.equal(r.application, 'foamRun')
    assert.equal(r.patchRoles, undefined)
    assert.deepEqual(r.patches.map((p) => p.role), ['inlet', 'outlet', 'wall'])

    const cd = readFileSync(join(root, 'caseA/system/controlDict'), 'utf8')
    assert.match(cd, /application\s+foamRun;/)
    assert.match(cd, /solver\s+incompressibleFluid;/)
    assert.ok(existsSync(join(root, 'caseA/constant/physicalProperties')))
    assert.ok(existsSync(join(root, 'caseA/constant/momentumTransport')))
    assert.ok(!existsSync(join(root, 'caseA/constant/transportProperties')))

    const U = readFileSync(join(root, 'caseA/0/U'), 'utf8')
    assert.match(U, /inlet\s+\{\s*type\s+fixedValue;\s*value\s+uniform \(2 0 0\);/)
    assert.match(U, /walls\s+\{\s*type\s+noSlip;/)
    const p = readFileSync(join(root, 'caseA/0/p'), 'utf8')
    assert.match(p, /outlet\s+\{\s*type\s+fixedValue;\s*value\s+uniform 0;/)
    assert.ok(existsSync(join(root, 'caseA/caseA.foam')), 'the case-named .foam file must exist')
    assert.equal(r.findingCounts.error || 0, 0, JSON.stringify(r.findings))
    assert.equal(r.manifest, 'case-manifest.json')
    const manifest = JSON.parse(readFileSync(join(root, 'caseA/case-manifest.json'), 'utf8'))
    assert.equal(manifest.application, 'foamRun')
    assert.equal(manifest.compressible, false)
    assert.equal(manifest.turbulence, 'laminar')
    assert.deepEqual(manifest.patches.map((p) => p.role), ['inlet', 'outlet', 'wall'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('com scaffold writes simpleFoam and com constant files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-com-'))
  try {
    makeCase(root, 'caseB', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall']])
    const tools = registry({ caseRoots: [root], defaultDistribution: 'com' })
    const r = await tools.openfoam_case_scaffold.execute({ casePath: 'caseB' })
    assert.equal(r.ok, true)
    assert.equal(r.distribution, 'com')
    assert.equal(r.application, 'simpleFoam')
    const cd = readFileSync(join(root, 'caseB/system/controlDict'), 'utf8')
    assert.match(cd, /application\s+simpleFoam;/)
    assert.doesNotMatch(cd, /solver\s+incompressibleFluid/)
    assert.ok(existsSync(join(root, 'caseB/constant/transportProperties')))
    assert.ok(existsSync(join(root, 'caseB/constant/turbulenceProperties')))
    assert.ok(!existsSync(join(root, 'caseB/constant/physicalProperties')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('2D empty patches, closed domains and PIMPLE are handled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-2d-'))
  try {
    makeCase(root, 'case2D', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall'], ['frontAndBack', 'empty']])
    makeCase(root, 'closed', [['inlet', 'patch'], ['walls', 'wall']])
    const tools = registry({ caseRoots: [root], defaultDistribution: 'org' })

    const r2d = await tools.openfoam_case_scaffold.execute({ casePath: 'case2D' })
    assert.equal(r2d.patches.find((p) => p.name === 'frontAndBack').role, 'empty')
    assert.ok(r2d.notes.some((n) => /2D/.test(n)))
    assert.match(readFileSync(join(root, 'case2D/0/U'), 'utf8'), /frontAndBack\s+\{\s*type\s+empty;/)

    const closed = await tools.openfoam_case_scaffold.execute({ casePath: 'closed' })
    assert.ok(closed.warnings.some((w) => /no outlet/.test(w)))
    assert.match(readFileSync(join(root, 'closed/system/fvSolution'), 'utf8'), /pRefCell\s+0;/)

    const transient = await tools.openfoam_case_scaffold.execute({ casePath: 'case2D', algorithm: 'PIMPLE', force: true })
    assert.equal(transient.algorithm, 'PIMPLE')
    assert.match(readFileSync(join(root, 'case2D/system/fvSchemes'), 'utf8'), /default\s+Euler;/)
    assert.match(readFileSync(join(root, 'case2D/system/fvSolution'), 'utf8'), /nOuterCorrectors 2;/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing dictionaries are skipped unless force is set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-force-'))
  try {
    makeCase(root, 'caseC', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall']])
    const tools = registry({ caseRoots: [root], defaultDistribution: 'org' })
    const first = await tools.openfoam_case_scaffold.execute({ casePath: 'caseC' })
    assert.ok(first.created.includes('system/controlDict'))
    const second = await tools.openfoam_case_scaffold.execute({ casePath: 'caseC' })
    assert.deepEqual(second.created, [])
    assert.ok(second.skipped.includes('system/controlDict'))
    const third = await tools.openfoam_case_scaffold.execute({ casePath: 'caseC', U: [5, 0, 0], force: true })
    assert.ok(third.created.includes('0/U'))
    assert.match(readFileSync(join(root, 'caseC/0/U'), 'utf8'), /\(5 0 0\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('turbulent requests are refused with a tutorial hint', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-turb-'))
  try {
    makeCase(root, 'caseT', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall']])
    const tools = registry({ caseRoots: [root] })
    const r = await tools.openfoam_case_scaffold.execute({ casePath: 'caseT', turbulence: 'kOmegaSST' })
    assert.equal(r.ok, false)
    assert.match(r.error, /laminar incompressible/)
    assert.match(r.hint, /clone_tutorial/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a case without a directory is created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-new-'))
  try {
    const tools = registry({ caseRoots: [root], defaultDistribution: 'org' })
    const r = await tools.openfoam_case_scaffold.execute({ casePath: 'brandNew', patches: ['inlet', 'outlet', 'walls'] })
    assert.equal(r.ok, true)
    assert.ok(existsSync(join(root, 'brandNew/system/controlDict')))
    assert.deepEqual(r.patches.map((p) => p.role), ['inlet', 'outlet', 'wall'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scaffold refuses a compressible family instead of writing an incompressible case', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-fam-'))
  try {
    makeCase(root, 'caseF', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall']])
    const tools = registry({ caseRoots: [root], defaultDistribution: 'org' })
    const r = await tools.openfoam_case_scaffold.execute({ casePath: 'caseF', family: 'compressible' })
    assert.equal(r.ok, false)
    assert.match(r.error, /incompressible laminar cases only/)
    assert.match(r.hint, /clone_tutorial/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('patch roles use the type when given and know sphere/airfoil names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-scaf-patch-'))
  try {
    makeCase(root, 'caseP', [['inlet', 'patch'], ['outlet', 'patch'], ['walls', 'wall']], { mesh: false })
    const tools = registry({ caseRoots: [root], defaultDistribution: 'org' })
    const r = await tools.openfoam_case_scaffold.execute({
      casePath: 'caseP',
      patches: [{ name: 'inlet', type: 'patch' }, { name: 'outlet', type: 'patch' }, { name: 'sphere', type: 'wall' }],
    })
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200))
    assert.equal(r.patches.find((p) => p.name === 'sphere').role, 'wall')
    assert.match(readFileSync(join(root, 'caseP/0/U'), 'utf8'), /sphere\s+\{\s*type\s+noSlip;/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scaffold conventions follow capabilities, not just the distribution label', async () => {
  const { scaffoldFiles } = await import('../lib/scaffold.js')
  const { versionCaps } = await import('../lib/versions.js')
  const patches = [{ name: 'inlet', type: 'patch' }, { name: 'outlet', type: 'patch' }, { name: 'walls', type: 'wall' }]
  const org = scaffoldFiles({ caps: versionCaps('org', '14'), patches })
  assert.equal(org.application, 'foamRun')
  assert.ok(org.files['constant/physicalProperties'] && org.files['constant/momentumTransport'])
  assert.equal(org.modular, true)
  const com = scaffoldFiles({ caps: versionCaps('com', 'v2606'), patches })
  assert.equal(com.application, 'simpleFoam')
  assert.ok(com.files['constant/transportProperties'] && com.files['constant/turbulenceProperties'])
  const old = scaffoldFiles({ caps: versionCaps('org', '9'), patches })
  assert.equal(old.application, 'simpleFoam', 'org 9 has no foamRun')
  assert.ok(old.files['constant/transportProperties'])
})
