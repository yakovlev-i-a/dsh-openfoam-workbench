import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scaffoldCompressible } from '../lib/scaffold-compressible.js'
import { versionCaps } from '../lib/versions.js'

const patches = [
  { name: 'inlet', type: 'patch' },
  { name: 'outlet', type: 'patch' },
  { name: 'walls', type: 'wall' },
  { name: 'sphere', type: 'wall' },
]

test('org compressible scaffold: foamRun + fluid module, internal energy', () => {
  const r = scaffoldCompressible({ caps: versionCaps('org', '14'), patches })
  const control = r.files['system/controlDict']
  assert.match(control, /application\s+foamRun;/)
  assert.match(control, /solver\s+fluid;/)
  assert.match(r.files['constant/physicalProperties'], /hePsiThermo/)
  assert.match(r.files['constant/physicalProperties'], /sensibleInternalEnergy/)
  assert.ok(!r.files['0/p_rgh'], 'one pressure field for both families')
  assert.match(r.files['0/p'], /waveTransmissive/)
  assert.match(r.files['system/fvSchemes'], /div\(phi,\(p\|rho\)\)/)
  assert.match(r.files['system/fvSchemes'], /div\(phi,e\)/)
})

test('com compressible scaffold: rhoPimpleFoam, rho-thermo with enthalpy', () => {
  const r = scaffoldCompressible({ caps: versionCaps('com', 'v2606'), patches })
  assert.match(r.files['system/controlDict'], /application\s+rhoPimpleFoam;/)
  assert.ok(!r.files['0/p_rgh'], 'rhoPimpleFoam solves p only')
  assert.match(r.files['constant/thermophysicalProperties'], /heRhoThermo/)
  assert.match(r.files['constant/thermophysicalProperties'], /sensibleEnthalpy/)
  assert.match(r.files['constant/thermophysicalProperties'], /Hf 0;/)
  assert.match(r.files['system/fvSchemes'], /div\(phi,h\)/)
  assert.ok(r.files['constant/turbulenceProperties'])
})

test('the gas starts at rest and the inlet drives the flow', () => {
  const r = scaffoldCompressible({ caps: versionCaps('org', '14'), patches, Uinlet: 40 })
  assert.match(r.files['0/U'], /internalField\s+uniform \(0 0 0\);/)
  assert.match(r.files['0/U'], /inlet[\s\S]*fixedValue;[\s\S]*uniform \(40 0 0\)/)
  assert.match(r.files['0/p'], /outlet[\s\S]*waveTransmissive/)
})
