// Writing side of 0/: regenerate the field files for a changed mesh, and build
// setFieldsDict zone values.
//
// The hard rule here is that this module never invents a physical value. A field
// that was written as a per-cell list for a mesh that no longer exists cannot be
// carried over by index, so the plan reports it as `needsValue` and suggests the
// most frequent entry — a suggestion the caller has to accept explicitly.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseBoundaryPatches } from './of-engine.js'
import { fieldClass, parseInternalField } from './fields.js'

export const MAX_FIELD_FILE_BYTES = 32 * 1024 * 1024

const ARITY = { scalar: 1, vector: 3, sphericalTensor: 1, symmTensor: 6, tensor: 9 }

/** Numbers inside a `nonuniform List<…>` body, as a plain array. */
export function listValues(raw) {
  // `nonuniform List<scalar> 8352 ( … )` — the number before the parenthesis is
  // the element count, not a value; the values are inside the parenthesis.
  let body = String(raw).replace(/^\s*nonuniform\s+List<\s*\w+\s*>/, '')
  const open = body.indexOf('(')
  const close = body.lastIndexOf(')')
  if (open >= 0 && close > open) body = body.slice(open + 1, close)
  const out = []
  for (const m of body.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) out.push(Number(m[0]))
  return out
}

/** `{count, mode, min, max}` for a list, or null when it is not a list. */
export function listSummary(raw) {
  // Only a per-cell list has a distribution; `uniform 0` has none.
  if (!/nonuniform/.test(String(raw))) return null
  const values = listValues(raw)
  if (!values.length) return null
  const seen = new Map()
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
    seen.set(v, (seen.get(v) || 0) + 1)
  }
  let mode = values[0]
  let best = 0
  for (const [v, n] of seen) {
    if (n > best) {
      best = n
      mode = v
    }
  }
  return { count: values.length, min, max, mode, modeShare: best / values.length }
}

/**
 * Split a field file into the parts a rewrite has to keep: everything before
 * `internalField`, the internal field statement, and the boundaryField block.
 */
export function splitFieldFile(text) {
  const src = String(text)
  const internal = /(^|\n)([ \t]*)internalField\b/.exec(src)
  if (!internal) return { error: 'no internalField statement' }
  const start = internal.index + (internal[1] ? 1 : 0)
  const semi = src.indexOf(';', start)
  if (semi < 0) return { error: 'internalField statement is not terminated by ";"' }
  const boundary = /(^|\n)[ \t]*boundaryField\b/.exec(src.slice(semi))
  const boundaryStart = boundary ? semi + boundary.index + 1 : -1
  return {
    head: src.slice(0, start),
    internalStatement: src.slice(start, semi + 1),
    between: boundaryStart > 0 ? src.slice(semi + 1, boundaryStart) : src.slice(semi + 1),
    boundary: boundaryStart > 0 ? src.slice(boundaryStart) : '',
  }
}

