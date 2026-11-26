// Field-report fixes: patch keys are regexes, find_tutorial reads content, and a
// failed run reports why instead of an ETA and "RERUN".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRegionFieldPatches, patchCoverage } from '../lib/of-engine.js'
import { progressFrom } from '../lib/of-case.js'
import { apply } from '../lib/index.js'

const dict = (body) => 'FoamFile { version 2.0; class volScalarField; }\ninternalField uniform 300;\nboundaryField\n{\n' + body + '}\n'

function chtCase(fieldBody) {
  const dir = mkdtempSync(join(tmpdir(), 'cht-regex-'))
  mkdirSync(join(dir, 'constant/fluid/polyMesh'), { recursive: true })
  mkdirSync(join(dir, '0/fluid'), { recursive: true })
  writeFileSync(
    join(dir, 'constant/fluid/polyMesh/boundary'),
    'FoamFile { version 2.0; }\n2\n(\n    fluid_to_solid\n    {\n        type mappedWall;\n    }\n    outerWall\n    {\n        type wall;\n    }\n)\n',
  )
  writeFileSync(join(dir, '0/fluid/T'), dict(fieldBody))
  return dir
}

test('boundaryField keys are wordRe patterns, not patch names', () => {
  const cover = patchCoverage(['.*'], ['wall', 'inlet'])
  assert.deepEqual(cover.missingPatches, [])
  assert.deepEqual(cover.unmatchedKeys, [])
  const alternation = patchCoverage(['(inlet|outlet)', 'wall.*'], ['inlet', 'outlet', 'wallTop'])
  assert.deepEqual(alternation.missingPatches, [])
  assert.deepEqual(alternation.unmatchedKeys, [])
  // A key that matches nothing is still reported, and a patch nothing covers.
  const gap = patchCoverage(['inlet'], ['inlet', 'outlet'])
  assert.deepEqual(gap.missingPatches, ['outlet'])
  const typo = patchCoverage(['inlett'], ['inlet'])
  assert.deepEqual(typo.unmatchedKeys, ['inlett'])
  // A macro key cannot be judged; the coverage verdict is withheld.
  assert.deepEqual(patchCoverage(['$internalField'], ['inlet']).missingPatches, [])
})

test('a CHT case that uses ".*" produces no patch findings', () => {
  const dir = chtCase('    ".*" { type zeroGradient; }\n')
  assert.deepEqual(checkRegionFieldPatches(dir, 'fluid'), [])
  const literal = chtCase('    fluid_to_solid { type compressible::turbulentTemperatureCoupledBaffleMixed; }\n    outerWall { type zeroGradient; }\n')
  assert.deepEqual(checkRegionFieldPatches(literal, 'fluid'), [])
})

test('a stale literal patch name is still an error', () => {
  const dir = chtCase('    wall { type zeroGradient; }\n')
  const rules = checkRegionFieldPatches(dir, 'fluid').map((f) => f.rule)
  assert.ok(rules.includes('region-field-unknown-patch'))
  assert.ok(rules.includes('region-field-missing-patch'))
})

test('a failed run reports the reason and the first error line, not an ETA', () => {
  const log = [
    'sigFpe : Enabling floating point exception trapping (FOAM_SIGFPE).',
    'Time = 1',
    'smoothSolver:  Solving for Ux, Initial residual = 0.1, Final residual = 1e-05',
    'Floating point exception (core dumped)',
  ].join('\n')
  const p = progressFrom(log, { endTime: 10 })
  assert.equal(p.state, 'failed')
  assert.equal(p.decision, 'FAILED')
  assert.equal(p.eta, null)
  assert.equal(p.etaSeconds, null)
  assert.equal(p.reason, 'sigfpe')
  assert.equal(p.firstErrorLine.line, 4)
})

test('the org startup banner alone is not a failure', () => {
  const log = ['sigFpe : Enabling floating point exception trapping (FOAM_SIGFPE).', 'Time = 1', 'End'].join('\n')
  const p = progressFrom(log, { endTime: 10 })
  assert.equal(p.state, 'finished')
  assert.equal(p.firstErrorLine, undefined, 'no failure line on a finished run')
})

test('find_tutorial matches tokens against controlDict content', async () => {
  const tools = {}
  const root = mkdtempSync(join(tmpdir(), 'foam-'))
  const make = (rel, control) => {
    mkdirSync(join(root, 'tutorials', rel, 'system'), { recursive: true })
    writeFileSync(join(root, 'tutorials', rel, 'system/controlDict'), 'FoamFile { version 2.0; }\n' + control)
  }
  make('multiRegion/CHT/heatedDuct', 'regionSolvers { fluid solid }\n')
  make('multiphase/interFoam/damBreak', 'application interFoam;\n')
  apply(
    { systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } },
    { caseRoots: [root], foamRoots: { org: root }, defaultDistribution: 'org' },
  )
  const hit = await tools.openfoam_find_tutorial.execute({ query: 'cht regionSolvers solid' })
  assert.equal(hit.ok, true)
  assert.deepEqual(hit.tutorials, ['multiRegion/CHT/heatedDuct'])
  assert.equal(hit.matchedAll, true)
  const other = await tools.openfoam_find_tutorial.execute({ query: 'damBreak' })
  assert.deepEqual(other.tutorials, ['multiphase/interFoam/damBreak'])
})
