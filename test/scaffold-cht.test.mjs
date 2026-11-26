import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldCht } from '../lib/scaffold-cht.js'
import { versionCaps } from '../lib/versions.js'

const regions = [
  { name: 'fluid', kind: 'fluid', patches: [
    { name: 'inlet', type: 'patch' }, { name: 'outlet', type: 'patch' },
    { name: 'walls', type: 'wall' }, { name: 'fluid_to_solid', type: 'mappedWall' },
  ] },
  { name: 'solid', kind: 'solid', patches: [{ name: 'solid_to_fluid', type: 'mappedWall' }] },
]

test('CHT scaffold uses org glue: regionSolvers + foamMultiRun conventions', () => {
  const r = scaffoldCht({ caps: versionCaps('org', '14'), regions })
  assert.equal(r.ok, true)
  assert.match(r.files['system/regionSolvers'], /fluid\s+fluid;/)
  assert.match(r.files['system/regionSolvers'], /solid\s+solid;/)
  assert.match(r.files['system/controlDict'], /#includeIfPresent "regionSolvers"/)
  assert.ok(!r.files['constant/regionProperties'])
  assert.ok(r.files['0/fluid/U'] && r.files['0/fluid/p_rgh'] && r.files['0/fluid/T'])
  assert.ok(r.files['0/solid/T'])
  assert.ok(r.files['system/fluid/fvSolution'] && r.files['system/solid/fvSolution'])
  assert.ok(r.files['system/fvSolution'], 'the root fvSolution is mandatory for foamMultiRun')
  assert.match(r.files['constant/solid/physicalProperties'], /Cv 0.5;/)
})

test('CHT scaffold uses com glue: regionProperties + chtMultiRegionFoam', () => {
  const r = scaffoldCht({ caps: versionCaps('com', 'v2606'), regions })
  assert.equal(r.ok, true)
  assert.match(r.files['constant/regionProperties'], /fluid\s+\(fluid\)/)
  assert.match(r.files['constant/regionProperties'], /solid\s+\(solid\)/)
  assert.match(r.files['system/controlDict'], /application\s+chtMultiRegionFoam;/)
  assert.ok(!r.files['system/regionSolvers'])
})

test('the interface patch gets coupledTemperature and the outer wall does not', () => {
  const r = scaffoldCht({ caps: versionCaps('org', '14'), regions })
  const t = r.files['0/fluid/T']
  const coupled = /fluid_to_solid\s*\{[^}]*coupledTemperature/.test(t)
  const wallCoupled = /walls\s*\{[^}]*coupledTemperature/.test(t)
  assert.equal(coupled, true)
  assert.equal(wallCoupled, false)
  assert.match(r.files['0/solid/T'], /solid_to_fluid\s*\{\s*type\s+coupledTemperature;/)
  const u = r.files['0/fluid/U']
  assert.match(u, /outlet\s*\{\s*type\s+pressureInletOutletVelocity;/)
  assert.match(u, /inlet\s*\{\s*type\s+flowRateInletVelocity;/)
})

test('a CHT scaffold without a solid region is refused', () => {
  const r = scaffoldCht({ caps: versionCaps('org', '14'), regions: [regions[0]] })
  assert.equal(r.ok, false)
  assert.match(r.error, /fluid region and one solid region/)
})
