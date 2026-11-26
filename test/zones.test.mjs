import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zonePlan, zoneTool } from '../lib/zones.js'
import { versionCaps } from '../lib/versions.js'

const sphere = { centre: [0, 0, 0], radius: 0.025 }

test('the zone mechanism follows the installation capabilities', () => {
  assert.equal(zoneTool(versionCaps('org', '14')), 'createZones')
  assert.equal(zoneTool(versionCaps('com', 'v2606')), 'topoSet')
  const comCaps = { ...versionCaps('com', 'v2606'), zoneTool: 'createZones' }
  assert.equal(zoneTool(comCaps), 'createZones', 'an explicit capability wins')
})

test('org writes createZonesDict and runs createZones', () => {
  const p = zonePlan({ caps: versionCaps('org', '14'), name: 'solid', shape: 'sphere', params: sphere })
  assert.equal(p.tool, 'createZones')
  assert.equal(p.dictRel, 'system/createZonesDict')
  assert.match(p.dictText, /type\s+sphere;/)
  assert.match(p.dictText, /radius 0\.025;/)
  assert.deepEqual(p.commands, [['createZones']])
  assert.equal(p.prereq, undefined)
})

test('com writes a topoSetDict, needs scheme placeholders, and promotes the set', () => {
  const p = zonePlan({ caps: versionCaps('com', 'v2606'), name: 'solid', shape: 'sphere', params: sphere })
  assert.equal(p.tool, 'topoSet')
  assert.equal(p.dictRel, 'system/topoSetDict')
  assert.match(p.dictText, /source\s+sphereToCell;/)
  assert.match(p.dictText, /type\s+cellSet;/)
  assert.deepEqual(p.commands, [['topoSet'], ['setsToZones', '-noFlipMap']])
  assert.ok(p.prereq['system/fvSchemes'] && p.prereq['system/fvSolution'])
})

test('box and cylinder sources are supported, unknown shapes are refused', () => {
  const box = zonePlan({ caps: versionCaps('org', '14'), name: 'z', shape: 'box', params: { min: [-1, -1, -1], max: [1, 1, 1] } })
  assert.match(box.dictText, /min \(-1 -1 -1\);/)
  const cyl = zonePlan({ caps: versionCaps('com', 'v2606'), name: 'z', shape: 'cylinder', params: { point1: [0, 0, 0], point2: [0, 0, 1], radius: 0.01 } })
  assert.match(cyl.dictText, /source\s+cylinderToCell;/)
  assert.ok(zonePlan({ caps: versionCaps('org', '14'), name: 'z', shape: 'torus', params: {} }).error)
})
