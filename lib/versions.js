// OpenFOAM flavour/version capabilities.
//
// The plugin supports two families with different conventions (org modular vs
// com legacy). Instead of branching on strings deep inside the tools, one
// capability object describes what a given installation can do; tools ask it and
// unknown versions get the conservative defaults of their family.
const ORG_DEFAULT = {
  family: 'org',
  modular: true,
  // snappyHexMesh quality keys required by org >= 11 (harmless on com)
  snappyQualityKeys: true,
  // field statistics function objects: org 11 removed fieldMinMax in favour of
  // cellMin/cellMax/cellMaxMag (com still has fieldMinMax)
  fieldStats: 'cellMin',
  // utilities
  postProcess: 'foamPostProcess',
  features: 'surfaceFeatures',
  // dictionary layout
  thermoFile: 'physicalProperties',
  turbulenceFile: 'momentumTransport',
  regionModel: 'regionSolvers',
  zeroDir: '0',
}

const COM_DEFAULT = {
  family: 'com',
  modular: false,
  snappyQualityKeys: true,
  fieldStats: 'fieldMinMax',
  postProcess: 'postProcess',
  features: 'surfaceFeatureExtract',
  thermoFile: 'thermophysicalProperties',
  turbulenceFile: 'turbulenceProperties',
  regionModel: 'regionProperties',
  zeroDir: '0.orig',
}

/** Parse "14", "v2606", "v2512" into a comparable number (0 when unknown). */
export function versionNumber(distribution, version) {
  const text = String(version || distribution || '').trim()
  const m = /^v?(\d{2})\.?(\d{2})$/.exec(text)
  if (m) return Number(m[1]) * 100 + Number(m[2]) // v2606 -> 2606
  const n = /^v?(\d+)$/.exec(text)
  return n ? Number(n[1]) : 0
}

/**
 * Capabilities for one installation.
 * @param {string} distribution 'org' | 'com' (or a discovered key like com2)
 * @param {string} version e.g. '14', 'v2606'
 */
export function versionCaps(distribution, version) {
  const family = /^(v\d|com)/i.test(String(distribution || '').trim()) ? 'com' : 'org'
  const base = family === 'com' ? COM_DEFAULT : ORG_DEFAULT
  const n = versionNumber(distribution, version)
  const caps = { ...base, version: String(version || ''), number: n }
  if (family === 'org' && n > 0 && n < 10) {
    // org <= 9: legacy applications, geometry/patch conventions of the old tree
    caps.modular = false
    caps.regionModel = 'regionSolvers'
  }
  if (family === 'com') {
    // com >= 2506 ships foamRun modules as well; keep legacy as the default form
    caps.modular = false
  }
  if (family === 'org' && (n === 0 || n >= 11)) caps.fieldStats = 'cellMin'
  if (family === 'com') caps.fieldStats = 'fieldMinMax'
  return caps
}
