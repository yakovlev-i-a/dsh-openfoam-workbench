// Reading field values straight out of the case, without a post-processing
// utility.
//
// `foamPostProcess -func cellMin(T)` needs three things a real case often cannot
// give: a mesh it can build without the case's physics (a reacting multi-region
// case fails with `reactionModel … available 0()`), a writable case (the utility
// writes `postProcessing/<region>/cellMin(T)/<time>` and dies on a read-only
// filesystem) and a serial time directory (a decomposed case keeps its fields
// under `processor<N>/`). The values themselves are plain text, so reading them is
// both cheaper and more robust.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g
// A field file bigger than this is not read whole: a 20M-cell case would cost
// seconds and hundreds of megabytes, and the utility handles it better.
const MAX_FIELD_BYTES = 256 * 1024 * 1024
const COMPONENTS = { scalar: 1, vector: 3, sphericalTensor: 1, symmTensor: 6, tensor: 9 }
const COMPONENTS_BY_KIND = { Scalar: 1, Vector: 3, SphericalTensor: 1, SymmTensor: 6, Tensor: 9 }

function readText(path) {
  try {
    if (statSync(path).size > MAX_FIELD_BYTES) return { error: 'field file is too large to read directly' }
    const buf = readFileSync(path)
    if (buf.includes(0)) return { error: 'field file is binary', binary: true }
    return { text: buf.toString('utf8') }
  } catch (err) {
    return { error: `cannot read ${path}: ${err.code || err.message}` }
  }
}

/** Field class (`volScalarField`, …) and component count, from the file header. */
export function fieldClass(text) {
  const cls = (text.match(/class\s+(\w+)\s*;/) || [])[1] || null
  if (cls && COMPONENTS[cls] === undefined) {
    const m = /^(vol|surface|point)(Scalar|Vector|SymmTensor|Tensor|SphericalTensor)Field$/.exec(cls)
    if (m) return { cls, component: COMPONENTS_BY_KIND[m[2]] || 1 }
    return { cls, component: 1 }
  }
  return { cls, component: cls ? COMPONENTS[cls] || 1 : 1 }
}

/**
 * The `internalField` of one field file.
 *
 * Handles the four spellings OpenFOAM writes: `uniform <n>`, `uniform (<x y z>)`,
 * `nonuniform List<scalar> N ( … )` and `nonuniform List<vector> N ( … )`, with
 * the list body either inline or on the following lines. Returns
 * `{kind, component, count, values}` with `values` flat (length `count × component`).
 */
export function parseInternalField(text, { component: declared } = {}) {
  const { component } = fieldClass(text)
  const n = declared || component || 1
  const at = text.indexOf('internalField')
  if (at < 0) return { error: 'no internalField entry' }
  const rest = text.slice(at)
  const end = rest.indexOf(';')
  if (end < 0) return { error: 'unterminated internalField entry' }
  const body = rest.slice('internalField'.length, end).trim()
  const uni = /^uniform\s+([\s\S]+)$/.exec(body)
  if (uni) {
    const nums = (uni[1].match(NUM) || []).map(Number)
    if (!nums.length || nums.some((v) => !Number.isFinite(v))) return { error: 'unreadable uniform value' }
    if (nums.length === 1) return { kind: 'uniform', component: 1, count: 1, values: nums }
    return { kind: 'uniform', component: nums.length, count: 1, values: nums }
  }
  const list = /^nonuniform\s+List<(\w+)>\s*(\d+)\s*\(([\s\S]*)\)$/.exec(body)
  if (!list) return { error: 'unreadable internalField (expected `uniform` or `nonuniform List<…>`)' }
  const count = Number(list[2])
  const nums = (list[3].match(NUM) || []).map(Number)
  if (!Number.isFinite(count) || count <= 0) return { error: 'bad list size in internalField' }
  if (nums.length !== count * n) {
    return { error: `internalField has ${nums.length} numbers for ${count} cells of ${n} component(s)` }
  }
  if (nums.some((v) => !Number.isFinite(v))) return { error: 'unreadable number in internalField' }
  return { kind: 'nonuniform', component: n, count, values: nums }
}

/** Stats of one flat value array, split into components. */
export function summarise(flat, component) {
  if (!flat || !flat.length) return null
  const n = component || 1
  const out = { cells: n > 1 ? flat.length / n : flat.length, min: Infinity, max: -Infinity, magnitudes: null }
  if (n === 1) {
    for (const v of flat) {
      if (v < out.min) out.min = v
      if (v > out.max) out.max = v
    }
    return out
  }
  const comps = Array.from({ length: n }, () => ({ min: Infinity, max: -Infinity }))
  let magMin = Infinity
  let magMax = -Infinity
  for (let i = 0; i < flat.length; i += n) {
    let sum = 0
    for (let k = 0; k < n; k += 1) {
      const v = flat[i + k]
      if (v < comps[k].min) comps[k].min = v
      if (v > comps[k].max) comps[k].max = v
      sum += v * v
    }
    const mag = Math.sqrt(sum)
    if (mag < magMin) magMin = mag
    if (mag > magMax) magMax = mag
  }
  out.components = comps
  out.magnitudes = { min: magMin, max: magMax }
  return out
}