/** The patch names a `boundaryField` block defines, in file order. */
export function boundaryPatchNames(text) {
  const parts = splitFieldFile(text)
  if (parts.error) return []
  const body = parts.boundary
  const names = []
  const re = /(^|\n)\s{4}([A-Za-z_][\w.\-]*|"[^"]+"|'[^']+')\s*\n\s{4}\{/g
  for (const m of body.matchAll(re)) names.push(m[2].replace(/^["']|["']$/g, ''))
  return names
}

/** Every `0/` field of a case (or of one region), as `{region, name, path}`. */
export function zeroFields(dir, { region = '' } = {}) {
  const root = region ? join(dir, '0', region) : join(dir, '0')
  if (!existsSync(root)) return []
  const out = []
  const walk = (directory, reg) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const p = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(p, reg || entry.name)
        continue
      }
      if (!entry.isFile()) continue
      // Our own backups and editor leftovers are not fields.
      if (/\.(bak|orig|old)$|~$/.test(entry.name)) continue
      let size = 0
      try {
        size = statSync(p).size
      } catch {
        continue
      }
      if (size > MAX_FIELD_FILE_BYTES) continue
      let text = ''
      try {
        text = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      if (!/FoamFile/.test(text) || !/\bclass\s+vol\w*Field\b/.test(text)) continue
      out.push({ region: reg, name: entry.name, path: p })
    }
  }
  walk(root, region)
  return out.sort((a, b) => (a.region + '/' + a.name).localeCompare(b.region + '/' + b.name))
}

/** Physical arity of a field class (`volVectorField` → 3). */
export function arityOf(cls) {
  const m = /^vol(\w*?)Field$/.exec(String(cls || ''))
  if (!m) return 1
  const kind = m[1] ? m[1][0].toLowerCase() + m[1].slice(1) : 'scalar'
  return ARITY[kind] || 1
}

/** A value string is acceptable for this class: right number of components. */
export function checkValueForClass(cls, value) {
  const want = arityOf(cls)
  const raw = String(value == null ? '' : value).trim()
  if (!raw) return { ok: false, error: 'empty value' }
  if (want === 1) {
    if (/^[()]/.test(raw)) return { ok: false, error: `${cls} takes a scalar, not "${raw}"` }
    return Number.isFinite(Number(raw.split(/\s+/)[0])) ? { ok: true } : { ok: false, error: `"${raw}" is not a number` }
  }
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim().split(/[\s,]+/).filter(Boolean)
  if (inner.length !== want) return { ok: false, error: `${cls} takes ${want} components, got ${inner.length} in "${raw}"` }
  if (!inner.every((v) => Number.isFinite(Number(v)))) return { ok: false, error: `"${raw}" is not a vector/tensor of numbers` }
  return { ok: true }
}

/**
 * What would happen if the fields of `templateDir` were written into `dir`.
 *
 * `values` maps a field name to the literal for its new `internalField`; a field
 * that was a per-cell list in the template has no meaningful default, so it is
 * reported as `needsValue` with the most frequent entry as a suggestion.
 */
export function templatePlan({ caseDir, templateDir, region = '', fields = null, values = {} }) {
  const source = zeroFields(templateDir, { region })
  if (!source.length) {
    return { ok: false, error: `no field files under ${join(templateDir, '0', region || '')}`, fields: [] }
  }
  const wanted = fields && fields.length ? new Set(fields) : null
  const patches = (() => {
    try {
      const text = readFileSync(join(caseDir, 'constant', region, 'polyMesh', 'boundary'), 'utf8')
      return parseBoundaryPatches(text).map((p) => p.name)
    } catch {
      return []
    }
  })()
  const plan = []
  const problems = []
  for (const f of source) {
    if (wanted && !wanted.has(f.name)) continue
    const text = readFileSync(f.path, 'utf8')
    const cls = (/\bclass\s+(\w+)\s*;/.exec(text) || [])[1] || 'volScalarField'
    const dimensions = (/\bdimensions\s+(\[[^\]]*\])\s*;/.exec(text) || [])[1] || '[]'
    const parts = splitFieldFile(text)
    if (parts.error) {
      problems.push({ field: f.name, error: parts.error })
      continue
    }
    const parsed = parseInternalField(parts.internalStatement, { component: arityOf(cls) > 1 ? 1 : 0 })
    const kind = parsed && !parsed.error && /nonuniform/.test(parts.internalStatement) ? 'list' : 'uniform'
    const current = kind === 'uniform' ? parts.internalStatement.replace(/^\s*internalField\s+uniform\s+/, '').replace(/;\s*$/, '').trim() : null
    const summary = kind === 'list' ? listSummary(parts.internalStatement) : null
    const entry = { region: f.region, name: f.name, cls, dimensions, kind, boundaryPatches: boundaryPatchNames(text) }
    if (kind === 'uniform') entry.current = current
    if (summary) entry.list = { count: summary.count, min: summary.min, max: summary.max }
    const override = values && Object.prototype.hasOwnProperty.call(values, f.name) ? values[f.name] : undefined
    if (override !== undefined) {
      const check = checkValueForClass(cls, override)
      if (!check.ok) {
        problems.push({ field: f.name, error: check.error })
        continue
      }
      entry.value = String(override).trim()
    } else if (kind === 'uniform') {
      entry.value = current
    } else {
      entry.needsValue = true
      if (summary) entry.suggestion = { value: summary.mode, share: Number(summary.modeShare.toFixed(3)) }
    }
    if (patches.length) {
      const missing = entry.boundaryPatches.filter((k) => !patches.includes(k) && !/[.*|()]/.test(k))
      const uncovered = patches.filter((p) => !entry.boundaryPatches.some((k) => k === p))
      if (missing.length) entry.stalePatches = missing
      if (uncovered.length) entry.uncoveredPatches = uncovered
    }
    plan.push(entry)
  }
  const needsValue = plan.filter((p) => p.needsValue).map((p) => p.name)
  return {
    ok: problems.length === 0,
    case: caseDir,
    template: templateDir,
    region: region || null,
    meshPatches: patches,
    fields: plan,
    needsValue,
    problems,
    canWrite: needsValue.length === 0 && problems.length === 0 && plan.length > 0,
    hint: needsValue.length
      ? `pass values: {${needsValue.map((n) => `"${n}": ${(plan.find((p) => p.name === n).suggestion || {}).value ?? 0}`).join(', ')}} — a per-cell list from the old mesh cannot be carried over, and the suggestion is only the most frequent entry`
      : undefined,
  }
}

