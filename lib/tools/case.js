import { checkCase as checkCaseEngine } from '../of-engine.js'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { caseLookupHint, dirSize, readText, resolveCase, resolveCaseInfo, run, textOut, topLevelKeys } from '../runtime.js'
import { diagnoseError } from '../knowledge.js'
import { parseBoundaryPatches } from '../of-engine.js'
import { algoCaseAudit, algoExtractContract, caseProbeFacts } from '../caselib.js'
import { checkBlockMeshDict, checkBoundaryFields, checkControlDict, checkFvSchemes, checkFvSolution, checkStrayTimes, readCaseDict } from '../of-engine.js'
import { availableDicts, caseBBox, caseRegions, containedPath, ensureFoamFile, normaliseDictPath } from '../of-case.js'
import { geometryScalePrompt } from '../needs-input.js'
import { distributionKind, scaffoldFiles } from '../scaffold.js'
import { classifyImpact, decideAction } from '../impact.js'

function hashText(text) { return createHash('sha256').update(String(text), 'utf8').digest('hex') }

const ENTRY_RE = /^[A-Za-z_][A-Za-z0-9_.:]*$/
const DANGEROUS_DIRECTIVE = /#(codeStream|calc|eval|include)\b|\bcodeStream\b/i

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
  const opens = (text.match(/{/g) || []).length
  const closes = (text.match(/}/g) || []).length
  if (opens !== closes) return { ok: false, error: 'unbalanced braces in value' }
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
    if (value === 'allowed-once') return { ok: true }
    return { ok: false, error: `approval ${value || 'unavailable'}: the change was not applied` }
  } catch (e) {
    return { ok: false, error: 'approval failed: ' + String((e && e.message) || e) }
  }
}

