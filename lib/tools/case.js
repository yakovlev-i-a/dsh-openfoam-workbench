import { checkCase as checkCaseEngine } from '../of-engine.js'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { bashrcFor, caseLookupHint, dirSize, foamEnv, readText, resolveCase, resolveCaseInfo, run, runFoam, textOut, topLevelKeys } from '../runtime.js'
import { capsSummary, probeCaps } from '../versions.js'
import { diagnoseError } from '../knowledge.js'
import { parseBoundaryPatches } from '../of-engine.js'
import { algoCaseAudit, algoExtractContract } from '../caselib.js'
import { caseLibNames, checkBlockMeshDict, checkBoundaryFields, checkControlDict, checkFvSchemes, checkFvSolution, checkStrayTimes, fieldFiles, meshBounds, readCaseDict, vectorValue } from '../of-engine.js'
import { analyseFlow, flatAxisOf, latestFluxTime, patchAreas, processorIds, readPatchFlux } from '../flowcheck.js'
import { readFieldStats } from '../fields.js'
import { applyPlan, boxOverlapsMesh, checkValueForClass, describeField, normaliseZone, setFieldsDictText, templatePlan, zeroFields } from '../fieldwrite.js'
import { availableDicts, caseBBox, caseRegions, containedPath, ensureFoamFile, normaliseDictPath, regionSolvers } from '../of-case.js'
import { geometryScalePrompt, scaleGateApplies } from '../needs-input.js'
import { distributionKind, scaffoldFiles } from '../scaffold.js'
import { scaffoldCht } from '../scaffold-cht.js'
import { scaffoldCompressible } from '../scaffold-compressible.js'
import { classifyImpact, decideAction } from '../impact.js'

function hashText(text) { return createHash('sha256').update(String(text), 'utf8').digest('hex') }

const ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_.:]*$/
// Any '#' token is a dictionary directive: #codeStream/#calc/#eval execute code,
// #include/#includeEtc/#includeIfPresent/#includeFunc read other files (absolute
// paths allowed), #inputMode/#remove rewrite the dictionary. None is a scalar.
const DANGEROUS_DIRECTIVE = /#\w+|\bcodeStream\b/i

/** One-line value validation: a value must not be able to add entries. */
function validateEntryValue(entry, value) {
  if (!ENTRY_RE.test(String(entry))) {
    return { ok: false, error: `invalid entry name: ${entry}`, hint: 'letters, digits, "_", "." and ":" are allowed' }
  }
  const text = String(value)
  if (/[\r\n]/.test(text)) {
    return { ok: false, error: 'value must be a single line', hint: 'a newline would inject extra dictionary entries' }
  }
  if (text.includes(';')) {
    return { ok: false, error: 'value must not contain ";"', hint: 'the entry is terminated automatically' }
  }
  // A scalar value has no dictionary structure: braces are the only way to close
  // the entry early and start a new one on the same line, so they are refused
  // outright (a balanced pair is enough to smuggle `libs (...)` past the parser).
  if (/[{}]/.test(text)) {
    return {
      ok: false,
      error: 'braces are not allowed in a scalar value (sub-dictionaries cannot be edited by this tool)',
      hint: 'dict_set changes one single-line top-level entry; edit a sub-dictionary with a dedicated tool',
    }
  }
  return { ok: true }
}

/** Content that executes code or loads libraries at dictionary-read time. */
function dangerousContent(text) {
  const hits = []
  if (DANGEROUS_DIRECTIVE.test(String(text))) hits.push('code directive (#codeStream/#calc/#eval/#include)')
  return hits
}

function sha256(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex') } catch { return null }
}

function changesDirOf(dir) { return join(dir, '.openfoam-changes') }

