import { checkCase as checkCaseEngine } from '../of-engine.js'
import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirSize, readText, resolveCase, run, textOut, topLevelKeys } from '../runtime.js'
import { diagnoseError } from '../knowledge.js'
import { parseBoundaryPatches } from '../of-engine.js'
import { algoCaseAudit, algoExtractContract, caseProbeFacts } from '../caselib.js'
import { checkBlockMeshDict, checkBoundaryFields, checkControlDict, checkFvSchemes, checkFvSolution, checkStrayTimes, readCaseDict } from '../of-engine.js'
import { availableDicts, caseBBox, caseRegions, normaliseDictPath } from '../of-case.js'

export default function caseTools({ cfg }) {
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
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
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
        needsInput = {
          question: `Геометрия ${extent} м. Это действительно метры, или кейс строился в миллиметрах и его забыли отмасштабировать?`,
          options: ['метры верны, продолжаем', 'миллиметры: умножить геометрию на 1e-3', 'другое (объясню)'],
        }
      }
      return {
        ok: true,
        path: dir,
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
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const found = normaliseDictPath(dir, args && args.file, args && args.region)
      if (!found.ok) {
        const available = availableDicts(dir)
        const regions = caseRegions(dir)
        const notFound = {
          ok: false,
          error: `not found: ${args.file}`,
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
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
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
  // --- tool: set a dictionary entry atomically ---
  {
    name: 'openfoam_dict_set',
    description: 'Set one top-level dictionary entry atomically (write temp + rename, .bak kept) — safe on a live runTimeModifiable case: file="controlDict", entry="writeInterval", value="0.01". Accepts multi-region paths (`fluid/fvSchemes`, `system/fluid/fvSchemes`, `0/fluid/T`). Use this INSTEAD of editing dictionaries with sed/python or restarting a solver just to change a control.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'controlDict | fluid/fvSchemes | system/fluid/fvSchemes | 0/fluid/T' },
        entry: { type: 'string' },
        value: { type: 'string', description: 'OpenFOAM text, e.g. "0.01", "uniform (1 0 0)", "Gauss linear".' },
        region: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Report the change without writing.' },
        backup: { type: 'boolean', description: 'Keep <file>.bak (default true).' },
        append: { type: 'boolean', description: 'Append the entry when it does not exist at top level.' },
      },
      required: ['casePath', 'file', 'entry', 'value'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const found = normaliseDictPath(dir, args.file, args.region)
      if (!found.ok) return { ok: false, error: 'not found: ' + args.file, tried: found.tried, available: availableDicts(dir) }
      const target = join(dir, found.rel)
      const text = readText(target)
      if (text == null) return { ok: false, error: 'cannot read: ' + found.rel }
      const entry = String(args.entry)
      const value = String(args.value)
      const re = new RegExp('^(\\s*)' + entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([^;]*);')
      const lines = text.split('\n')
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
      if (!replaced && !args.append) {
        return {
          ok: false,
          error: `entry not found at top level: ${entry}`,
          file: found.rel,
          topLevelEntries: topLevelKeys(text).slice(0, 40),
          hint: 'pass append:true to add it (or check that the entry is not inside a sub-dictionary)',
        }
      }
      if (!replaced && args.append) {
        lines.push(`${entry} ${value};`)
        lineNo = lines.length
      }
      const next = lines.join('\n')
      if (next === text) return { ok: true, changed: false, file: found.rel, entry, value, note: 'value already set' }
      if (args.dryRun) return { ok: true, dryRun: true, changed: true, file: found.rel, entry, old: oldValue, new: value, line: lineNo }
      const backup = args.backup === false ? null : target + '.bak'
      if (backup) { try { cpSync(target, backup) } catch {} }
      const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
      writeFileSync(tmp, next)
      renameSync(tmp, target)
      return { ok: true, changed: true, file: found.rel, path: target, entry, old: oldValue, new: value, backup, line: lineNo }
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
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
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
  ]
}
