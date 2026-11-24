// Multi-region case model for the OpenFOAM Workbench.
//
// The plugin's original case model assumed one polyMesh at the case root, which
// is true for single-region cases and false for every CHT / multi-region setup
// (foamMultiRun, chtMultiRegionFoam, system/<region>/...). These helpers answer
// the three questions every tool needs: which regions exist, where a dictionary
// really lives, and what a command is allowed to run.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseRunLog } from './of-engine.js'

function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Region names of a case, in declaration order. Empty for single-region cases. */
export function caseRegions(dir) {
  const regions = []
  const cd = readText(join(dir, 'system', 'controlDict'))
  if (cd) {
    const m = stripComments(cd).match(/regionSolvers\s*\{([\s\S]*?)\}/)
    if (m) {
      // the block may be written on one line, so scan every `region solver;` pair
      for (const mm of m[1].matchAll(/(\w+)\s+(\w+)\s*;/g)) regions.push(mm[1])
    }
  }
  if (!regions.length) {
    // OpenFOAM.com groups MESH regions under solver regions in
    // constant/regionProperties:  fluid (bottomAir topAir) solid (heater leftSolid)
    // The mesh regions (the parenthesised names) are what the tools address.
    for (const names of Object.values(regionGroups(dir))) {
      for (const n of names) if (!regions.includes(n)) regions.push(n)
    }
  }
  if (!regions.length) {
    try {
      for (const e of readdirSync(join(dir, 'constant'), { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        if (existsSync(join(dir, 'constant', e.name, 'polyMesh', 'boundary'))) regions.push(e.name)
      }
    } catch {}
  }
  return regions
}

/** region -> solver mapping from system/controlDict (empty when absent). */
export function regionSolvers(dir) {
  const out = {}
  const cd = readText(join(dir, 'system', 'controlDict'))
  if (!cd) return out
  const m = stripComments(cd).match(/regionSolvers\s*\{([\s\S]*?)\}/)
  if (!m) return out
  for (const mm of m[1].matchAll(/(\w+)\s+(\w+)\s*;/g)) out[mm[1]] = mm[2]
  return out
}

/** Solver regions -> mesh regions from constant/regionProperties (OpenFOAM.com). */
export function regionGroups(dir) {
  const out = {}
  const rp = readText(join(dir, 'constant', 'regionProperties'))
  if (!rp) return out
  const blockText = stripComments(rp).match(/regions\s*\(([\s\S]*?)\)\s*;/)
  if (!blockText) return out
  for (const m of blockText[1].matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    out[m[1]] = m[2].split(/\s+/).filter(Boolean)
  }
  return out
}

/**
 * Restore the initial fields the way OpenFOAM's `restore0Dir` does: copy
 * `0.orig/` to `0/` (serial) or to every `processor<N>/0/` (`-processor`).
 * Com tutorials ship `0.orig/` instead of `0/`, so the plugin implements the
 * helper itself — it is a shell function in OpenFOAM, not an executable.
 */
export function restoreZeroDir(caseDir, { processor = false } = {}) {
  const src = join(caseDir, '0.orig')
  if (!existsSync(src)) return { ok: false, error: '0.orig not found: ' + src }
  const targets = []
  if (processor) {
    let entries = []
    try { entries = readdirSync(caseDir, { withFileTypes: true }) } catch {}
    for (const e of entries) if (e.isDirectory() && /^processor\d+$/.test(e.name)) targets.push(join(caseDir, e.name, '0'))
  } else {
    targets.push(join(caseDir, '0'))
  }
  if (!targets.length) return { ok: false, error: 'no processor* directories for restore0Dir -processor' }
  for (const t of targets) {
    rmSync(t, { recursive: true, force: true })
    cpSync(src, t, { recursive: true })
  }
  return { ok: true, restored: targets.length, processor }
}

export function isMultiRegion(dir) {
  return caseRegions(dir).length > 0
}

/** Dictionaries of one region: 0/<region> fields, system/<region> and constant/<region>. */
export function regionFiles(dir, region) {
  const out = { fields: [], system: [], constant: [] }
  const list = (sub) => {
    try { return readdirSync(join(dir, sub, region)).filter((n) => !n.startsWith('.')).sort() } catch { return [] }
  }
  out.fields = list('0')
  if (!out.fields.length) {
    // com tutorials ship 0.orig/ and create 0/ via restore0Dir at run time
    out.fields = list('0.orig')
    if (out.fields.length) out.fieldsFrom = '0.orig'
  }
  out.system = list('system')
  out.constant = list('constant')
  return out
}

const CASE_ROOTS = new Set(['system', 'constant', 'postProcessing', 'dynamicCode'])

/**
 * Resolve a dictionary path the way a human writes it.
 * Accepts `fluid/fvSchemes`, `system/fluid/fvSchemes`, `constant/fluid/...`,
 * `0/fluid/T`, and bare names (`fvSchemes`, `controlDict`). Never double-prefixes.
 */
export function normaliseDictPath(dir, file, region) {
  const raw = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const tried = []
  const ok = (rel) => {
    tried.push(rel)
    return existsSync(join(dir, rel))
  }
  if (!raw) return { ok: false, tried, error: 'empty file name' }
  const segments = raw.split('/')
  const head = segments[0]
  const caseRelative = CASE_ROOTS.has(head) || /^\d/.test(head) || head === 'processor0'
  if (caseRelative) {
    if (ok(raw)) return { ok: true, rel: raw, tried }
    // com tutorials keep the initial fields in 0.orig/ until restore0Dir
    if (head === '0') {
      const alt = '0.orig/' + segments.slice(1).join('/')
      if (ok(alt)) return { ok: true, rel: alt, tried }
    }
    return { ok: false, tried }
  }
  if (segments.length === 1) {
    if (region && ok(`system/${region}/${raw}`)) return { ok: true, rel: `system/${region}/${raw}`, tried }
    for (const rel of [`system/${raw}`, `constant/${raw}`, `0/${raw}`]) {
      if (ok(rel)) return { ok: true, rel, tried }
    }
    return { ok: false, tried }
  }
  for (const rel of [`system/${raw}`, `constant/${raw}`, `0/${raw}`]) {
    if (ok(rel)) return { ok: true, rel, tried }
  }
  return { ok: false, tried }
}

/** Up to `limit` dictionaries of a case, for a "did you mean" hint. */
export function availableDicts(dir, limit = 40) {
  const out = []
  const push = (rel) => { if (out.length < limit) out.push(rel) }
  const scan = (base, depthLeft) => {
    let entries = []
    try { entries = readdirSync(join(dir, base), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const rel = `${base}/${e.name}`
      if (e.isDirectory()) {
        if (depthLeft > 0 && !e.name.startsWith('.')) scan(rel, depthLeft - 1)
      } else if (!e.name.startsWith('.')) push(rel)
    }
  }
  scan('system', 1)
  scan('constant', 1)
  scan('0', 1)
  return out
}

// Executables the workbench may launch. Kept explicit: the whitelist is the
// only thing standing between an agent and an arbitrary shell command.
export const BASE_APPS = [
  'blockMesh', 'checkMesh', 'snappyHexMesh', 'foamRun', 'foamMultiRun',
  'simpleFoam', 'pimpleFoam', 'icoFoam', 'buoyantFoam', 'reactingFoam',
  'chtMultiRegionFoam', 'chtMultiRegionSimpleFoam', 'chtMultiRegionTwoPhaseEulerFoam', 'rhopimpleFoam', 'decomposePar', 'reconstructPar',
  'reconstructParMesh', 'foamToVTK', 'postProcess', 'setFields', 'topoSet',
  'createPatch', 'renumberMesh', 'potentialFoam', 'restore0Dir',
  'splitMeshRegions', 'changeDictionary', 'foamListRegions',
]

const LAUNCHER_RE = /^(mpirun|mpiexec)$/
const SHELL_META_RE = /[;&|`$(){}<>\n\r]/

/**
 * Decide whether a command may run. `mpirun [-np N] <app>` is allowed when the
 * wrapped app is whitelisted; shell metacharacters are never allowed.
 * Returns { ok, launcher, app, args } or { ok:false, reason, hint, allowed }.
 */
export function commandAllowed(cmd, extraCommands = []) {
  const apps = [...new Set([...BASE_APPS, ...(Array.isArray(extraCommands) ? extraCommands.map(String) : [])])]
  const c = String(cmd || '').trim()
  if (!c) return { ok: false, reason: 'empty command' }
  if (SHELL_META_RE.test(c)) {
    return {
      ok: false,
      reason: 'shell metacharacters are not allowed in a command',
      hint: 'run one executable with plain arguments; use openfoam_run twice instead of piping',
    }
  }
  const words = c.split(/\s+/)
  let i = 0
  let launcher = null
  if (LAUNCHER_RE.test(words[0])) {
    launcher = words[0]
    i = 1
    while (i < words.length && words[i].startsWith('-')) {
      const w = words[i]
      if (/^-{1,2}(np|n)$/.test(w)) {
        const n = Number(words[i + 1])
        if (!Number.isFinite(n) || n < 1) {
          return { ok: false, reason: `${launcher} ${w} needs a positive process count`, hint: `for example: ${launcher} -np 4 foamRun` }
        }
        i += 2
        continue
      }
      if (/^-{1,2}(np|n)=/.test(w)) { i += 1; continue }
      i += 1
    }
    if (i >= words.length) {
      return { ok: false, reason: `${launcher} without an application`, hint: `for example: ${launcher} -np 4 foamRun` }
    }
  }
  const app = words[i]
  if (!apps.includes(app)) {
    return {
      ok: false,
      reason: `'${app}' is not in the command whitelist`,
      hint: `allowed applications: ${apps.join(', ')}. Add more with the plugin config "extraCommands" (currently ${JSON.stringify(Array.isArray(extraCommands) ? extraCommands : [])}).`,
      allowed: apps,
    }
  }
  return { ok: true, launcher, app, args: words.slice(i + 1) }
}

/**
 * Progress of a solver run from its log: last time, steps, seconds per step,
 * ETA and the state (running | stalled | finished | failed).
 */
export function progressFrom(text, { endTime = null, mtimeMs = 0, nowMs = Date.now(), tolerance = 0.001 } = {}) {
  const parsed = parseRunLog(text)
  const times = parsed.times || []
  const n = times.length
  const lastTime = n ? times[n - 1] : null
  const firstTime = n ? times[0] : null
  // Median of adjacent deltas: robust to a trimmed/rotated log where the first
  // visible time is far from the last one.
  const diffs = []
  for (let i = 1; i < n; i += 1) {
    const d = times[i] - times[i - 1]
    if (d > 1e-12) diffs.push(d)
  }
  diffs.sort((a, b) => a - b)
  const stepEstimate = diffs.length ? diffs[Math.floor(diffs.length / 2)] : null
  const execSeconds = parsed.execSeconds != null ? Number(parsed.execSeconds) : null
  const execSeries = parsed.execSeries || []
  // Prefer the ExecutionTime delta between the visible first and last step: it
  // stays correct on a trimmed log, where the cumulative ExecutionTime belongs
  // to the whole run and not to the visible window.
  const execDelta = execSeries.length >= 2 ? execSeries[execSeries.length - 1] - execSeries[0] : null
  const secondsPerStep = execDelta != null && n > 1 ? execDelta / (n - 1) : null
  let etaSeconds = null
  if (endTime != null && lastTime != null && stepEstimate && secondsPerStep != null && endTime > lastTime) {
    etaSeconds = ((endTime - lastTime) / stepEstimate) * secondsPerStep
  }
  const staleMs = mtimeMs ? nowMs - mtimeMs : 0
  let state
  if (parsed.finished) state = 'finished'
  else if (parsed.errors.length || parsed.diverged) state = 'failed'
  else if (mtimeMs && staleMs > 30 * 60 * 1000) state = 'stalled'
  else state = 'running'
  const floor = parsed.residualFloor != null ? Number(parsed.residualFloor) : null
  const pass = parsed.finished && !parsed.diverged && floor != null && floor < tolerance
  let decision
  if (state === 'finished') decision = pass ? 'PROCEED' : parsed.diverged ? 'RERUN' : 'REVISE'
  else if (state === 'running') decision = 'RUNNING'
  else if (state === 'stalled') decision = 'STALLED'
  else decision = 'RERUN'
  return {
    state,
    decision,
    pass: state === 'finished' ? pass : null,
    time: lastTime,
    firstTime,
    steps: n,
    deltaT_nominal: stepEstimate,
    secondsPerStep,
    etaSeconds,
    eta: etaSeconds != null ? humanDuration(etaSeconds) : null,
    elapsed: execSeconds != null ? humanDuration(execSeconds) : null,
    residualFloor: parsed.residualFloor,
    diverged: parsed.diverged,
    finished: parsed.finished,
    errors: parsed.errors.slice(0, 5),
    warnings: parsed.warnings.slice(0, 5),
    staleSeconds: mtimeMs ? Math.round(staleMs / 1000) : null,
  }
}

export function humanDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

/** mtime of a file in ms, 0 when unknown. */
export function mtimeOf(p) {
  try { return statSync(p).mtimeMs } catch { return 0 }
}
