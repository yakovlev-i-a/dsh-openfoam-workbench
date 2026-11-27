// Multi-region case model: com's regionProperties groups, 0.orig fallbacks,
// restore0Dir and the command whitelist.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { caseRegions, regionGroups, regionFiles, normaliseDictPath, restoreZeroDir, commandAllowed } from '../lib/of-case.js'

function makeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, body)
  }
  return root
}

test('constant/regionProperties groups become mesh regions (OpenFOAM.com)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-rp-'))
  try {
    makeTree(dir, {
      'constant/regionProperties': 'FoamFile { version 2.0; }\nregions\n(\n    fluid (bottomAir topAir)\n    solid (heater leftSolid)\n);\n',
      'constant/bottomAir/polyMesh/boundary': '1\n(\n    inlet { type patch; nFaces 1; startFace 0; }\n)\n',
    })
    assert.deepEqual(regionGroups(dir), { fluid: ['bottomAir', 'topAir'], solid: ['heater', 'leftSolid'] })
    assert.deepEqual(caseRegions(dir), ['bottomAir', 'topAir', 'heater', 'leftSolid'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0.orig is read and resolved until restore0Dir runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-0orig-'))
  try {
    makeTree(dir, {
      'constant/regionProperties': 'regions ( fluid () solid (solid) );\n',
      '0.orig/solid/T': 'internalField uniform 300;\n',
      'system/controlDict': 'application chtMultiRegionSimpleFoam;\n',
    })
    assert.deepEqual(regionFiles(dir, 'solid').fields, ['T'])
    assert.equal(regionFiles(dir, 'solid').fieldsFrom, '0.orig')
    const found = normaliseDictPath(dir, '0/solid/T')
    assert.equal(found.ok, true)
    assert.equal(found.rel, '0.orig/solid/T')
    const restored = restoreZeroDir(dir)
    assert.equal(restored.ok, true)
    assert.ok(existsSync(join(dir, '0/solid/T')))
    assert.match(readFileSync(join(dir, '0/solid/T'), 'utf8'), /uniform 300/)
    assert.equal(normaliseDictPath(dir, '0/solid/T').rel, '0/solid/T')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore0Dir -processor fills every processor dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-0proc-'))
  try {
    makeTree(dir, { '0.orig/fluid/T': 'x\n', 'processor0/.keep': '', 'processor1/.keep': '' })
    const r = restoreZeroDir(dir, { processor: true })
    assert.equal(r.ok, true)
    assert.equal(r.restored, 2)
    assert.ok(existsSync(join(dir, 'processor0/0/fluid/T')))
    assert.ok(existsSync(join(dir, 'processor1/0/fluid/T')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the whitelist accepts CHT pre-processing commands', () => {
  for (const cmd of ['restore0Dir', 'restore0Dir -processor', 'splitMeshRegions -cellZones all', 'changeDictionary -region solid', 'chtMultiRegionSimpleFoam', 'mpirun -np 5 foamMultiRun -parallel']) {
    assert.equal(commandAllowed(cmd).ok, true, cmd)
  }
  assert.equal(commandAllowed('rm -rf /').ok, false)
  // mpirun without -parallel starts N independent serial copies of the case
  const noPar = commandAllowed('mpirun -np 5 foamMultiRun')
  assert.equal(noPar.ok, false)
  assert.match(noPar.reason, /-parallel/)
})