export default function caseTools({ cfg, getApproval }) {
  return [
  // --- tool: case doctor (silent failures, from dsh-openfoam-doctor, MIT) ---
  {
    name: 'openfoam_check',
    description: 'Audit an OpenFOAM case for the failures that do not announce themselves: steadyState paired with timeStep writes, limiter=1 (negative k/epsilon), unbounded advection, nNonOrthogonalCorrectors 0 on skewed meshes, stray time dirs, boundary mistakes. Deterministic — every finding has a fix. Run before the first solver run.',
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
      else findings = checkCaseEngine(dir, { regions: wanted })

      // Geometry-scale gate: a metre-sized box is the classic sign of a model
      // built in millimetres that was never rescaled.
      let needsInput = null
      const askAbove = Number(cfg.scaleAskAbove) || 0
      const bbox = caseBBox(dir)
      if (bbox.ok && askAbove > 0 && bbox.maxExtent > askAbove) {
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
      return {
        ok: true,
        path: dir,
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
  // --- tool: four-step step 2 ---
  {
    name: 'openfoam_case_probe_facts',
    description: 'Probe a case and return its actual facts: solver, governing family, compressibility, phases, turbulence, dimensions, patches, fields in 0/, transport. Step 2 of the four-step method.',
    parameters: {
      type: 'object',
      properties: { case_path: { type: 'string' } },
      required: ['case_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => caseProbeFacts(cfg, args),
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
    description: 'Set one top-level dictionary entry atomically (write temp + rename, .bak kept). Impact-aware: output/organisation keys in controlDict apply immediately; anything that can change physics or numerics (0/*, fvSchemes, fvSolution, constant/*, deltaT, application) is a preview unless apply:true is passed, and libs/functions require approval. Pass expect to refuse a write whose current value differs. Returns changeId for openfoam_dict_undo. Accepts multi-region paths (`fluid/fvSchemes`, `0/fluid/T`). Use this INSTEAD of sed/python.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'controlDict | fluid/fvSchemes | system/fluid/fvSchemes | 0/fluid/T' },
        entry: { type: 'string' },
        value: { type: 'string', description: 'OpenFOAM text, e.g. "0.01", "uniform (1 0 0)", "Gauss linear".' },
        region: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Force a preview (never writes).' },
        apply: { type: 'boolean', description: 'Write a high-impact change without a preview.' },
        expect: { type: 'string', description: 'Refuse unless the current value equals this.' },
        backup: { type: 'boolean', description: 'Keep <file>.bak (default true).' },
        append: { type: 'boolean', description: 'Append the entry when it does not exist at top level.' },
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
      const valid = validateEntryValue(entry, value)
      if (!valid.ok) return { ok: false, applied: false, file: found.rel, entry, ...valid }
      // A value that carries an executable directive is critical regardless of
      // the entry it is written to.
      const danger = dangerousContent(`${entry} ${value};`)
      const impact = danger.length ? 'critical' : classifyImpact(found.rel, entry, value)

      // `expect` guard: refuse to write on top of a value the caller did not see.
      if (args.expect !== undefined) {
        const current = topLevelEntryValue(text, entry)
        if (current === null) return { ok: false, error: `entry not found at top level: ${entry}`, file: found.rel, topLevelEntries: topLevelKeys(text).slice(0, 40) }
        if (String(current).trim() !== String(args.expect).trim()) {
          return { ok: false, error: `expect mismatch: expected "${args.expect}", found "${current}"`, file: found.rel, entry, found: current }
        }
      }

      const edit = replaceTopLevelEntry(text, entry, value, Boolean(args.append))
      if (!edit.ok && edit.reason === 'subdictionary') {
        return {
          ok: false,
          error: `${entry} is a sub-dictionary, not a single-line entry`,
          file: found.rel,
          impact,
          hint: 'openfoam_dict_set edits single-line top-level entries only; set a scalar key inside the block instead, or edit the block manually',
        }
      }
      if (!edit.ok) {
        return {
          ok: false,
          error: `entry not found at top level: ${entry}`,
          file: found.rel,
          topLevelEntries: topLevelKeys(text).slice(0, 40),
          hint: 'pass append:true to add it (or check that the entry is not inside a sub-dictionary)',
        }
      }
      if (edit.text === text) return { ok: true, changed: false, applied: false, impact, file: found.rel, entry, note: 'value already set' }
      // Defence in depth: an edit may only touch its own top-level entry.
      const beforeKeys = new Set(topLevelKeys(text))
      const afterKeys = new Set(topLevelKeys(edit.text))
      const extra = [...afterKeys].filter((k) => !beforeKeys.has(k) && k !== entry)
      const missing = [...beforeKeys].filter((k) => !afterKeys.has(k) && k !== entry)
      if (extra.length || missing.length) {
        return { ok: false, applied: false, error: 'the edit would change the top-level structure of the dictionary', file: found.rel, entry, extra, missing }
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
          outcome: asked.ok ? 'allowed-once' : 'refused',
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
      const edit = appended ? removeTopLevelEntry(text, rec.entry) : replaceTopLevelEntry(text, rec.entry, rec.old ?? '', false)
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
  // --- tool: clean run artefacts ---
  {
    name: 'openfoam_clean',
    description: 'List (dry run by default) or delete run artefacts: log files, numeric time directories, processor* decomposition and postProcessing/. Never touches 0/, constant/ or system/. Use this INSTEAD of rm -rf, and dry-run first.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        what: { type: 'array', items: { type: 'string', description: 'logs | timeDirs | processorDirs | postProcessing' }, description: 'Default: logs + timeDirs.' },
        keepTimes: { type: 'array', items: { type: 'string' }, description: 'Time directory names to keep (e.g. the latest).' },
        dryRun: { type: 'boolean', description: 'Default true: only report what would be removed.' },
        force: { type: 'boolean', description: 'Clean even when the directory does not look like an OpenFOAM case.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
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
    description: 'Write the dictionaries a fresh case needs (controlDict, fvSchemes, fvSolution, constant/*, 0/U, 0/p) for incompressible LAMINAR flow, using the case own patches for the boundary conditions. Distribution-aware: org uses application foamRun + solver incompressibleFluid with momentumTransport/physicalProperties; com uses application simpleFoam with turbulenceProperties/transportProperties. With no mesh yet it falls back to the inlet/outlet/walls set that mesh_plan creates; it then runs the doctor and returns its findings. It writes dictionaries and 0/ fields but NO geometry (no blockMeshDict) - build the mesh with openfoam_mesh_plan or your own blockMeshDict. Use clone_tutorial for turbulent, compressible or CHT cases.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string', description: 'Case directory; created when it does not exist.' },
        distribution: { type: 'string', description: 'org | com (default: defaultDistribution or org).' },
        algorithm: { type: 'string', description: 'SIMPLE (steady, default) or PIMPLE (transient).' },
        turbulence: { type: 'string', description: 'Only laminar in this version.' },
        U: { type: 'array', items: { type: 'number' }, description: 'Inlet velocity vector (default (1 0 0)).' },
        p: { type: 'number', description: 'Outlet pressure (default 0).' },
        nu: { type: 'number', description: 'Kinematic viscosity (default 1e-5).' },
        endTime: { type: 'number' },
        deltaT: { type: 'number' },
        writeInterval: { type: 'number' },
        patches: { type: 'array', items: { type: 'string' }, description: 'Patch names when no polyMesh exists yet.' },
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
        patches = args.patches.map((name) => ({ name: String(name), type: 'patch' }))
      }
      if (!patches.length) {
        patches = [
          { name: 'inlet', type: 'patch' },
          { name: 'outlet', type: 'patch' },
          { name: 'walls', type: 'wall' },
        ]
      }

      const plan = scaffoldFiles({
        distribution,
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