function listChanges(dir) {
  try { return readdirSync(changesDirOf(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).slice(-20) } catch { return [] }
}

/** Current value of a top-level entry, or null when it is absent. */
function topLevelEntryValue(text, entry) {
  const re = new RegExp('^(\\s*)' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([^;]*);')
  const lines = String(text).split('\n')
  let depth = 0
  for (const line of lines) {
    if (depth === 0) {
      const m = re.exec(line)
      if (m) return m[2].trim()
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
  }
  return null
}

/** Replace (or append) one top-level entry; returns the new text without writing. */
function replaceTopLevelEntry(text, entry, value, append) {
  const re = new RegExp('^(\\s*)' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([^;]*);')
  const lines = String(text).split('\n')
  let depth = 0
  let oldValue = null
  let replaced = false
  let lineNo = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!replaced && depth === 0) {
      const m = re.exec(line)
      if (m) {
        oldValue = m[2].trim()
        lines[i] = m[1] + entry + ' ' + value + ';'
        replaced = true
        lineNo = i + 1
      }
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
  }
  if (!replaced) {
    // `functions`, `boundaryField`, `libs`-style blocks are subdictionaries, not
    // single-line values: a line-based editor must refuse them explicitly.
    const subdict = new RegExp('^\\s*' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\{|$)')
    let depthCheck = 0
    for (const line of lines) {
      if (depthCheck === 0 && subdict.test(line)) return { ok: false, reason: 'subdictionary' }
      depthCheck += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
    }
    if (!append) return { ok: false, reason: 'not-found' }
    lines.push(`${entry} ${value};`)
    lineNo = lines.length
  }
  return { ok: true, text: lines.join('\n'), old: oldValue, line: lineNo, replaced }
}

/**
 * A dictionary key path: `maxDeltaT` (top level) or `PIMPLE/maxDeltaT` (one level
 * inside a block, the routine edit when LTS is switched on or off). Every part
 * is a plain keyword, so a path can never smuggle in a brace or a `#directive`.
 */
export function splitEntryPath(entry) {
  const raw = String(entry == null ? '' : entry).trim()
  if (!raw) return { ok: false, error: 'entry is empty' }
  const parts = raw.split('/').map((p) => p.trim())
  if (parts.some((p) => !/^[A-Za-z_][A-Za-z0-9_.:]*$/.test(p))) {
    return {
      ok: false,
      error: /[\s;{}]/.test(raw) ? `invalid entry name: ${raw}` : `invalid entry path: ${raw}`,
      hint: 'each part must be a plain keyword, e.g. maxDeltaT or PIMPLE/maxDeltaT',
    }
  }
  if (parts.length > 3) return { ok: false, error: `entry path too deep: ${raw}`, hint: 'at most three levels: A/B/C' }
  return { ok: true, path: parts }
}

/** Line indexes of a sub-dictionary body inside [from, to), and whether it is one line. */
export function findSubDictBlock(lines, from, to, name) {
  const head = new RegExp('^(\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*([{(]|$)')
  let depth = 0
  for (let i = from; i < to; i += 1) {
    const line = lines[i]
    if (depth === 0) {
      const m = head.exec(line)
      if (m) {
        // `PIMPLE { maxDeltaT 0.5; }` on one line: the body is the text
        // between the braces, and the caller rewrites that single line.
        const open = line.indexOf('{')
        const close = line.lastIndexOf('}')
        if (open >= 0 && close > open) return { single: true, line: i, inner: line.slice(open + 1, close), indent: m[1] }
        // `PIMPLE` on its own line with the brace on the next one is the usual
        // layout, so the brace is searched for rather than required on this line.
        let braceLine = i
        if (open < 0) {
          let k = i + 1
          while (k < to && !lines[k].trim()) k += 1
          if (k >= to || !lines[k].trim().startsWith('{')) return null
          braceLine = k
        }
        const openCol = braceLine === i ? open : lines[braceLine].indexOf('{')
        const after = lines[braceLine].slice(openCol + 1).trim() ? braceLine : braceLine + 1
        let d = (lines[braceLine].match(/{/g) || []).length - (lines[braceLine].match(/}/g) || []).length
        for (let j = braceLine + 1; j < to; j += 1) {
          d += (lines[j].match(/{/g) || []).length - (lines[j].match(/}/g) || []).length
          // The body ends *before* the line that closes the block.
          if (d <= 0) return { single: false, open: after, close: j, indent: m[1] }
        }
        return null
      }
    }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
  }
  return null
}

/** Resolve `A/B` to the line range of B's body, so the single-line editor can work inside it. */
function pathRange(lines, path) {
  let from = 0
  let to = lines.length
  const steps = []
  for (let i = 0; i < path.length - 1; i += 1) {
    const blk = findSubDictBlock(lines, from, to, path[i])
    if (!blk) return { ok: false, reason: 'no-subdictionary', path: path.slice(0, i + 1).join('/'), steps }
    steps.push({ name: path[i], ...blk })
    if (blk.single) {
      return { ok: false, reason: 'single-line-subdictionary', path: path.slice(0, i + 1).join('/'), blk }
    }
    from = blk.open
    to = blk.close
  }
  return { ok: true, from, to, steps }
}

/** The value of `A/B` (or of a top-level key), or null. */
export function entryValueAtPath(text, path) {
  const lines = String(text).split('\n')
  const r = pathRange(lines, path)
  if (!r.ok) {
    if (r.reason === 'single-line-subdictionary' && path.length > 1) {
      const inner = r.blk.inner
      const m = new RegExp('(^|\\s)' + path[path.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([^;]*);').exec(inner)
      return m ? m[2].trim() : null
    }
    return null
  }
  return topLevelEntryValue(lines.slice(r.from, r.to).join('\n'), path[path.length - 1])
}

/** Replace (or, with append, add) `A/B`, leaving every other line untouched. */
export function replaceEntryAtPath(text, path, value, append) {
  const lines = String(text).split('\n')
  const r = pathRange(lines, path)
  const entry = path[path.length - 1]
  if (!r.ok) {
    if (r.reason === 'single-line-subdictionary' && path.length > 1) {
      const inner = r.blk.inner
      const res = replaceTopLevelEntry(inner, entry, value, append)
      if (!res.ok) return res
      const line = lines[r.blk.line]
      const open = line.indexOf('{')
      const close = line.lastIndexOf('}')
      const oneLine = res.text.replace(/\s*\n\s*/g, ' ').trim()
      lines[r.blk.line] = line.slice(0, open + 1) + ' ' + oneLine + ' ' + line.slice(close)
      return { ...res, text: lines.join('\n'), line: r.blk.line + 1 }
    }
    return r
  }
  const body = lines.slice(r.from, r.to)
  const res = replaceTopLevelEntry(body.join('\n'), entry, value, append)
  if (!res.ok) return res
  let bodyText = res.text
  if (!res.replaced) {
    // An appended key inherits the indentation of its neighbours, so the block
    // keeps its shape instead of gaining a column-0 line.
    const neighbour = body.find((l) => /^\s+\S/.test(l))
    const indent = neighbour ? /^\s*/.exec(neighbour)[0] : '    '
    bodyText = bodyText.replace(new RegExp('^' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' ', 'm'), indent + entry + ' ')
  }
  const out = [...lines.slice(0, r.from), ...bodyText.split('\n'), ...lines.slice(r.to)]
  return { ...res, text: out.join('\n'), line: res.line != null ? res.line + r.from : null }
}

/** Remove `A/B` (used to undo an appended nested key). */
export function removeEntryAtPath(text, path) {
  const lines = String(text).split('\n')
  const r = pathRange(lines, path)
  const entry = path[path.length - 1]
  if (!r.ok) return r
  const body = lines.slice(r.from, r.to)
  const res = removeTopLevelEntry(body.join('\n'), entry)
  if (!res.ok) return res
  const out = [...lines.slice(0, r.from), ...res.text.split('\n'), ...lines.slice(r.to)]
  return { ok: true, text: out.join('\n'), removed: res.removed }
}

/** Remove one single-line top-level entry (used to undo an appended key). */
function removeTopLevelEntry(text, entry) {
  const re = new RegExp('^\\s*' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+[^;]*;\\s*$')
  const lines = String(text).split('\n')
  let depth = 0
  let removed = 0
  const kept = []
  for (const line of lines) {
    const atTop = depth === 0
    if (atTop && removed === 0 && re.test(line)) { removed += 1 } else { kept.push(line) }
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
  }
  if (removed === 0) return { ok: false, reason: 'not-found' }
  return { ok: true, text: kept.join('\n') }
}

/** Keys at the level a path addresses (the block body for `A/B`). */
export function keysAtPath(text, path) {
  const lines = String(text).split('\n')
  const r = pathRange(lines, path)
  if (!r.ok) return []
  return topLevelKeys(lines.slice(r.from, r.to).join('\n'))
}

/** One-shot human decision for a critical change; fails closed. */
async function requestApproval({ approval, exec, toolName, reason }) {
  if (!exec?.agent) {
    return {
      ok: false,
      error: 'critical change requires approval, but this execution context carries no agent identity (fail-closed)',
      hint: 'run the change from a normal agent turn, or edit the file manually',
    }
  }
  if (typeof approval?.request !== 'function') {
    return {
      ok: false,
      error: 'critical change requires approval, but the DSH approval service is not mounted (fail-closed)',
      hint: 'mount @deepseek-ai/dsh-user-approval with an answerer, or edit the file manually',
    }
  }
  try {
    const outcome = await approval.request({ agent: exec?.agent, toolName, callId: exec?.callId, reason })
    const value = typeof outcome === 'string' ? outcome : outcome?.type ?? outcome?.outcome
    if (value === 'allowed-once') return { ok: true, outcome: 'allowed-once' }
    return { ok: false, outcome: value || 'unavailable', error: `approval ${value || 'unavailable'}: the change was not applied` }
  } catch (e) {
    return { ok: false, error: 'approval failed: ' + String((e && e.message) || e) }
  }
}

/**
 * Where a run of this distribution looks for libraries, plus the places a case
 * library lands when it was built with a stripped environment (`env -i` leaves
 * USER empty, so wmake installs into ~/OpenFOAM/-<version>/platforms/...).
 * Cached per bashrc: the probe sources the OpenFOAM setup, which is not cheap.
 */
const libDirCache = new Map()
async function caseLibSearch(cfg, dir, bash) {
  const key = bash + '|' + String(cfg.defaultDistribution || '')
  let base = libDirCache.get(key)
  if (!base) {
    const r = await runFoam(['bash', '-c', 'printf "%s\\n%s\\n" "$FOAM_LIBBIN" "$FOAM_USER_LIBBIN"'], { bashrc: bash, dir, timeoutMs: 60000 })
    const lines = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
    base = { libDirs: [...new Set(lines)] }
    if (r.ok && base.libDirs.length) libDirCache.set(key, base)
  }
  const searchDirs = []
  const home = process.env.HOME || ''
  if (home) {
    const openfoamHome = join(home, 'OpenFOAM')
    try {
      for (const entry of readdirSync(openfoamHome, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const platforms = join(openfoamHome, entry.name, 'platforms')
        let platforms_ = []
        try { platforms_ = readdirSync(platforms, { withFileTypes: true }) } catch { platforms_ = [] }
        for (const p of platforms_) if (p.isDirectory()) searchDirs.push(join(platforms, p.name, 'lib'))
      }
    } catch { /* no ~/OpenFOAM: nothing to search */ }
  }
  return { libDirs: base ? base.libDirs : [], searchDirs }
}

export default function caseTools({ cfg, getApproval }) {
  return [
  // --- tool: case doctor (silent failures, from dsh-openfoam-doctor, MIT) ---
  {
    name: 'openfoam_check',
    description: 'Audit an OpenFOAM case for the failures that do not announce themselves: steadyState paired with timeStep writes, limiter=1 (negative k/epsilon), unbounded advection, nNonOrthogonalCorrectors 0 on skewed meshes, stray time dirs, boundary mistakes, unresolved case libraries (`libs (...)` entries that are not on the loader path). Deterministic — every finding has a fix. Run before the first solver run.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'Optional: check only one dict — controlDict | fvSchemes | fvSolution | blockMeshDict | boundaries | times.' },
        region: { type: 'string', description: 'Check one region of a multi-region case; by default every region is checked.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args && args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const regions = caseRegions(dir)
      if (args.region && regions.length && !regions.includes(args.region)) {
        return { ok: false, error: `no such region: ${args.region}`, regions }
      }
      const wanted = args.region ? [args.region] : regions
      const perRegion = (fn) => (wanted.length
        ? wanted.flatMap((r) => fn(dir, r).map((f) => ({ ...f, region: r })))
        : fn(dir))
      let findings
      if (args.file === 'controlDict') findings = checkControlDict(dir)
      else if (args.file === 'fvSchemes') findings = perRegion(checkFvSchemes)
      else if (args.file === 'fvSolution') findings = perRegion(checkFvSolution)
      else if (args.file === 'blockMeshDict') findings = perRegion(checkBlockMeshDict)
      else if (args.file === 'boundaries') findings = perRegion(checkBoundaryFields)
      else if (args.file === 'times') findings = checkStrayTimes(dir)
      else {
        // Only probe the loader path when the case actually declares libraries.
        const libs = caseLibNames(dir)
        let libContext = {}
        if (libs.length) {
          const bash = bashrcFor(cfg, args.distribution)
          if (bash && existsSync(bash)) libContext = await caseLibSearch(cfg, dir, bash)
        }
        findings = checkCaseEngine(dir, { regions: wanted, ...libContext })
      }

      // Geometry-scale gate: a metre-sized box is the classic sign of a model
      // built in millimetres that was never rescaled.
      let needsInput = null
      const askAbove = Number(cfg.scaleAskAbove) || 0
      const bbox = caseBBox(dir)
      if (bbox.ok && scaleGateApplies(bbox.maxExtent, askAbove)) {
        const extent = Number(bbox.maxExtent.toFixed(4))
        findings = findings.concat([{
          rule: 'geometry-scale',
          severity: 'ask',
          title: `geometry is ${extent} m across`,
          detail: `The mesh bounding box is ${extent} m. If the model was built in millimetres, everything is 1000x too large and the physics (Reynolds, Courant, time scales) is wrong.`,
          fix: 'Confirm the units with the user; if millimetres, rescale the geometry by 1e-3 and rebuild the mesh.',
        }])
        needsInput = geometryScalePrompt({ extent: bbox.maxExtent, askAbove })
      }
      const caps = await probeCaps(bashrcFor(cfg, args.distribution), args.distribution || cfg.defaultDistribution)
      if (caps.support === 'unknown') {
        findings = findings.concat([{
          rule: 'untested-version',
          severity: 'warn',
          title: `this OpenFOAM release is not covered by the tests (${capsSummary(caps)})`,
          detail: 'The installed version differs from the ones the workbench is validated against (org 14, com v2606). Dictionary conventions are taken from the family and may not match this release.',
          fix: 'Treat findings as advice, check the solver output, and report the version so it can be added to the support matrix.',
        }])
      }
      return {
        ok: true,
        path: dir,
        caps: { summary: capsSummary(caps), support: caps.support, family: caps.family, modular: caps.modular },
        resolvedFrom: resolveCaseInfo(cfg, args.casePath).resolvedFrom,
        ...(regions.length ? { regions } : {}),
        ...(args.region ? { region: args.region } : {}),
        count: findings.length,
        findings,
        ...(needsInput ? { needs_input: needsInput } : {}),
      }
    },
  },
  // --- tool: read a dictionary as JSON ---
  {
    name: 'openfoam_read_dict',
    description: 'Read an OpenFOAM dictionary as JSON. Accepts `controlDict`, `fluid/fvSchemes`, `system/fluid/fvSchemes`, `constant/fluid/thermophysicalProperties`, `0/fluid/T` — with `region` when the case is multi-region. Use this INSTEAD of reading/cat-ing dictionary files to check what a case actually says. No OpenFOAM run needed.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'controlDict | fvSchemes | <region>/fvSchemes | system/<region>/<dict> | constant/<region>/<dict> | 0/<region>/<field>' },
        region: { type: 'string', description: 'Region name for multi-region cases (e.g. fluid); a bare file name is then looked up in system/<region> first.' },
      },
      required: ['casePath', 'file'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args && args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const found = normaliseDictPath(dir, args && args.file, args && args.region)
      if (!found.ok) {
        const available = availableDicts(dir)
        const regions = caseRegions(dir)
        const notFound = {
          ok: false,
          error: found.error || `not found: ${args.file}`,
          ...(found.hint ? { hint: found.hint } : {}),
          tried: found.tried,
          hint: regions.length
            ? `multi-region case (${regions.join(', ')}): pass file="<region>/<dict>" or region="<region>"; system/<region>/, constant/<region>/ and 0/<region>/ also work`
            : 'file is resolved against system/, constant/ and 0/; system/constant/0 prefixes are accepted as-is',
        }
        if (regions.length) notFound.regions = regions
        if (available.length) notFound.available = available
        return notFound
      }
      const dict = readCaseDict(dir, found.rel)
      if (dict === null) return { ok: false, error: 'cannot parse: ' + found.rel, tried: found.tried }
      const foundDict = { ok: true, file: found.rel, dict }
      if (args && args.region) foundDict.region = args.region
      return foundDict
    },
  },
  // --- tool: patch diff ---
  {
    name: 'openfoam_patch_diff',
    description: 'Report the boundary patches of a case (name, type, nFaces) from constant/polyMesh/boundary; optionally diff against a previous snapshot to find added/missing/type-changed patches.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        snapshot_before: { type: 'string', description: 'Optional JSON from a previous call (patches array) to diff against.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const text = readText(join(dir, 'constant/polyMesh/boundary'))
      if (!text) return { ok: false, error: 'no constant/polyMesh/boundary' }
      const patches = parseBoundaryPatches(text)
      let diff = null
      if (args.snapshot_before) {
        try {
          const before = JSON.parse(args.snapshot_before)
          const beforeArr = Array.isArray(before) ? before : before.patches || []
          const beforeMap = new Map(beforeArr.map((p) => [p.name, p]))
          const nowMap = new Map(patches.map((p) => [p.name, p]))
          const added = patches.filter((p) => !beforeMap.has(p.name)).map((p) => p.name)
          const missing = [...beforeMap.keys()].filter((n) => !nowMap.has(n))
          const typeChanged = patches
            .filter((p) => beforeMap.has(p.name) && beforeMap.get(p.name).type !== p.type)
            .map((p) => ({ name: p.name, from: beforeMap.get(p.name).type, to: p.type }))
          diff = { added, missing, typeChanged }
        } catch (e) {
          diff = { error: 'invalid snapshot_before: ' + ((e && e.message) || e) }
        }
      }
      return { ok: true, patches, diff }
    },
  },
  // --- tool: diagnose an error ---
  {
    name: 'openfoam_diagnose_error',
    description: 'Match a log tail / error section against built-in OpenFOAM/C++ error patterns (plus learned ones) and return category, causes and next steps. Call it first on any non-zero exit or FOAM FATAL ERROR.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'log tail or error section (up to ~8000 chars).' } },
      required: ['text'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => diagnoseError(cfg, args.text),
  },
  // --- tool: four-step step 1 ---
  {
    name: 'openfoam_algo_extract_contract',
    description: 'Heuristically extract an algorithm contract (inputs/outputs/equations/governing_type/assumptions) from an OpenFOAM .H/.C/.py or workspace file. Step 1 of the four-step method.',
    parameters: {
      type: 'object',
      properties: { source_file: { type: 'string' }, algorithm_name: { type: 'string' } },
      required: ['source_file'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => algoExtractContract(cfg, args),
  },
  // --- tool: four-step step 3 ---
  {
    name: 'openfoam_algo_case_audit',
    description: 'Compare an algorithm contract (step 1) with case facts (step 2), list mismatches. Entering step 4 while mismatches are non-empty is forbidden.',
    parameters: {
      type: 'object',
      properties: { contract: { type: 'object' }, case_facts: { type: 'object' } },
      required: ['contract', 'case_facts'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => algoCaseAudit(args),
  },
  // --- tool: set a dictionary entry atomically (impact-aware) ---
  {
    name: 'openfoam_dict_set',
    description: 'Set one dictionary entry atomically (write temp + rename, .bak kept). The entry is a plain key (`deltaT`) or a path into a block (`PIMPLE/maxDeltaT`), which is where the LTS limits live. Impact-aware: output/organisation keys in controlDict apply immediately; anything that can change physics or numerics (0/*, fvSchemes, fvSolution, constant/*, deltaT, application) is a preview unless apply:true is passed, and libs/functions require approval. Pass expect to refuse a write whose current value differs. Returns changeId for openfoam_dict_undo. Accepts multi-region paths (`fluid/fvSchemes`, `0/fluid/T`). Use this INSTEAD of sed/python.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'controlDict | fluid/fvSchemes | system/fluid/fvSchemes | 0/fluid/T' },
        entry: { type: 'string', description: 'A key (`deltaT`) or a path into a sub-dictionary (`PIMPLE/maxDeltaT`); at most three levels.' },
        value: { type: 'string', description: 'OpenFOAM text, e.g. "0.01", "uniform (1 0 0)", "Gauss linear".' },
        region: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Force a preview (never writes).' },
        apply: { type: 'boolean', description: 'Write a high-impact change without a preview.' },
        expect: { type: 'string', description: 'Refuse unless the current value equals this.' },
        backup: { type: 'boolean', description: 'Keep <file>.bak (default true).' },
        append: { type: 'boolean', description: 'Append the entry when it does not exist at the addressed level.' },
      },
      required: ['casePath', 'file', 'entry', 'value'],
    },
    output: {
      schema: { type: 'object' },
      render: (_a, v) => {
        if (v && v.applied === false && v.preview) {
          return [{ type: 'text', text: `NOT APPLIED (preview, ${v.impact} impact)\n` + JSON.stringify(v, null, 2) }]
        }
        return textOut(v)
      },
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const found = normaliseDictPath(dir, args.file, args.region)
      if (!found.ok) {
        return {
          ok: false,
          error: found.error || 'not found: ' + args.file,
          file: args.file,
          ...(found.tried ? { tried: found.tried } : {}),
          ...(found.hint ? { hint: found.hint } : {}),
          available: availableDicts(dir),
        }
      }
      const target = join(dir, found.rel)
      const text = readText(target)
      if (text == null) return { ok: false, error: 'cannot read: ' + found.rel }
      const beforeHash = hashText(text)
      const entry = String(args.entry)
      const value = String(args.value)
      const parsed = splitEntryPath(entry)
      if (!parsed.ok) return { ok: false, applied: false, file: found.rel, entry, ...parsed }
      const path = parsed.path
      // Each part of the path is a keyword; the value rules are the leaf's.
      const valid = validateEntryValue(path[path.length - 1], value)
      if (!valid.ok) return { ok: false, applied: false, file: found.rel, entry, ...valid }
      // A value that carries an executable directive is critical regardless of
      // the entry it is written to.
      const danger = dangerousContent(`${entry} ${value};`)
      const impact = danger.length ? 'critical' : classifyImpact(found.rel, entry, value)

      // `expect` guard: refuse to write on top of a value the caller did not see.
      if (args.expect !== undefined) {
        const current = path.length === 1 ? topLevelEntryValue(text, entry) : entryValueAtPath(text, path)
        if (current === null) return { ok: false, error: `entry not found: ${path.join('/')}`, file: found.rel, topLevelEntries: topLevelKeys(text).slice(0, 40) }
        if (String(current).trim() !== String(args.expect).trim()) {
          return { ok: false, error: `expect mismatch: expected "${args.expect}", found "${current}"`, file: found.rel, entry, found: current }
        }
      }

      const edit = path.length === 1
        ? replaceTopLevelEntry(text, entry, value, Boolean(args.append))
        : replaceEntryAtPath(text, path, value, Boolean(args.append))
      if (!edit.ok && edit.reason === 'subdictionary') {
        return {
          ok: false,
          error: `${entry} is a sub-dictionary, not a single-line entry`,
          file: found.rel,
          impact,
          hint: `address a scalar inside it: entry="${entry}/<key>"`,
        }
      }
      if (!edit.ok && edit.reason === 'no-subdictionary') {
        return {
          ok: false,
          error: `no sub-dictionary ${edit.path} in ${found.rel}`,
          file: found.rel,
          topLevelEntries: topLevelKeys(text).slice(0, 40),
          hint: 'the path is A/B: the first part must be an existing block; read the dictionary to see its keys',
        }
      }
      if (!edit.ok && edit.reason === 'single-line-subdictionary') {
        return { ok: false, error: `${edit.path} is written on one line and cannot be addressed by path`, file: found.rel, hint: 'split the block over several lines first' }
      }
      if (!edit.ok) {
        return {
          ok: false,
          error: path.length === 1 ? `entry not found at top level: ${entry}` : `entry not found in ${path.slice(0, -1).join('/')}: ${path[path.length - 1]}`,
          file: found.rel,
          topLevelEntries: topLevelKeys(text).slice(0, 40),
          hint: 'pass append:true to add it (or check that the entry is not inside a sub-dictionary)',
        }
      }
      if (edit.text === text) return { ok: true, changed: false, applied: false, impact, file: found.rel, entry, note: 'value already set' }
      // Defence in depth: an edit may only touch its own entry, at the level the
      // path addresses (top level for `deltaT`, the block body for `PIMPLE/maxDeltaT`).
      const keysAt = (t) => (path.length === 1 ? topLevelKeys(t) : keysAtPath(t, path))
      const beforeKeys = new Set(keysAt(text))
      const afterKeys = new Set(keysAt(edit.text))
      const leaf = path[path.length - 1]
      const extra = [...afterKeys].filter((k) => !beforeKeys.has(k) && k !== leaf)
      const missing = [...beforeKeys].filter((k) => !afterKeys.has(k) && k !== leaf)
      if (extra.length || missing.length) {
        return { ok: false, applied: false, error: 'the edit would change the top-level structure of the dictionary', file: found.rel, entry, extra, missing }
      }
      const semisBefore = (text.match(/;/g) || []).length
      const semisAfter = (edit.text.match(/;/g) || []).length
      if (!args.append && semisAfter !== semisBefore) {
        return { ok: false, applied: false, error: 'the edit would add or remove entries (semicolon count changed)', file: found.rel, entry, semisBefore, semisAfter }
      }

      const action = decideAction({
        impact,
        writeMode: cfg.writeMode || 'impact',
        applyRequested: args.apply === true,
        dryRun: args.dryRun === true,
      })

      let approvalInfo = null
      if (action === 'approval') {
        const service = typeof getApproval === 'function' ? getApproval() : undefined
        const asked = await requestApproval({ approval: service, exec, toolName: 'openfoam_dict_set', reason: `set ${found.rel}: ${entry} = ${value} (critical impact)` })
        approvalInfo = {
          outcome: asked.outcome || (asked.ok ? 'allowed-once' : 'unavailable'),
          hasService: Boolean(service && typeof service.request === 'function'),
          hasAgent: Boolean(exec?.agent),
          hasCallId: Boolean(exec?.callId),
        }
        if (!asked.ok) return { ok: false, ...asked, approval: approvalInfo, impact, file: found.rel, entry, old: edit.old, new: value, ...(danger.length ? { danger } : {}) }
      }

      if (action === 'preview') {
        return {
          ok: true,
          applied: false,
          preview: true,
          changed: true,
          impact,
          file: found.rel,
          entry,
          old: edit.old,
          new: value,
          line: edit.line,
          note: 'NOT APPLIED — this change can alter physics or numerics; re-run with apply:true (or set writeMode:"apply")',
        }
      }

      // Compare-and-swap: the edit was computed from `text`; if the file moved on
      // (another agent, the user, a solver re-reading) refuse instead of
      // overwriting the newer content with a stale copy.
      const currentText = readText(target)
      if (currentText == null || hashText(currentText) !== beforeHash) {
        return {
          ok: false,
          applied: false,
          error: 'the file changed after the change was prepared (concurrent modification); nothing was written',
          file: found.rel,
          entry,
          hint: 're-read the dictionary with openfoam_read_dict and prepare the change again' + (impact === 'critical' ? ' (the approval must be requested again)' : ''),
        }
      }
      const changeId = 'chg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const afterHash = createHash('sha256').update(edit.text, 'utf8').digest('hex')
      const journal = changesDirOf(dir)
      const journalPath = join(journal, changeId + '.json')
      // Record the change *before* touching the case: a write without a durable
      // undo record would advertise an undo that cannot be honoured.
      try {
        mkdirSync(journal, { recursive: true })
        writeFileSync(journalPath, JSON.stringify({
          changeId,
          at: new Date().toISOString(),
          file: found.rel,
          entry,
          old: edit.old,
          new: value,
          existedBefore: Boolean(edit.replaced),
          afterHash,
          tool: 'openfoam_dict_set',
        }, null, 2) + '\n')
      } catch (e) {
        return {
          ok: false,
          error: 'cannot record the change for undo; nothing was written: ' + String((e && e.message) || e),
          file: found.rel,
          entry,
          hint: 'check write permission on ' + journal,
        }
      }

      const backup = args.backup === false ? null : target + '.bak'
      if (backup) { try { cpSync(target, backup) } catch {} }
      const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
      try {
        writeFileSync(tmp, edit.text)
        renameSync(tmp, target)
      } catch (e) {
        try { rmSync(tmp, { force: true }) } catch {}
        try { rmSync(journalPath, { force: true }) } catch {}
        return { ok: false, error: 'write failed: ' + String((e && e.message) || e), file: found.rel, entry }
      }

      return {
        ok: true,
        applied: true,
        changed: true,
        impact,
        file: found.rel,
        path: target,
        entry,
        old: edit.old,
        new: value,
        backup,
        line: edit.line,
        changeId,
        ...(approvalInfo ? { approval: approvalInfo } : {}),
        undo: { tool: 'openfoam_dict_undo', changeId, expectHash: afterHash },
      }
    },
  },
  // --- tool: undo one dict_set change ---
  {
    name: 'openfoam_dict_undo',
    description: 'Revert one openfoam_dict_set change by changeId. Refuses when the file changed after that edit (afterHash mismatch), so a later edit is never silently discarded. Keeps a .bak of the current file.',
    parameters: {
      type: 'object',
      properties: { casePath: { type: 'string' }, changeId: { type: 'string' }, region: { type: 'string' } },
      required: ['casePath', 'changeId'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const record = readText(join(changesDirOf(dir), String(args.changeId) + '.json'))
      if (!record) return { ok: false, error: `no such change: ${args.changeId}`, changes: listChanges(dir) }
      let rec
      try { rec = JSON.parse(record) } catch { return { ok: false, error: 'change record is not valid JSON: ' + args.changeId } }
      const safe = containedPath(dir, rec.file)
      if (!safe.ok) return { ok: false, error: 'the change record points outside the case: ' + safe.error, file: rec.file }
      const target = safe.path
      const text = readText(target)
      if (text == null) return { ok: false, error: 'cannot read: ' + rec.file }
      const currentHash = sha256(target)
      if (rec.afterHash && currentHash !== rec.afterHash) {
        return {
          ok: false,
          error: 'the file changed after this edit; refusing to undo',
          changeId: rec.changeId,
          file: rec.file,
          entry: rec.entry,
          hint: 'revert the later changes first (list them with openfoam_dict_undo? changes=...) or edit the entry manually',
        }
      }
      const appended = rec.existedBefore === false
      const undPath = splitEntryPath(rec.entry)
      if (!undPath.ok) return { ok: false, error: `the change record has an invalid entry path: ${rec.entry}` }
      const pth = undPath.path
      const edit = appended
        ? (pth.length === 1 ? removeTopLevelEntry(text, rec.entry) : removeEntryAtPath(text, pth))
        : (pth.length === 1 ? replaceTopLevelEntry(text, rec.entry, rec.old ?? '', false) : replaceEntryAtPath(text, pth, rec.old ?? '', false))
      if (!edit.ok) return { ok: false, error: `entry not found any more: ${rec.entry}`, file: rec.file }
      const backup = target + '.bak'
      try { cpSync(target, backup) } catch {}
      const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
      writeFileSync(tmp, edit.text)
      renameSync(tmp, target)
      return {
        ok: true,
        applied: true,
        undoOf: rec.changeId,
        file: rec.file,
        entry: rec.entry,
        restored: appended ? null : rec.old,
        removed: appended,
        was: rec.new,
        afterHash: sha256(target),
      }
    },
  },
  // --- tool: field statistics (min/max) at a time ---
  {
    name: 'openfoam_field_stats',
    description: 'Min/max of one field at the latest (or a given) time, for judging magnitudes (U range, T rise, p level) without opening ParaView. The values are read straight out of the written field files, so it works on a read-only case, on a decomposed case (the range over every processor* is the global range) and on a case whose physics the post-processing utility cannot construct (a reacting multi-region case); a binary field falls back to foamPostProcess/postProcess, which is where `libPaths` matters. Pass `time2` to compare two written steps.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        field: { type: 'string', description: 'Field name, e.g. U, T, p, k, CH4.' },
        time: { type: 'string', description: 'Time value; default: the latest written time that carries the field.' },
        time2: { type: 'string', description: 'Compare with this second time: the answer then reports the change between the two written steps instead of a single range — the quick way to ask "did the field actually change" (flame moved, patch heated up) without ParaView.' },
        region: { type: 'string', description: 'Mesh region for multi-region cases (e.g. fluid, solid).' },
        parallel: { type: 'boolean', description: 'Read the decomposed processor* time directories; default: on when they exist.' },
        distribution: { type: 'string', description: 'org | com' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment for the post-processing utility. Only `LD_LIBRARY_PATH` is accepted: a case with custom libraries (fvMeshTopoChanger, fvOptions) needs their directory on the loader path, otherwise the utility dies with "dlopen error".' },
        libPaths: { type: 'array', items: { type: 'string' }, description: 'Shortcut for env.LD_LIBRARY_PATH: directory holding the case libraries (e.g. ~/OpenFOAM/-14/platforms/linux64GccDPInt32Opt/lib).' },
      },
      required: ['casePath', 'field'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const field = String(args.field || '').trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return { ok: false, error: 'invalid field name: ' + args.field }
      const region = args.region ? String(args.region) : ''
      const processors = processorIds(dir)
      const parallel = args.parallel === undefined ? processors.length > 0 : Boolean(args.parallel) && processors.length > 0
      // Preferred: the written field files. No utility, no physics, no writes.
      const native = readFieldStats(dir, {
        field,
        time: args.time != null && String(args.time).trim() !== '' ? String(args.time) : null,
        region,
        processors: parallel ? processors : [],
      })
      // Two times: report the change, not a single range.
      if (args.time2 != null && String(args.time2).trim() !== '') {
        const shape = (read) => {
          const scalar = read.component === 1
          return scalar ? { min: read.stats.min, max: read.stats.max } : { magnitude: read.stats.magnitudes, components: read.stats.components }
        }
        const from = readFieldStats(dir, { field, time: args.time != null && String(args.time).trim() !== '' ? String(args.time) : null, region, processors: parallel ? processors : [] })
        const to = readFieldStats(dir, { field, time: String(args.time2), region, processors: parallel ? processors : [] })
        const bad = [from, to].find((r) => !r.ok)
        if (bad) {
          return {
            ok: false,
            error: `cannot compare ${field}: ${bad.error}`,
            hint: bad.binary
              ? 'the field files are written in binary format; set `writeFormat ascii` to compare two steps'
              : `times ${args.time != null ? args.time : 'latest'} and ${args.time2} must both carry ${field}${region ? ` in region ${region}` : ''}`,
            ...(from.ok ? { from: { time: from.time, ...shape(from) } } : {}),
            ...(to.ok ? { to: { time: to.time, ...shape(to) } } : {}),
          }
        }
        const a = shape(from)
        const b = shape(to)
        const change = (x, y) => (typeof x === 'number' && typeof y === 'number' ? Number((y - x).toPrecision(6)) : undefined)
        return {
          ok: true,
          field,
          ...(region ? { region } : {}),
          compare: {
            from: { time: from.time, ...a },
            to: { time: to.time, ...b },
            change: { min: change(a.min, b.min), max: change(a.max, b.max), ...(a.magnitude ? { maxMagnitude: change(a.magnitude.max, b.magnitude.max) } : {}) },
          },
          source: to.source,
          read: 'field file',
        }
      }
      if (native.ok) {
        const st = native.stats
        const scalar = native.component === 1
        return {
          ok: true,
          field,
          ...(region ? { region } : {}),
          time: native.time,
          source: native.source,
          kind: native.kind,
          ...(st.cells ? { cells: st.cells } : {}),
          ...(scalar ? { min: st.min, max: st.max } : { magnitude: st.magnitudes, components: st.components }),
          ...(native.missingProcessors ? { missingProcessors: native.missingProcessors } : {}),
          read: 'field file',
        }
      }
      const bash = bashrcFor(cfg, args.distribution)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const caseEnv = foamEnv({ env: args.env, libPaths: args.libPaths })
      if (!caseEnv.ok) return { ok: false, error: caseEnv.error, hint: caseEnv.hint }
      const dist = String(args.distribution || cfg.defaultDistribution || '')
      const utility = /^(v\d|com)/i.test(dist) ? 'postProcess' : 'foamPostProcess'
      const time = args.time != null && String(args.time).trim() !== '' ? ['-time', String(args.time)] : ['-latestTime']
      const regionArgs = region ? ['-region', region] : []
      const parse = (text) => {
        const out = {}
        for (const line of String(text).split('\n')) {
          const m = /(?:min|max)\(all\) of \w+ = (?:\(([^)]*)\)|([-\d.eE+]+))/.exec(line)
          if (!m) continue
          const raw = m[1] !== undefined ? m[1].trim().split(/\s+/) : m[2]
          const nums = Array.isArray(raw) ? raw.map(Number) : [Number(raw)]
          if (!nums.every((n) => Number.isFinite(n))) continue
          out[line.includes('min(') ? 'min' : 'max'] = nums.length === 1 ? nums[0] : nums
        }
        return out
      }
      const runOne = async (fn) => {
        const r = await runFoam([utility, ...regionArgs, '-func', `${fn}(${field})`, ...time], { bashrc: bash, dir, timeoutMs: 120000, env: args.env, libPaths: args.libPaths })
        return { ok: r.ok, text: (r.stdout || '') + (r.stderr || '') }
      }
      const lo = await runOne('cellMin')
      const hi = await runOne('cellMax')
      const min = parse(lo.text).min
      const max = parse(hi.text).max
      if (min === undefined && max === undefined) {
        const dlopen = /dlopen error|cannot open shared object file/i.test(lo.text + hi.text)
        const why = native.binary
          ? `the field files are written in binary format, so they cannot be read directly and the utility had to run; enable \`writeFormat ascii\` (or keep the case writable, the utility writes postProcessing/)`
          : native.missing
            ? `no written time carries ${field}${region ? ` in region ${region}` : ''}: run the solver until it writes one, or check the field name with openfoam_inspect_case`
            : `${native.error}; the utility was ${utility}`
        return {
          ok: false,
          error: `no statistics parsed for ${field}`,
          hint: dlopen
            ? 'the utility could not load a library of the case: pass libPaths (or env.LD_LIBRARY_PATH) with the directory those .so files were built into; openfoam_check reports unresolved libs at system/controlDict'
            : why,
          ...(caseEnv.libPaths ? { libPaths: caseEnv.libPaths } : {}),
          logTail: (lo.text + '\n' + hi.text).slice(-1500),
        }
      }
      const mag = await runOne('cellMaxMag')
      const maxMag = parse(mag.text).max
      return {
        ok: true,
        field,
        ...(args.region ? { region: String(args.region) } : {}),
        time: time[1] || 'latest',
        min,
        max,
        ...(maxMag !== undefined ? { maxMagnitude: maxMag } : {}),
        utility,
        read: 'post-processing utility',
      }
    },
  },
  // --- tool: rewrite 0/ fields for a new mesh ---
  {
    name: 'openfoam_fields_from_template',
    description: 'Write the 0/ field files for a case whose mesh changed, taking class, dimensions and boundary conditions from a reference case and setting each internalField to ONE uniform value. This is the answer to the failure that otherwise goes unnoticed: the old 0/ file holds one value per cell of the old mesh (a 8352-value list), so the solver either refuses to start on the new mesh or, with mapFields, maps values by index and silently gives the wrong physics. A field that cannot be one value is reported as needsValue with the most frequent old entry as a suggestion — the tool never invents a physical value. Preview by default; `write:true` rewrites the files (a .bak of each is kept).',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        template: { type: 'string', description: 'Reference case whose 0/ files supply the class, dimensions and boundaryField; default: the case itself (turn its own per-cell lists into uniform values).' },
        region: { type: 'string', description: 'Region of a multi-region case: its files are 0/<region>/<field>.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Only these fields; default: every field in the template 0/.' },
        values: { type: 'object', additionalProperties: { type: 'string' }, description: 'The uniform internal value per field, e.g. {"T":"300","U":"(0 0 0)"}. A vector field needs its three components.' },
        write: { type: 'boolean', description: 'Default false: only report the plan. true rewrites the files in 0/.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const template = args.template ? resolveCase(cfg, args.template) : dir
      if (!template || !existsSync(template)) {
        return { ok: false, error: 'template case not found: ' + (args.template || dir), hint: 'pass template with an existing case directory, or drop it to use the case itself' }
      }
      const region = args.region ? String(args.region) : ''
      const values = args.values && typeof args.values === 'object' ? args.values : {}
      const plan = templatePlan({ caseDir: dir, templateDir: template, region, fields: Array.isArray(args.fields) ? args.fields : null, values })
      if (plan.error) {
        const regions = caseRegions(template)
        return {
          ok: false,
          error: plan.error,
          hint: regions.length ? `this case is multi-region: pass region: "${regions[0]}" (fields are 0/<region>/<field>)` : 'the template case has no 0/ field files to copy',
        }
      }
      const shallWrite = args.write === true || (args.write === undefined && String(cfg.writeMode || 'impact') === 'apply')
      if (!shallWrite) {
        return {
          ...plan,
          write: false,
          hint: plan.canWrite
            ? `preview only: pass write:true to rewrite ${plan.fields.filter((f) => f.value !== f.current).length} file(s) in ${join(dir, '0', region)}`
            : plan.hint,
        }
      }
      const applied = applyPlan(plan, { backup: true })
      return {
        ...plan,
        ...applied,
        write: true,
        hint: applied.ok ? 'run openfoam_check and then openfoam_field_stats to confirm the new values' : applied.error,
      }
    },
  },
  // --- tool: setFieldsDict + setFields ---
  {
    name: 'openfoam_set_fields',
    description: 'Write system/[<region>/]setFieldsDict and optionally run setFields: the supported way to give a region a starting composition, a hot spot, a seeded droplet or a second phase. Zones are boxes, spheres, cylinders or cell sets, each with its own field values; `defaultValues` sets the whole mesh first. Every field is checked to exist in 0/ and to carry the right number of components before anything is written, because setFields can only set fields that already exist. Preview by default; `write:true` writes the dictionary, `run:true` also executes setFields (which rewrites 0/).',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        region: { type: 'string', description: 'Region of a multi-region case: the dictionary goes to system/<region>/setFieldsDict and setFields runs with -region.' },
        defaultValues: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field values for the whole mesh first, e.g. {"T":"300","CH4":"0.0338"}.' },
        zones: {
          type: 'array',
          description: 'Zones to set, in order. Each needs values and a geometry: box {min:[x,y,z],max:[x,y,z]}, sphere {origin:[x,y,z],radius}, cylinder {point1,point2,radius}, set (a cellSet name), or params with an explicit type.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Zone name (default zone0, zone1, …).' },
              type: { type: 'string', description: 'box | sphere | cylinder | set | annulus | hemisphere | truncatedCone | insideSurface | dictionary. Default: inferred from the geometry.' },
              box: { type: 'object', properties: { min: { type: 'array', items: { type: 'number' } }, max: { type: 'array', items: { type: 'number' } } } },
              sphere: { type: 'object', properties: { origin: { type: 'array', items: { type: 'number' } }, radius: { type: 'number' } } },
              cylinder: { type: 'object', properties: { point1: { type: 'array', items: { type: 'number' } }, point2: { type: 'array', items: { type: 'number' } }, radius: { type: 'number' } } },
              set: { type: 'string', description: 'Name of an existing cellSet (constant/polyMesh/sets or topoSet).' },
              params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Raw zone keys written verbatim, e.g. {"box":"(0 0 0) (1 1 1)"}.' },
              values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Field values inside the zone.' },
            },
            required: ['values'],
          },
        },
        extrapolatePatches: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Per patch-regex list of fields to extrapolate to the boundary, e.g. {"inlet|outlet": ["alpha.water"]}.' },
        write: { type: 'boolean', description: 'Default false: only show the dictionary. true writes system/[<region>/]setFieldsDict.' },
        run: { type: 'boolean', description: 'Also run setFields (needs write:true). It rewrites the 0/ time directory.' },
        distribution: { type: 'string', description: 'org | com — which OpenFOAM to run setFields with; default: the configured one.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const shallWrite = args.write === true || (args.write === undefined && String(cfg.writeMode || 'impact') === 'apply')
      if (args.run === true && !shallWrite) {
        return { ok: false, error: 'run:true needs write:true', hint: 'setFields runs the dictionary in system/, so it has to be written first' }
      }
      const region = args.region ? String(args.region) : ''
      const defaultValues = args.defaultValues && typeof args.defaultValues === 'object' ? args.defaultValues : {}
      const zonesIn = Array.isArray(args.zones) ? args.zones : []
      if (!Object.keys(defaultValues).length && !zonesIn.length) {
        return { ok: false, error: 'nothing to set', hint: 'pass defaultValues (whole mesh) or zones (box/sphere/cylinder/set with values)' }
      }
      const available = zeroFields(dir, { region }).map((f) => f.name)
      if (!available.length) {
        return { ok: false, error: `no field files under ${join(dir, '0', region)}`, hint: 'setFields can only set fields that already exist: create them first with openfoam_fields_from_template or copy a 0/ from a reference case' }
      }
      const zones = []
      const problems = []
      zonesIn.forEach((zone, i) => {
        const normalised = normaliseZone(zone, i)
        if (normalised.error) {
          problems.push({ zone: (zone && zone.name) || `zone${i}`, error: normalised.error })
          return
        }
        zones.push(normalised)
      })
      for (const [where, values] of [['defaultValues', defaultValues], ...zones.map((z) => [`zone ${z.name}`, z.values])]) {
        for (const [field, value] of Object.entries(values)) {
          const known = available.includes(field)
          if (!known) {
            problems.push({ field, where, error: `no 0/${region ? region + '/' : ''}${field} field`, available })
            continue
          }
          const info = describeField(dir, region, field)
          const check = checkValueForClass(info ? info.cls : 'volScalarField', value)
          if (!check.ok) problems.push({ field, where, error: check.error })
        }
      }
      const bounds = (() => {
        try {
          return meshBounds(dir, region)
        } catch {
          return null
        }
      })()
      const warnings = []
      for (const zone of zones) {
        if (zone.params.box && bounds) {
          const [minRaw, maxRaw] = zone.params.box.split(') (')
          const min = minRaw.replace(/[()]/g, '').trim().split(/\s+/).map(Number)
          const max = maxRaw.replace(/[()]/g, '').trim().split(/\s+/).map(Number)
          const overlap = boxOverlapsMesh({ min, max }, bounds)
          if (!overlap.ok) warnings.push({ zone: zone.name, warning: overlap.error + ' — setFields would set nothing there' })
        }
      }
      if (problems.length) return { ok: false, error: `${problems.length} problem(s) in the values`, problems, available }
      const text = setFieldsDictText({ defaultValues, zones, extrapolatePatches: args.extrapolatePatches || {} })
      const rel = join('system', region, 'setFieldsDict')
      const path = join(dir, rel)
      if (!shallWrite) {
        return {
          ok: true,
          path: rel,
          region: region || null,
          zones: zones.map((z) => ({ name: z.name, type: z.type, values: z.values })),
          dict: text,
          ...(warnings.length ? { warnings } : {}),
          write: false,
          hint: 'preview only: pass write:true to write system/' + (region ? region + '/' : '') + 'setFieldsDict, then run:true to execute setFields',
        }
      }
      mkdirSync(join(dir, 'system', region), { recursive: true })
      if (existsSync(path)) copyFileSync(path, path + '.bak')
      writeFileSync(path, text)
      const out = {
        ok: true,
        path: rel,
        region: region || null,
        zones: zones.map((z) => ({ name: z.name, type: z.type, values: z.values })),
        ...(warnings.length ? { warnings } : {}),
        write: true,
        bytes: text.length,
      }
      if (args.run !== true) return { ...out, hint: 'setFields has not been run yet: call again with run:true (or run openfoam_run command "setFields' + (region ? ` -region ${region}` : '') + '" yourself)' }
      const bash = bashrcFor(cfg, args.distribution)
      if (!bash || !existsSync(bash)) return { ...out, ok: false, error: 'bashrc/foamRoot not configured, the dictionary was written but setFields did not run' }
      const argv = ['setFields', ...(region ? ['-region', region] : [])]
      const r = await runFoam(argv, { bashrc: bash, dir, timeoutMs: 120000 })
      const textOutLog = (r.stdout || '') + (r.stderr || '')
      const zoneLines = textOutLog.split('\n').filter((l) => /^Zone:|Setting field|Set |of cells|Time =|error|FATAL/i.test(l)).slice(-12)
      return {
        ...out,
        ran: r.ok,
        ...(r.ok ? {} : { error: 'setFields failed', logTail: textOutLog.slice(-1500) }),
        output: zoneLines,
        hint: r.ok ? 'confirm the effect with openfoam_field_stats (it compares two times with time2) and then re-run check' : undefined,
      }
    },
  },
  // --- tool: flow check (does the case move fluid?) ---
  {
    name: 'openfoam_flow_check',
    description: 'Answer "is the case actually moving fluid?" by summing the boundary flux `phi` on every patch and comparing it with what each velocity boundary condition intends. Catches the failure no residual or convergence check can see: an inlet whose velocity points along the empty axis of a 2D mesh, or any inlet that carries no flux, while continuity stays trivially satisfied and the run reaches "End" looking healthy. Read-only: the flux is parsed out of the written `phi` field files, so no post-processing utility runs and no `postProcessing/` directory is written; needs a written time step that carries `phi`.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        region: { type: 'string', description: 'Region to check; default: every region of a multi-region case, otherwise the single mesh.' },
        time: { type: 'string', description: 'Time value; default: the latest written time that carries phi.' },
        parallel: { type: 'boolean', description: 'Sum over processor* directories; default: on when they exist.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      const processors = processorIds(dir)
      const parallel = args.parallel === undefined ? processors.length > 0 : Boolean(args.parallel) && processors.length > 0
      const declared = caseRegions(dir)
      const regions = args.region ? [String(args.region)] : declared.length ? declared : ['']
      const comp = fieldFiles(dir, regions[0]).includes('rho')

      const perRegion = {}
      const findings = []
      const skipped = []
      for (const region of regions) {
        const key = region || 'default'
        const boundaryText = readText(join(dir, region ? `constant/${region}/polyMesh/boundary` : 'constant/polyMesh/boundary'))
        const patches = boundaryText ? parseBoundaryPatches(boundaryText) : []
        if (!patches.length) {
          skipped.push({ region: key, reason: 'no mesh: constant/polyMesh/boundary is missing or unreadable' })
          continue
        }
        const time =
          args.time != null && String(args.time).trim() !== ''
            ? String(args.time)
            : latestFluxTime(dir, region, { processor: parallel ? processors[0] : null })
        if (!time) {
          skipped.push({ region: key, reason: 'no written time carries phi — run the solver (or wait for a write) first' })
          continue
        }
        const read = readPatchFlux(dir, {
          time,
          region,
          patches,
          processors: parallel ? processors : [],
        })
        if (read.error) {
          skipped.push({ region: key, reason: read.error, time })
          continue
        }
        const areas = patchAreas(dir, patches, region)
        const udict = readCaseDict(dir, '0/U', region)
        const uRaw = (udict && udict.boundaryField && typeof udict.boundaryField === 'object' && udict.boundaryField) || {}
        const uBoundary = {}
        for (const [name, bc] of Object.entries(uRaw)) {
          if (!bc || typeof bc !== 'object') continue
          uBoundary[name] = { type: bc.type, value: vectorValue(bc.value) }
        }
        const rows = patches
          .map((p) => ({
            patch: p.name,
            area: areas ? areas.get(p.name) ?? null : null,
            flux: read.fluxes.get(p.name) ?? 0,
          }))
          .filter((r) => r.flux != null)
        const bounds = meshBounds(dir, region)
        const hasEmpty = patches.some((p) => p.type === 'empty')
        const flatAxis = bounds ? flatAxisOf([0, 1, 2].map((k) => bounds.max[k] - bounds.min[k]), hasEmpty) : null
        const meshTypes = Object.fromEntries(patches.map((p) => [p.name, p.type]))
        const verdict = analyseFlow({ patches: rows, uBoundary, meshTypes, flatAxis, incompressible: !comp })
        perRegion[key] = {
          time,
          source: parallel ? `${read.processors} processor*/${time}${region ? `/${region}` : ''}/phi` : `${time}${region ? `/${region}` : ''}/phi`,
          patches: verdict.rows,
          totals: verdict.totals,
          ...(areas ? {} : { areaNote: 'patch areas unavailable: the polyMesh is binary, too large or written by a different tool, so meanNormalVelocity is null' }),
        }
        for (const f of verdict.findings) findings.push({ ...f, region: key })
      }

      if (!Object.keys(perRegion).length) {
        return {
          ok: false,
          error: 'no region could be checked',
          skipped,
          hint: 'a flux needs a written time step with phi: run the solver until it writes one, then repeat; openfoam_solve_verify shows the current time',
        }
      }
      const errors = findings.filter((f) => f.severity === 'error')
      return {
        ok: errors.length === 0,
        regions: perRegion,
        findings,
        ...(skipped.length ? { skipped } : {}),
        ...(errors.length
          ? { verdict: `${errors.length} blocking flow problem(s): ${errors.map((e) => e.title).join('; ')}` }
          : { verdict: 'the boundaries carry flux the way their conditions intend' }),
      }
    },
  },
  // --- tool: clean run artefacts ---
  {
    name: 'openfoam_clean',
    description: 'List (dry run by default) or delete run artefacts: log files, numeric time directories, processor* decomposition, postProcessing/, VTK output and the .openfoam-runs registry of asynchronous runs. Never touches 0/, constant/ or system/. Use this INSTEAD of rm -rf, and dry-run first.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        what: { type: 'array', items: { type: 'string', description: 'logs | timeDirs | processorDirs | postProcessing | vtk | runs' }, description: 'Default: logs + timeDirs.' },
        keepTimes: { type: 'array', items: { type: 'string' }, description: 'Time directory names to keep (e.g. the latest).' },
        dryRun: { type: 'boolean', description: 'Default true: only report what would be removed.' },
        force: { type: 'boolean', description: 'Clean even when the directory does not look like an OpenFOAM case.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      // Only clean something that looks like an OpenFOAM case: a random project
      // folder must not lose its build.log and a directory named "2024".
      const markers = ['system/controlDict', 'constant/polyMesh', 'system/blockMeshDict'].filter((rel) => existsSync(join(dir, rel)))
      const regionMeshes = (() => { try { return caseRegions(dir).length > 0 } catch { return false } })()
      if (!markers.length && !regionMeshes && args.force !== true) {
        return {
          ok: false,
          error: 'not an OpenFOAM case: no system/controlDict, system/blockMeshDict or constant/polyMesh',
          path: dir,
          note: 'cleaning is refused so an arbitrary directory cannot lose files that merely look like logs or time directories',
          hint: 'pass force:true only if you really mean to clean this directory, or use rm deliberately',
        }
      }
      if (!markers.length && !regionMeshes && args.force === true) {
        // force overrides the case-marker guard: it is a destructive decision and
        // needs the same approval as a critical dictionary edit.
        const service = typeof getApproval === 'function' ? getApproval() : undefined
        const asked = await requestApproval({ approval: service, exec, toolName: 'openfoam_clean', reason: `clean ${dir} even though it is not an OpenFOAM case (force:true)` })
        if (!asked.ok) {
          return {
            ok: false,
            error: asked.error,
            path: dir,
            approval: { outcome: asked.outcome || 'unavailable', hasService: Boolean(service && typeof service.request === 'function'), hasAgent: Boolean(exec?.agent), hasCallId: Boolean(exec?.callId) },
            hint: 'clean with force:true deletes files in a directory that does not look like a case; approve it explicitly',
          }
        }
      }
      const what = Array.isArray(args.what) && args.what.length ? args.what.map(String) : ['logs', 'timeDirs']
      const keep = new Set((Array.isArray(args.keepTimes) ? args.keepTimes : []).map(String))
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch {}
      const candidates = []
      for (const w of what) {
        if (w === 'logs') {
          for (const e of entries) {
            if (!e.isFile()) continue
            if (!(/^log([._]|$)/i.test(e.name) || /\.log$/i.test(e.name))) continue
            candidates.push({ kind: 'log', rel: e.name })
          }
        } else if (w === 'timeDirs') {
          for (const e of entries) {
            if (!e.isDirectory() || !/^\d+([.eE][-+]?\d+)?$/.test(e.name)) continue
            if (e.name === '0' || keep.has(e.name)) continue
            candidates.push({ kind: 'timeDir', rel: e.name })
          }
        } else if (w === 'processorDirs') {
          for (const e of entries) {
            if (e.isDirectory() && /^processor\d+$/.test(e.name)) candidates.push({ kind: 'processorDir', rel: e.name })
          }
        } else if (w === 'postProcessing') {
          if (existsSync(join(dir, 'postProcessing'))) candidates.push({ kind: 'postProcessing', rel: 'postProcessing' })
        } else if (w === 'vtk') {
          // foamToVTK writes VTK/ (or vtks/ with a fileHandler); both are pure
          // conversion output and safe to drop.
          for (const name of ['VTK', 'vtk', 'vtks']) {
            if (existsSync(join(dir, name))) candidates.push({ kind: 'vtk', rel: name })
          }
        } else if (w === 'runs') {
          // the registry of asynchronous runs started by openfoam_run_solver_async
          // (log + status per run) lives in <case>/.openfoam-runs
          if (existsSync(join(dir, '.openfoam-runs'))) candidates.push({ kind: 'runs', rel: '.openfoam-runs' })
        }
      }
      let totalBytes = 0
      for (const c of candidates) {
        const full = join(dir, c.rel)
        try {
          const st = statSync(full)
          c.bytes = st.isDirectory() ? dirSize(full) : st.size
          totalBytes += c.bytes
        } catch { c.bytes = null }
      }
      const dryRun = args.dryRun !== false
      if (!dryRun) {
        for (const c of candidates) {
          try { rmSync(join(dir, c.rel), { recursive: true, force: true }) } catch (e) { c.error = String((e && e.message) || e) }
        }
      }
      return {
        ok: true,
        dryRun,
        casePath: dir,
        what,
        count: candidates.length,
        totalBytes,
        totalHuman: `${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
        removed: dryRun ? null : candidates.map((c) => c.rel),
        candidates,
        hint: dryRun ? 'dry run: nothing was deleted; call again with dryRun:false to remove the listed paths' : null,
      }
    },
  },
  // --- tool: scaffold an incompressible laminar case from scratch ---
  {
    name: 'openfoam_case_scaffold',
    description: 'Write the dictionaries a fresh case needs (controlDict, fvSchemes, fvSolution, constant/*, 0/U, 0/p) for incompressible LAMINAR flow, using the case own patches for the boundary conditions. Distribution-aware: org uses application foamRun + solver incompressibleFluid with momentumTransport/physicalProperties; com uses application simpleFoam with turbulenceProperties/transportProperties. With no mesh yet it falls back to the inlet/outlet/walls set that mesh_plan creates; it then runs the doctor and returns its findings. It writes dictionaries and 0/ fields but NO geometry (no blockMeshDict) - build the mesh with openfoam_mesh_plan or your own blockMeshDict. For a multi-region conjugate-heat-transfer case use family="cht" on a case whose regions already exist (blockMesh -> createZones -> splitMeshRegions): it writes per-region dictionaries, regionSolvers/regionProperties by distribution, coupled boundary conditions on the <region>_to_<other> interface patches and a root fvSolution. Use clone_tutorial for turbulent or compressible cases.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string', description: 'Case directory; created when it does not exist.' },
        distribution: { type: 'string', description: 'org | com (default: defaultDistribution or org).' },
        algorithm: { type: 'string', description: 'SIMPLE (steady, default) or PIMPLE (transient).' },
        turbulence: { type: 'string', description: 'Only laminar in this version.' },
        family: { type: 'string', description: 'incompressible (default) | compressible (rho-thermo, family-aware) | cht (multi-region conjugate heat transfer, requires region meshes).' },
        regions: { type: 'array', description: 'For family=cht: [{name, kind:"fluid"|"solid"}] for the existing region meshes; inferred from names when omitted.', items: { type: 'object' } },
        Uinlet: { type: 'number', description: 'For family=cht: inlet velocity magnitude (m/s), default 5.' },
        Tinlet: { type: 'number', description: 'For family=cht: gas inlet temperature (K), default 500.' },
        Tsolid: { type: 'number', description: 'For family=cht: initial solid temperature (K), default 300.' },
        solid: { type: 'object', description: 'For family=cht: {rho, Cv, kappa} of the solid material; small Cv heats fast.', additionalProperties: true },
        U: { type: 'array', items: { type: 'number' }, description: 'Inlet velocity vector (default (1 0 0)).' },
        p: { type: 'number', description: 'Outlet pressure (default 0).' },
        nu: { type: 'number', description: 'Kinematic viscosity (default 1e-5).' },
        endTime: { type: 'number' },
        deltaT: { type: 'number' },
        writeInterval: { type: 'number' },
        patches: { type: 'array', description: 'Patch names (or {name,type} objects) when no polyMesh exists yet.' },
        force: { type: 'boolean', description: 'Overwrite existing dictionaries.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const requested = String(args.casePath || '').trim()
      if (!requested) return { ok: false, error: 'casePath is required' }
      const dir = resolveCase(cfg, requested)
      if (!dir) return { ok: false, error: 'casePath is required' }
      const family = String(args.family || 'incompressible').toLowerCase()
      if (family === 'compressible') {
        const capsC = await probeCaps(bashrcFor(cfg, args.distribution), args.distribution || cfg.defaultDistribution)
        let patches = Array.isArray(args.patches) && args.patches.length
          ? args.patches.map((p) => (p && typeof p === 'object' ? { name: String(p.name || ''), type: String(p.type || 'patch') } : { name: String(p), type: 'patch' }))
          : parseBoundaryPatches(readText(join(dir, 'constant', 'polyMesh', 'boundary')) || '').map((p) => ({ name: p.name, type: p.type }))
        if (!patches.length) patches = [{ name: 'inlet', type: 'patch' }, { name: 'outlet', type: 'patch' }, { name: 'walls', type: 'wall' }]
        const planC = scaffoldCompressible({
          caps: capsC,
          patches,
          Uinlet: Number(args.Uinlet) > 0 ? Number(args.Uinlet) : 10,
          Tinlet: Number(args.Tinlet) > 0 ? Number(args.Tinlet) : 300,
          pInitial: Number(args.p) > 0 ? Number(args.p) : 1e5,
          endTime: args.endTime,
          deltaT: args.deltaT,
          writeInterval: args.writeInterval,
        })
        const createdC = []
        const skippedC = []
        for (const [rel, body] of Object.entries(planC.files)) {
          const file = join(dir, rel)
          if (existsSync(file) && !args.force) { skippedC.push(rel); continue }
          mkdirSync(join(file, '..'), { recursive: true })
          writeFileSync(file, body)
          createdC.push(rel)
        }
        writeFileSync(join(dir, 'case-manifest.json'), JSON.stringify({ family: 'compressible', distribution: capsC.family, createdAt: new Date().toISOString() }, null, 2) + '\n')
        createdC.push('case-manifest.json')
        const findingsC = checkCaseEngine(dir)
        return {
          ok: true,
          casePath: dir,
          family: 'compressible',
          distribution: capsC.family,
          caps: { summary: capsSummary(capsC), support: capsC.support, modular: capsC.modular },
          application: planC.files['system/controlDict'].match(/application\s+(\w+);/)[1],
          created: createdC,
          skipped: skippedC,
          warnings: planC.warnings,
          notes: planC.notes,
          findings: findingsC.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title })),
          next: ['openfoam_check', 'openfoam_run_solver_async', 'openfoam_solve_verify', 'openfoam_field_stats'],
        }
      }
      if (family === 'cht') {
        const regionNames = caseRegions(dir)
        if (!regionNames.length) {
          return {
            ok: false,
            error: 'family=cht needs region meshes: no constant/<region>/polyMesh in this case',
            hint: 'build one mesh, create a cell zone for the solid, then split: blockMesh -> createZones -> splitMeshRegions -cellZones all -defaultRegion fluid',
            regions: regionNames,
          }
        }
        const requested = Array.isArray(args.regions) ? args.regions : []
        const inferred = requested.length
          ? requested
          : regionNames.map((name) => ({ name, kind: /solid|body|metal|wall|rod|sphere/i.test(name) ? 'solid' : 'fluid' }))
        const kinds = inferred.filter((r) => regionNames.includes(r.name))
        if (!kinds.some((r) => r.kind === 'fluid') || !kinds.some((r) => r.kind === 'solid')) {
          return {
            ok: false,
            error: 'family=cht needs at least one fluid and one solid region',
            regions: regionNames,
            hint: 'pass regions: [{name:"fluid", kind:"fluid"}, {name:"solid", kind:"solid"}]',
          }
        }
        const withPatches = kinds.map((r) => ({
          ...r,
          patches: parseBoundaryPatches(readText(join(dir, 'constant', r.name, 'polyMesh', 'boundary')) || ''),
        }))
        const capsCht = await probeCaps(bashrcFor(cfg, args.distribution), args.distribution || cfg.defaultDistribution)
        const Uinlet = Number(args.Uinlet) > 0 ? Number(args.Uinlet) : 5
        const plan = scaffoldCht({
          caps: capsCht,
          regions: withPatches,
          Uinlet,
          Tinlet: Number(args.Tinlet) > 0 ? Number(args.Tinlet) : 500,
          Tsolid: Number(args.Tsolid) > 0 ? Number(args.Tsolid) : 300,
          pInitial: Number(args.p) > 0 ? Number(args.p) : 1e5,
          solid: args.solid && typeof args.solid === 'object' ? args.solid : undefined,
          endTime: args.endTime,
          deltaT: args.deltaT,
          writeInterval: args.writeInterval,
        })
        if (!plan.ok) return plan
        const createdCht = []
        const skippedCht = []
        for (const [rel, body] of Object.entries(plan.files)) {
          const file = join(dir, rel)
          if (existsSync(file) && !args.force) { skippedCht.push(rel); continue }
          mkdirSync(join(file, '..'), { recursive: true })
          writeFileSync(file, body)
          createdCht.push(rel)
        }
        const manifest = {
          family: 'cht',
          distribution: capsCht.family,
          regions: plan.regions,
          createdAt: new Date().toISOString(),
        }
        writeFileSync(join(dir, 'case-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
        createdCht.push('case-manifest.json')
        const findingsCht = checkCaseEngine(dir, { regions: regionNames })
        return {
          ok: true,
          casePath: dir,
          family: 'cht',
          distribution: capsCht.family,
          caps: { summary: capsSummary(capsCht), support: capsCht.support, modular: capsCht.modular },
          regions: plan.regions,
          created: createdCht,
          skipped: skippedCht,
          warnings: plan.warnings,
          notes: plan.notes,
          findings: findingsCht.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title })),
          next: [
            'openfoam_check, then openfoam_run_solver_async (org: foamMultiRun; com: chtMultiRegionFoam)',
            'openfoam_field_stats with region="<solid>" to watch the solid heat up',
          ],
        }
      }
      if (family !== 'incompressible') {
        return {
          ok: false,
          error: `this version scaffolds incompressible laminar or CHT cases (family="${args.family}")`,
          hint: 'for compressible flow copy the nearest tutorial: openfoam_find_tutorial + openfoam_clone_tutorial (org: fluid/aerofoilNACA0012, com: compressible/rhoPimpleFoam/...)',
        }
      }
      if (args.turbulence && !/^laminar$/i.test(String(args.turbulence))) {
        return {
          ok: false,
          error: `v1 scaffolds laminar incompressible cases only (got turbulence="${args.turbulence}")`,
          hint: 'use openfoam_find_tutorial + openfoam_clone_tutorial for turbulent, compressible or CHT cases (kOmegaSST, compressibleVoF, multiRegion)',
        }
      }
      const distribution = String(args.distribution || cfg.defaultDistribution || 'org')
      const kind = distributionKind(distribution)

      let patches = []
      const boundary = readText(join(dir, 'constant', 'polyMesh', 'boundary'))
      if (boundary) patches = parseBoundaryPatches(boundary).map((p) => ({ name: p.name, type: p.type }))
      if (!patches.length && Array.isArray(args.patches) && args.patches.length) {
        patches = args.patches.map((p) => (p && typeof p === 'object'
          ? { name: String(p.name || ''), type: String(p.type || 'patch') }
          : { name: String(p), type: 'patch' }))
      }
      if (!patches.length) {
        patches = [
          { name: 'inlet', type: 'patch' },
          { name: 'outlet', type: 'patch' },
          { name: 'walls', type: 'wall' },
        ]
      }

      const caps = await probeCaps(bashrcFor(cfg, distribution), distribution)
      const plan = scaffoldFiles({
        distribution,
        caps,
        patches,
        algorithm: String(args.algorithm || 'SIMPLE'),
        U: args.U,
        p: args.p,
        nu: Number(args.nu) || 1e-5,
        endTime: args.endTime,
        deltaT: args.deltaT,
        writeInterval: args.writeInterval,
      })

      mkdirSync(dir, { recursive: true })
      const created = []
      const skipped = []
      for (const [rel, body] of Object.entries(plan.files)) {
        const file = join(dir, rel)
        if (existsSync(file) && !args.force) { skipped.push(rel); continue }
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, body)
        created.push(rel)
      }

      const foam = ensureFoamFile(dir)
      // case-manifest.json lets mesh tools read the setup instead of guessing it
      const manifest = {
        schema: 'openfoam-workbench/case-manifest@1',
        application: plan.application,
        algorithm: plan.transient ? 'PIMPLE' : 'SIMPLE',
        distribution: kind,
        compressible: false,
        phases: 1,
        turbulence: 'laminar',
        patches: plan.patchRoles.map((r) => ({ name: r.name, type: r.type, role: r.role })),
        createdAt: new Date().toISOString(),
      }
      const manifestPath = join(dir, 'case-manifest.json')
      if (!existsSync(manifestPath) || args.force) {
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        created.push('case-manifest.json')
      }
      const findings = checkCaseEngine(dir)
      const bySeverity = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc }, {})
      return {
        ok: true,
        casePath: dir,
        distribution: kind,
        caps: { summary: capsSummary(caps), support: caps.support, family: caps.family, modular: caps.modular },
        ...(caps.support !== 'full' ? { advisory: `this OpenFOAM release is ${caps.support === 'unknown' ? 'not tested' : 'partially tested'}: review the generated ${caps.family} dictionaries before a production run` } : {}),
        application: plan.application,
        algorithm: plan.transient ? 'PIMPLE' : 'SIMPLE',
        patches: plan.patchRoles.map((r) => ({ name: r.name, type: r.type, role: r.role })),
        created,
        skipped,
        foamFile: foam.ok ? foam.name : null,
        manifest: 'case-manifest.json',
        findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, title: f.title })),
        findingCounts: bySeverity,
        warnings: plan.warnings,
        notes: plan.notes,
        next: [
          'run blockMesh (or snappyHexMesh) if the mesh does not exist yet',
          'set the real inlet velocity in 0/U and the outlet pressure level in 0/p',
          'openfoam_check, then openfoam_run_solver_async, then openfoam_solve_verify',
        ],
      }
    },
  },
  ]
}