/** Combine two `summarise` results (one per processor) without holding both. */
export function mergeStats(a, b) {
  if (!a) return b
  if (!b) return a
  const out = { cells: (a.cells || 0) + (b.cells || 0), min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) }
  if (a.components || b.components) {
    const n = (a.components || b.components).length
    out.components = Array.from({ length: n }, (_, k) => ({
      min: Math.min((a.components || [])[k] ? a.components[k].min : Infinity, (b.components || [])[k] ? b.components[k].min : Infinity),
      max: Math.max((a.components || [])[k] ? a.components[k].max : -Infinity, (b.components || [])[k] ? b.components[k].max : -Infinity),
    }))
  }
  if (a.magnitudes || b.magnitudes) {
    out.magnitudes = {
      min: Math.min((a.magnitudes || {}).min ?? Infinity, (b.magnitudes || {}).min ?? Infinity),
      max: Math.max((a.magnitudes || {}).max ?? -Infinity, (b.magnitudes || {}).max ?? -Infinity),
    }
  }
  return out
}

/** Numeric time directories that carry `field` at the case root or under `processorN/`. */
export function fieldTimes(caseDir, { field, region = '', processors = [] } = {}) {
  const roots = processors.length ? processors.map((p) => join(caseDir, `processor${p}`)) : [caseDir]
  const found = new Map()
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || !Number.isFinite(Number(e.name)) || e.name.trim() === '') continue
      const base = join(root, e.name)
      const path = region ? join(base, region, field) : join(base, field)
      if (!existsSync(path)) continue
      found.set(e.name, (found.get(e.name) || 0) + 1)
    }
  }
  return [...found.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([time, dirs]) => ({ time, dirs }))
}

/** Cell count of one mesh, from the `owner` header note (`nCells:<n>`). */
export function cellCount(caseDir, { region = '', processor = null } = {}) {
  const root = processor == null ? caseDir : join(caseDir, `processor${processor}`)
  const path = join(root, 'constant', region ? join(region, 'polyMesh', 'owner') : join('polyMesh', 'owner'))
  try {
    // The note sits in the header, well inside the first kilobyte.
    const buf = readFileSync(path, { encoding: 'utf8', flag: 'r' }).slice(0, 4096)
    const m = /nCells:\s*(\d+)/.exec(buf)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

export function latestFieldTime(caseDir, opts = {}) {
  const times = fieldTimes(caseDir, opts)
  return times.length ? times[times.length - 1].time : null
}

/**
 * Min/max of `field` at `time` (default: the latest time that carries it),
 * read from the field files of a serial case or of every `processor<N>/`.
 *
 * Returns `{ok:true, time, source, stats, component, kind}` or
 * `{ok:false, error, binary?, missing?}` — `binary: true` tells the caller to
 * fall back to the post-processing utility.
 */
export function readFieldStats(caseDir, { field, time = null, region = '', processors = [] } = {}) {
  const procs = processors.length ? processors : []
  const at = time || latestFieldTime(caseDir, { field, region, processors: procs })
  if (!at) {
    return {
      ok: false,
      missing: true,
      error: `no written time carries ${field}${region ? ` in region ${region}` : ''}`,
    }
  }
  const roots = procs.length ? procs.map((p) => join(caseDir, `processor${p}`)) : [caseDir]
  let stats = null
  let component = null
  let kind = null
  let used = 0
  let uniformOnly = true
  for (const root of roots) {
    const path = region ? join(root, at, region, field) : join(root, at, field)
    if (!existsSync(path)) continue
    const read = readText(path)
    if (read.error) return { ok: false, error: read.error, binary: Boolean(read.binary), time: at }
    const parsed = parseInternalField(read.text)
    if (parsed.error) return { ok: false, error: parsed.error, time: at }
    component = parsed.component
    kind = parsed.kind
    if (parsed.kind === 'uniform') {
      // A uniform field stands for every cell of that mesh, so the cell count
      // has to come from the mesh, not from the six bytes of the value.
      const proc = procs.length ? Number(root.slice(root.lastIndexOf('processor') + 'processor'.length)) : null
      const cells = cellCount(caseDir, { region, processor: proc })
      const one = summarise(parsed.values, parsed.component)
      if (one) one.cells = cells
      stats = mergeStats(stats, one)
    } else {
      uniformOnly = false
      stats = mergeStats(stats, summarise(parsed.values, parsed.component))
    }
    used += 1
  }
  if (!stats) {
    return {
      ok: false,
      missing: true,
      error: `no readable ${field} file at time ${at}`,
    }
  }
  if (!(stats.cells > 0)) stats.cells = null
  const complete = procs.length > 0 && used === procs.length
  return {
    ok: true,
    time: at,
    source: procs.length ? `${used} processor*/${at}${region ? `/${region}` : ''}/${field}` : `${at}${region ? `/${region}` : ''}/${field}`,
    component,
    kind: uniformOnly ? 'uniform' : 'nonuniform',
    stats,
    processors: procs.length ? procs : [],
    ...(procs.length && !complete ? { missingProcessors: procs.filter((p) => !existsSync(join(caseDir, `processor${p}`, at, region, field))) } : {}),
  }
}
