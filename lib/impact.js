// Impact of a dictionary change, judged by the semantics of the entry — not by
// the file it lives in. `0/U`, `0/Yi`, `fvSchemes` and `deltaT` can produce a
// perfectly converged, syntactically valid and physically wrong run, so they
// are never "safe"; output/organisation keys in controlDict are.
//
//   low      : output and run organisation (writeInterval, writeFormat, ...)
//   high     : anything that can change the physics or the numerics
//   critical : can execute code or replace a whole group of files (libs, functions)
const LOW_CONTROL_ENTRIES = new Set([
  'writeInterval', 'writeControl', 'writeFormat', 'writePrecision', 'writeCompression',
  'timeFormat', 'timePrecision',
])

const CRITICAL_CONTROL_ENTRIES = new Set(['libs', 'functions'])

/** Base dictionary name, ignoring region prefixes and the system/ prefix. */
export function dictBaseName(file) {
  const rel = String(file || '').replace(/^system\//, '')
  return rel.split('/').pop()
}

/**
 * @returns {'low'|'high'|'critical'} — the conservative default is 'high'.
 */
export function classifyImpact(file, entry, value) {
  const base = dictBaseName(file)
  const name = String(entry || '').trim()
  if (base === 'controlDict') {
    if (CRITICAL_CONTROL_ENTRIES.has(name)) return 'critical'
    // purgeWrite > 0 deletes older time directories: losing a long run's history
    // is not an organisational change, so the *value* decides the impact.
    if (name === 'purgeWrite') {
      // Only a literal zero is harmless; '-1', 'abc' and an empty value all let
      // OpenFOAM write purging behaviour we cannot reason about, so they are high.
      const raw = String(value ?? '').trim()
      return /^0+(\.0*)?$/.test(raw) ? 'low' : 'high'
    }
    if (LOW_CONTROL_ENTRIES.has(name)) return 'low'
    return 'high'
  }
  // fvSchemes, fvSolution, constant/*, 0/* (boundary and initial conditions),
  // blockMeshDict, and anything unknown: capable of changing the physics.
  return 'high'
}

/** What to do with a change: apply, show a preview, or require approval. */
export function decideAction({ impact, writeMode = 'impact', applyRequested = false, dryRun = false }) {
  if (dryRun) return 'preview'
  if (impact === 'critical') return 'approval'
  if (applyRequested) return 'apply'
  if (writeMode === 'preview') return 'preview'
  if (writeMode === 'apply') return 'apply'
  // writeMode === 'impact' (default)
  return impact === 'low' ? 'apply' : 'preview'
}
