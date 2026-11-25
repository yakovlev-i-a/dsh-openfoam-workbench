// Multi-region case model for the OpenFOAM Workbench.
//
// The plugin's original case model assumed one polyMesh at the case root, which
// is true for single-region cases and false for every CHT / multi-region setup
// (foamMultiRun, chtMultiRegionFoam, system/<region>/...). These helpers answer
// the three questions every tool needs: which regions exist, where a dictionary
// really lives, and what a command is allowed to run.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseRunLog } from './of-engine.js'

function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * Ensure the case carries the PaRaView entry file: `<case-dir-name>.foam`.
 * No compatibility shims: the convention is one file named after the case.
 */
export function ensureFoamFile(caseDir) {
  const name = basename(caseDir)
  const target = join(caseDir, name + '.foam')
  const existed = existsSync(target)
  if (!existed) {
    try { writeFileSync(target, '') } catch (e) { return { ok: false, error: 'cannot write ' + target + ': ' + (e && e.message) } }
  }
  return { ok: true, path: target, name: name + '.foam', created: !existed }
}

/**
 * The `.foam` file a case is opened through. Strict convention: only
 * `<case-dir-name>.foam` counts; `case.foam` and other names are not accepted.
 */
export function findFoamFile(caseDir) {
  const target = join(caseDir, basename(caseDir) + '.foam')
  return existsSync(target) ? target : null
}

/**
 * Axis-aligned bounding box of an existing case: region/root polyMesh/points when
 * the file is small enough, otherwise the blockMeshDict vertices.
 */
export function caseBBox(caseDir, maxBytes = 32 * 1024 * 1024) {
  const candidates = []
  const rootPoints = join(caseDir, 'constant', 'polyMesh', 'points')
  if (existsSync(rootPoints)) candidates.push(rootPoints)
  for (const r of caseRegions(caseDir)) {
    const p = join(caseDir, 'constant', r, 'polyMesh', 'points')
    if (existsSync(p)) candidates.push(p)
  }
  for (const p of candidates) {
    try {
      if (statSync(p).size > maxBytes) continue
      const text = readFileSync(p, 'utf8')
      if (/^\s*format\s+binary/m.test(text.slice(0, 400))) continue
      // coordinates live after the leading count + '(' : skip the FoamFile header
      const body = text.slice(Math.max(0, text.indexOf('(')))
      const nums = body.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)
      if (!nums || nums.length < 6) continue
      const mn = [Infinity, Infinity, Infinity]
      const mx = [-Infinity, -Infinity, -Infinity]
      const take = nums.slice(0, Math.floor(nums.length / 3) * 3)
      for (let i = 0; i + 2 < take.length; i += 3) {
        for (let k = 0; k < 3; k += 1) {
          const v = Number(take[i + k])
          if (!Number.isFinite(v)) continue
          if (v < mn[k]) mn[k] = v
          if (v > mx[k]) mx[k] = v
        }
      }
      if (Number.isFinite(mn[0]) && Number.isFinite(mx[0])) {
        const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
        return { ok: true, min: mn, max: mx, extent: ext, maxExtent: Math.max(...ext) }
      }
    } catch {}
  }
  const bm = readText(join(caseDir, 'system', 'blockMeshDict'))
  if (bm) {
    const verts = [...bm.matchAll(/\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
    if (verts.length >= 2) {
      const mn = [0, 1, 2].map((k) => Math.min(...verts.map((v) => v[k])))
      const mx = [0, 1, 2].map((k) => Math.max(...verts.map((v) => v[k])))
      const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
      return { ok: true, min: mn, max: mx, extent: ext, maxExtent: Math.max(...ext), source: 'blockMeshDict' }
    }
  }
  return { ok: false, error: 'no mesh points or blockMeshDict' }
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
  const srcName = ['0.orig', '0_orig'].find((n) => existsSync(join(caseDir, n)))
  if (!srcName) return { ok: false, error: 'neither 0.orig nor 0_orig found in ' + caseDir }
  const src = join(caseDir, srcName)
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


/** Dictionaries of one region: 0/<region> fields, system/<region> and constant/<region>. */
/**
 * The directory that holds the initial fields. com cases ship `0.orig/`, and
 * some user cases use `0_orig/` (the author of the BFER series does), so all
 * three names are accepted everywhere.
 */
export const ZERO_DIR_NAMES = ['0', '0.orig', '0_orig']

export function zeroDirOf(caseDir) {
  for (const name of ZERO_DIR_NAMES) {
    const dir = join(caseDir, name)
    if (existsSync(dir)) return dir
  }
  return null
}

export function zeroDirName(caseDir) {
  for (const name of ZERO_DIR_NAMES) if (existsSync(join(caseDir, name))) return name
  return null
}

export function regionFiles(dir, region) {
  const out = { fields: [], system: [], constant: [] }
  const list = (sub) => {
    try { return readdirSync(join(dir, sub, region)).filter((n) => !n.startsWith('.')).sort() } catch { return [] }
  }
  out.fields = list('0')
  if (!out.fields.length) {
    // com tutorials ship 0.orig/ and create 0/ via restore0Dir at run time
    for (const alt of ['0.orig', '0_orig']) {
      out.fields = list(alt)
      if (out.fields.length) { out.fieldsFrom = alt; break }
    }
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