/** Apply a plan: rewrite `internalField` to `uniform <value>`, keep the rest. */
export function applyPlan(plan, { backup = true } = {}) {
  if (!plan || !plan.canWrite) return { ok: false, error: 'the plan is not writable', needsValue: plan && plan.needsValue }
  const written = []
  for (const entry of plan.fields) {
    const sourcePath = join(plan.template, '0', entry.region || '', entry.name)
    const targetPath = join(plan.case, '0', entry.region || '', entry.name)
    const text = readFileSync(sourcePath, 'utf8')
    const parts = splitFieldFile(text)
    if (parts.error) return { ok: false, error: `${entry.name}: ${parts.error}`, written }
    const statement = `internalField   uniform ${entry.value};`
    const next = parts.head + statement + parts.between + parts.boundary
    const before = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null
    if (before === next) {
      written.push({ field: entry.name, region: entry.region || null, changed: false })
      continue
    }
    if (before && backup) copyFileSync(targetPath, targetPath + '.bak')
    writeFileSync(targetPath, next)
    written.push({
      field: entry.name,
      region: entry.region || null,
      changed: true,
      from: entry.kind === 'list' ? `${entry.list.count}-value list` : entry.current,
      to: entry.value,
      bytes: next.length,
    })
  }
  return { ok: true, written }
}

const DICT_HEADER = (objectName) => `/*--------------------------------*- C++ -*----------------------------------*\\
  =========                 |
  \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox
   \\\\    /   O peration     | Website:  https://openfoam.org
    \\\\  /    A nd           | Version:  14
     \\\\/     M anipulation  |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    format      ascii;
    class       dictionary;
    object      ${objectName};
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
`

/** `setFieldsDict` text from default values and zone entries. */
export function setFieldsDictText({ defaultValues = {}, zones = [], extrapolatePatches = {} } = {}) {
  const lines = [DICT_HEADER('setFieldsDict')]
  const pairs = Object.entries(defaultValues)
  if (pairs.length) {
    lines.push('defaultValues\n{')
    for (const [name, value] of pairs) lines.push(`    ${name.padEnd(12)} ${value};`)
    lines.push('}\n')
  }
  if (zones.length) {
    lines.push('zones\n{')
    zones.forEach((zone, i) => {
      const name = zone.name || `zone${i}`
      lines.push(`    ${name}\n    {`)
      if (zone.type) lines.push(`        type        ${zone.type};`)
      for (const [key, value] of Object.entries(zone.params || {})) lines.push(`        ${key.padEnd(12)}${value};`)
      lines.push('        values\n        {')
      for (const [field, value] of Object.entries(zone.values || {})) lines.push(`            ${field.padEnd(10)} ${value};`)
      lines.push('        }\n    }')
    })
    lines.push('}')
  }
  const extrap = Object.entries(extrapolatePatches)
  if (extrap.length) {
    lines.push('\nextrapolatePatches\n{')
    for (const [pattern, fields] of extrap) lines.push(`    "${pattern}"   (${fields.join(' ')});`)
    lines.push('}')
  }
  return lines.join('\n') + '\n'
}

/** Zone generators that ship with libmeshTools in OpenFOAM 14. */
export const ZONE_TYPES = ['box', 'sphere', 'cylinder', 'annulus', 'hemisphere', 'truncatedCone', 'insideSurface', 'set', 'dictionary']

