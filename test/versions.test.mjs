import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capsSummary, supportLevel, versionCaps, versionNumber } from '../lib/versions.js'

test('version numbers parse both families, including suffixes', () => {
  assert.equal(versionNumber('14'), 14)
  assert.equal(versionNumber('v2606'), 2606)
  assert.equal(versionNumber('v2512'), 2512)
  assert.equal(versionNumber('v2606wang'), 2606)
  assert.equal(versionNumber(''), 0)
})

test('support policy: tested releases are full, neighbours partial, old ones unknown', () => {
  assert.equal(supportLevel('org', 14), 'full')
  assert.equal(supportLevel('org', 13), 'partial')
  assert.equal(supportLevel('org', 9), 'unknown')
  assert.equal(supportLevel('com', 2606), 'full')
  assert.equal(supportLevel('com', 2512), 'partial')
  assert.equal(supportLevel('com', 2312), 'partial')
  assert.equal(supportLevel('com', 2212), 'unknown')
  assert.equal(supportLevel('org', 0), 'unknown')
})

test('capabilities describe the family conventions', () => {
  const org = versionCaps('org', '14')
  assert.equal(org.family, 'org')
  assert.equal(org.modular, true)
  assert.equal(org.blockMeshScale, 'scale')
  assert.equal(org.featuresDict, 'surfaceFeaturesDict')
  assert.equal(org.featuresUtility, 'surfaceFeatures')
  assert.equal(org.postProcess, 'foamPostProcess')
  assert.equal(org.transportFile, 'physicalProperties')
  assert.equal(org.turbulenceFile, 'momentumTransport')
  assert.equal(org.zeroDir, '0')
  assert.equal(org.support, 'full')

  const com = versionCaps('com', 'v2606')
  assert.equal(com.family, 'com')
  assert.equal(com.modular, false)
  assert.equal(com.featuresDict, 'surfaceFeatureExtractDict')
  assert.equal(com.featuresUtility, 'surfaceFeatureExtract')
  assert.equal(com.postProcess, 'postProcess')
  assert.equal(com.transportFile, 'transportProperties')
  assert.equal(com.turbulenceFile, 'turbulenceProperties')
  assert.equal(com.zeroDir, '0.orig')
  assert.equal(com.support, 'full')

  const old = versionCaps('org', '9')
  assert.equal(old.modular, false, 'org 9 has no foamRun')
  assert.equal(old.blockMeshScale, 'convertToMeters')
  assert.equal(old.featuresDict, 'surfaceFeatureExtractDict')
  assert.equal(old.postProcess, 'postProcess')
  assert.equal(old.support, 'unknown')

  assert.match(capsSummary(org), /org 14 .*modular.*full/)
})
