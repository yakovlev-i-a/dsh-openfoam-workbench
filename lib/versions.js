// OpenFOAM flavour/version capabilities.
//
// The workbench targets two families (org modular, com legacy) across many
// releases. Instead of branching on strings inside every tool, one capability
// object per installation describes what it can do and which dictionary
// conventions it reads. Feature detection (which utilities exist) wins over the
// version number; the number only feeds the support policy and the message.
import { existsSync } from 'node:fs'
import { probeBashrc } from './runtime.js'

const ORG = {
  family: 'org',
  modular: true,
  support: 'partial',
  snappyQualityKeys: true,
  blockMeshScale: 'scale',
  featuresUtility: 'surfaceFeatures',
  featuresDict: 'surfaceFeaturesDict',
  featuresDictStyle: 'surfaceFeatures',
  postProcess: 'foamPostProcess',
  fieldStats: { min: 'cellMin', max: 'cellMax', mag: 'cellMaxMag' },
  thermoFile: 'physicalProperties',
  transportFile: 'physicalProperties',
  turbulenceFile: 'momentumTransport',
  regionModel: 'regionSolvers',
  zeroDir: '0',
  namedDimensions: true,
}

const COM = {
  family: 'com',
  modular: false,
  support: 'partial',
  snappyQualityKeys: true,
  blockMeshScale: 'scale',
  featuresUtility: 'surfaceFeatureExtract',
  featuresDict: 'surfaceFeatureExtractDict',
  featuresDictStyle: 'extract',
  postProcess: 'postProcess',
  fieldStats: { min: 'cellMin', max: 'cellMax', mag: 'cellMaxMag' },
  thermoFile: 'thermophysicalProperties',
  transportFile: 'transportProperties',
  turbulenceFile: 'turbulenceProperties',
  regionModel: 'regionProperties',
  zeroDir: '0.orig',
  namedDimensions: true,
}

/** Parse "14", "v2606" into a comparable number (0 when unknown). */
export function versionNumber(version) {
  const text = String(version || '').trim()
  // com: v2606, v2512, and custom suffixes such as v2606wang
  const com = /^v(\d{4})/i.exec(text)
  if (com) return Number(com[1])
  const org = /^v?(\d{1,2})$/.exec(text)
  return org ? Number(org[1]) : 0
}

/** How well this release is covered: full = tested end to end, unknown = best effort. */
export function supportLevel(family, number) {
  if (!number) return 'unknown'
  if (family === 'org') return number >= 14 ? 'full' : number >= 10 ? 'partial' : 'unknown'
  return number >= 2606 ? 'full' : number >= 2312 ? 'partial' : 'unknown'
}

/** Capabilities for a family + version, without probing an installation. */
export function versionCaps(distribution, version) {
  const text = String(distribution || '')
  const family = /^(v\d|com)/i.test(text) ? 'com' : 'org'
  const n = versionNumber(version) || versionNumber(text)
  const caps = { ...(family === 'com' ? COM : ORG), version: String(version || ''), number: n }
  caps.support = supportLevel(family, n)
  if (family === 'org' && n && n < 10) {
    caps.modular = false
    caps.blockMeshScale = 'convertToMeters'
    caps.featuresUtility = 'surfaceFeatureExtract'
    caps.featuresDict = 'surfaceFeatureExtractDict'
    caps.featuresDictStyle = 'extract'
    caps.postProcess = 'postProcess'
  }
  return caps
}

const cache = new Map()

/**
 * Capabilities of the installation behind `bashrc`, detected once per process.
 * The probe asks the installation itself: its version and which utilities exist.
 */
export async function probeCaps(bashrc, distribution = '') {
  const key = String(bashrc || '') + '|' + String(distribution || '')
  if (cache.has(key)) return cache.get(key)
  let caps = versionCaps(distribution, '')
  if (bashrc && existsSync(bashrc)) {
    const script = [
      'echo "$WM_PROJECT_VERSION"',
      'echo "$WM_PROJECT"',
      'for u in postProcess foamPostProcess surfaceFeatureExtract surfaceFeatures foamRun foamMultiRun; do command -v "$u" >/dev/null && echo "yes $u" || echo "no $u"; done',
    ].join('; ')
    try {
      const r = await probeBashrc(bashrc, script, { timeoutMs: 20000 })
      const lines = String(r.stdout || '').split('\n').map((s) => s.trim())
      const version = lines[0] || ''
      const project = lines[1] || ''
      caps = versionCaps(/^(v\d|com)/i.test(project) || /^v\d/i.test(version) ? 'com' : 'org', version)
      const has = (u) => lines.includes('yes ' + u)
      if (has('foamPostProcess')) caps.postProcess = 'foamPostProcess'
      else if (has('postProcess')) caps.postProcess = 'postProcess'
      if (has('surfaceFeatures')) caps.featuresUtility = 'surfaceFeatures'
      else if (has('surfaceFeatureExtract')) caps.featuresUtility = 'surfaceFeatureExtract'
      caps.detected = { version, project, modular: has('foamRun') }
      caps.modular = Boolean(caps.detected.modular)
    } catch {
      caps.probeError = 'could not probe the installation; family defaults used'
    }
  }
  cache.set(key, caps)
  return caps
}

/** Drop the probe cache (tests, or after switching installations). */
export function resetCapsCache() {
  cache.clear()
}

/** One-line human summary, used by env_check/version_info/doctor. */
export function capsSummary(caps) {
  if (!caps) return ''
  const v = caps.version ? String(caps.version) : '?'
  return `${caps.family} ${v} (${caps.modular ? 'modular' : 'legacy'}, support: ${caps.support})`
}