/** Shape check on one setFields zone: geometry, type and values. */
export function normaliseZone(zone, index) {
  const name = zone && zone.name ? String(zone.name) : `zone${index}`
  if (!zone || typeof zone !== 'object') return { error: `${name}: a zone needs { type, geometry, values }` }
  const values = zone.values && typeof zone.values === 'object' ? zone.values : null
  if (!values || !Object.keys(values).length) return { error: `${name}: no values — nothing would be set` }
  const params = { ...(zone.params && typeof zone.params === 'object' ? zone.params : {}) }
  const vec = (v, what) => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(Number(x)))) return `${what} needs three numbers`
    return null
  }
  if (zone.box) {
    const bad = vec(zone.box.min, `${name}: box.min`) || vec(zone.box.max, `${name}: box.max`)
    if (bad) return { error: bad }
    if ([0, 1, 2].some((k) => Number(zone.box.max[k]) < Number(zone.box.min[k]))) return { error: `${name}: box.max is below box.min on some axis` }
    params.box = `(${zone.box.min.map(Number).join(' ')}) (${zone.box.max.map(Number).join(' ')})`
  }
  if (zone.sphere) {
    const bad = vec(zone.sphere.origin, `${name}: sphere.origin`) || (Number.isFinite(Number(zone.sphere.radius)) ? null : `${name}: sphere.radius must be a number`)
    if (bad) return { error: bad }
    params.origin = `(${zone.sphere.origin.map(Number).join(' ')})`
    params.radius = Number(zone.sphere.radius)
  }
  if (zone.cylinder) {
    const bad =
      vec(zone.cylinder.point1, `${name}: cylinder.point1`) ||
      vec(zone.cylinder.point2, `${name}: cylinder.point2`) ||
      (Number.isFinite(Number(zone.cylinder.radius)) ? null : `${name}: cylinder.radius must be a number`)
    if (bad) return { error: bad }
    params.point1 = `(${zone.cylinder.point1.map(Number).join(' ')})`
    params.point2 = `(${zone.cylinder.point2.map(Number).join(' ')})`
    params.radius = Number(zone.cylinder.radius)
  }
  if (typeof zone.set === 'string' && zone.set.trim()) params.set = zone.set.trim()
  const type = zone.type ? String(zone.type) : params.box ? 'box' : params.set ? 'set' : params.radius ? 'sphere' : null
  if (!type) return { error: `${name}: no geometry — pass box, sphere, cylinder, set (a cellSet name) or params with an explicit type` }
  if (!ZONE_TYPES.includes(type)) return { error: `${name}: unknown zone type "${type}"; OpenFOAM 14 knows ${ZONE_TYPES.join(', ')}` }
  const needs = { box: ['box'], sphere: ['origin', 'radius'], cylinder: ['point1', 'point2', 'radius'], set: ['set'] }[type]
  if (needs) {
    const missing = needs.filter((k) => params[k] === undefined)
    if (missing.length) return { error: `${name}: type ${type} needs ${missing.join(', ')}` }
  }
  if (!Object.keys(params).length) return { error: `${name}: no zone parameters` }
  return { name, type, params, values }
}

/** Does a box overlap the mesh bounding box? */
export function boxOverlapsMesh(box, bounds) {
  if (!box || !box.min || !box.max || !bounds || !bounds.min || !bounds.max) return { ok: true, unknown: true }
  const overlap = [0, 1, 2].every((k) => Number(box.max[k]) >= Number(bounds.min[k]) && Number(box.min[k]) <= Number(bounds.max[k]))
  return overlap
    ? { ok: true }
    : { ok: false, error: `the box [${box.min.join(', ')}] … [${box.max.join(', ')}] does not overlap the mesh [${bounds.min.join(', ')}] … [${bounds.max.join(', ')}]` }
}

export function fieldPath(caseDir, region, name) {
  return join(caseDir, '0', region || '', name)
}

export function describeField(caseDir, region, name) {
  const p = fieldPath(caseDir, region, name)
  if (!existsSync(p)) return null
  let text = ''
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    return null
  }
  const info = fieldClass(text)
  return { name, path: p, file: basename(p), cls: info.cls || 'volScalarField' }
}
