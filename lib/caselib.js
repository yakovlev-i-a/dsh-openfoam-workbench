import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { readText, resolveCase, resolveSource } from './runtime.js'
import { classifySolver } from './knowledge.js'
import { caseRegions, regionFiles, regionGroups, regionSolvers } from './of-case.js'
import { parseBoundaryPatches } from './of-engine.js'

export function algoExtractContract(cfg, args) {
  const source_file = String(args.source_file || '')
  let f = ''
  if (isAbsolute(source_file)) f = source_file
  else {
    const inCase = resolveCase(cfg, source_file)
    if (existsSync(inCase)) f = inCase
    else {
      const src = resolveSource(cfg, source_file)
      if (src.ok) f = src.path
    }
  }
  if (!f || !existsSync(f)) return { ok: false, error: 'file not found: ' + source_file }
  const ext = extname(source_file).toLowerCase()
  const raw = readText(f) || ''
  const contract = {
    algorithm: args.algorithm_name || basename(source_file, ext),
    source_file,
    source_kind: ext,
    inputs: [],
    outputs: [],
    equations: [],
    governing_type: null,
    assumes: { compressible: null, phases: null, turbulence: null, dimensions: null },
    raw_notes: [],
  }
  if (ext === '.h' || ext === '.c' || ext === '.cpp' || ext === '.cxx') {
    const inherit = raw.match(/class\s+(\w+)\s*:\s*public\s+([\w:]+)/)
    if (inherit) {
      contract.raw_notes.push(`class ${inherit[1]} : public ${inherit[2]}`)
      const base = inherit[2].toLowerCase()
      if (/dragmodel/.test(base)) { contract.governing_type = 'two-phase drag (Euler-Euler)'; contract.assumes.phases = 2 }
      else if (/turbulencemodel|rasmodel|lesmodel/.test(base)) contract.governing_type = 'turbulence closure'
      else if (/phasemodel/.test(base)) { contract.governing_type = 'phase model'; contract.assumes.phases = 2 }
      else if (/fvpatchfield/.test(base)) contract.governing_type = 'boundary condition'
      else if (/fvoption/.test(base)) contract.governing_type = 'fvOption / source term'
    }
    const fnRe = /(?:virtual\s+)?(\w+(?:::\w+)*)\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*[{;]/g
    let mm
    let cnt = 0
    while ((mm = fnRe.exec(raw)) !== null && cnt < 12) {
      const [, ret, name, params] = mm
      if (/^(operator|if|for|while|switch|return)$/.test(name)) continue
      if (/^[A-Z]\w*$/.test(name) && inherit && name === inherit[1]) continue
      contract.outputs.push({ name, return_type: ret, params: params.trim().slice(0, 200) })
      cnt++
    }
    for (const line of raw.split(/\r?\n/)) {
      if (/\b(Eq\.?|Equation)\s*\(?\d/.test(line) || /^\s*\/\/\s*[A-Za-z_]+\s*=\s*/.test(line)) {
        const s = line.replace(/^\s*\/\/\s*/, '').trim()
        if (s && s.length < 200) contract.equations.push(s)
        if (contract.equations.length >= 8) break
      }
    }
  } else if (ext === '.pdf') {
    contract.raw_notes.push('the source is a PDF — read it with openfoam_read_paper, then fill inputs/outputs/equations by hand. This tool is a heuristic only.')
  } else if (ext === '.py') {
    const fnRe = /def\s+(\w+)\s*\(([^)]*)\):\s*(?:\n\s*"""([^"]+)""")?/g
    let mm
    while ((mm = fnRe.exec(raw)) !== null) {
      contract.outputs.push({ name: mm[1], params: mm[2], doc: (mm[3] || '').trim().slice(0, 200) })
      if (contract.outputs.length >= 10) break
    }
  }
  if (/compressible/i.test(raw)) contract.assumes.compressible = true
  if (/incompressible/i.test(raw)) contract.assumes.compressible = false
  if (/twoPhase|two-?phase|alpha\.water|alpha\.air/i.test(raw)) contract.assumes.phases = 2
  if (/singlePhase|single-?phase/i.test(raw)) contract.assumes.phases = 1
  for (const t of ['kEpsilon', 'kOmegaSST', 'SpalartAllmaras', 'LES', 'RAS', 'laminar']) {
    if (new RegExp(`\\b${t}\\b`).test(raw)) { contract.assumes.turbulence = t; break }
  }
  contract.note = '⚠ Heuristic extraction: outputs from function signatures, equations from comments. Verify by hand before treating it as a contract.'
  return { ok: true, ...contract }
}

// Full OpenFOAM.org 14 solver map: name -> [governing, compressible, phases]

export function caseProbeFacts(cfg, args) {
  const cd = resolveCase(cfg, args.case_path)
  if (!cd || !existsSync(cd)) return { ok: false, error: 'case not found: ' + cd }
  const facts = { case_path: args.case_path, solver: null, governing: null, compressible: null, phases: null, turbulence: null, dimensions_xyz: null, patches: [], fields_in_0: [], extras: {} }
  const cdText = readText(join(cd, 'system/controlDict'))
  if (cdText) {
    const m = cdText.match(/^\s*(?:application|solver)\s+(\w+)\s*;/m)
    if (m) {
      facts.solver = m[1]
      const cls = classifySolver(m[1])
      facts.governing = cls.governing
      facts.compressible = cls.compressible
      facts.phases = cls.phases
    }
    const lm = cdText.match(/libs\s*\(([^)]+)\)/)
    if (lm) facts.extras.libs = lm[1].trim()
  }
  for (const tf of ['constant/momentumTransport', 'constant/turbulenceProperties']) {
    const tp = readText(join(cd, tf))
    if (!tp) continue
    const mm = tp.match(/RAS\s*\{[^}]*model\s+(\w+)/) || tp.match(/LES\s*\{[^}]*model\s+(\w+)/) || tp.match(/(?:RASModel|LESModel|model)\s+(\w+)/)
    if (mm) { facts.turbulence = mm[1]; break }
    if (/simulationType\s+laminar/.test(tp)) { facts.turbulence = 'laminar'; break }
  }
  const bm = readText(join(cd, 'system/blockMeshDict'))
  if (bm) {
    const verts = [...bm.matchAll(/\(([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)/g)].slice(0, 8).map((m) => m.slice(1, 4).map(Number))
    if (verts.length >= 8) {
      const xs = verts.map((v) => v[0]), ys = verts.map((v) => v[1]), zs = verts.map((v) => v[2])
      facts.dimensions_xyz = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)].map((x) => +x.toFixed(6))
    }
  }
  try {
    facts.fields_in_0 = readdirSync(join(cd, '0')).filter((n) => !n.startsWith('.'))
    for (const fn of facts.fields_in_0.slice(0, 4)) {
      const txt = readText(join(cd, '0', fn))
      if (!txt) continue
      const bf = txt.match(/boundaryField\s*\{([\s\S]*?)\n\}/)
      if (bf) {
        const patches = [...bf[1].matchAll(/^\s*(\w+)\s*\n?\s*\{/gm)].map((m) => m[1])
        if (patches.length > facts.patches.length) facts.patches = patches
      }
    }
  } catch {}
  const regions = caseRegions(cd)
  if (regions.length) {
    const solvers = regionSolvers(cd)
    facts.multiRegion = true
    facts.regions = regions
    facts.region_solvers = solvers
    facts.region_groups = regionGroups(cd)
    facts.region_facts = regions.map((r) => {
      const f = regionFiles(cd, r)
      const bnd = readText(join(cd, 'constant', r, 'polyMesh', 'boundary'))
      const patches = bnd ? parseBoundaryPatches(bnd).slice(0, 60).map((p) => p.name) : []
      return { region: r, solver: solvers[r] || null, fields: f.fields, patches }
    })
    facts.fields_in_0 = [...new Set(facts.region_facts.flatMap((d) => d.fields))].sort()
    facts.patches = []
    facts.region_governing = regions.map((r) => ({ region: r, solver: solvers[r] || null, ...classifySolver(solvers[r] || '') }))
    if (facts.region_governing.some((g) => g.compressible === true)) facts.compressible = true
  }
  const tp = readText(join(cd, 'constant/transportProperties')) || readText(join(cd, 'constant/physicalProperties'))
  if (tp) {
    const ex = {}
    for (const k of ['nu', 'rho', 'mu', 'sigma']) {
      const mm = tp.match(new RegExp(`\\b${k}\\s+\\[[^\\]]+\\]\\s+([-\\d.eE+]+)`))
      if (mm) ex[k] = Number(mm[1])
    }
    if (Object.keys(ex).length) facts.extras.transport = ex
  }
  return { ok: true, ...facts }
}

export function algoCaseAudit(args) {
  const mismatches = []
  const c = args.contract || {}
  const f = args.case_facts || {}
  const A = c.assumes || {}
  if (A.compressible != null && f.compressible != null && A.compressible !== f.compressible) {
    mismatches.push({ axis: 'compressibility', contract: A.compressible, case: f.compressible, severity: 'high', hint: 'compressible mismatch -> wrong continuity equation' })
  }
  if (A.phases != null && f.phases != null && A.phases !== f.phases) {
    mismatches.push({ axis: 'phase count', contract: A.phases, case: f.phases, severity: 'high', hint: 'phase count mismatch -> Euler-Euler cannot drop into VOF' })
  }
  if (A.turbulence && f.turbulence && A.turbulence.toLowerCase() !== f.turbulence.toLowerCase() && !/laminar/i.test(f.turbulence)) {
    mismatches.push({ axis: 'turbulence model', contract: A.turbulence, case: f.turbulence, severity: 'mid', hint: 'turbulence quantities may not exist or differ' })
  }
  if (c.governing_type && f.governing) {
    const cgt = String(c.governing_type).toLowerCase()
    const fgt = String(f.governing).toLowerCase()
    if (cgt.includes('euler-euler') && fgt.includes('vof')) {
      mismatches.push({ axis: 'governing equation family', contract: cgt, case: fgt, severity: 'high', hint: 'contract needs Euler-Euler but the case is VOF' })
    }
    if (cgt.includes('compressible') && !fgt.includes('compressible')) {
      mismatches.push({ axis: 'governing equation family', contract: cgt, case: fgt, severity: 'high', hint: 'contract needs a compressible solver but the case is incompressible' })
    }
  }
  const fields0 = new Set(f.fields_in_0 || [])
  for (const o of c.outputs || []) {
    const n = String(o.name || '').toLowerCase()
    for (const target of ['k', 'omega', 'epsilon', 'nut', 'alpha.water', 'alpha.air', 't']) {
      if (n.includes(target) && !fields0.has(target.charAt(0).toUpperCase() + target.slice(1)) && !fields0.has(target)) {
        mismatches.push({ axis: 'missing field in 0/', contract: o.name, case: `0/ has no ${target}`, severity: 'low', hint: `the algorithm outputs ${target}, but 0/ does not have it` })
        break
      }
    }
  }
  return {
    ok: true,
    pass: mismatches.length === 0,
    mismatch_count: mismatches.length,
    mismatches,
    verdict: mismatches.length === 0 ? '✅ contract and case are compatible; proceed to step 4.' : `❌ ${mismatches.length} mismatches — step 4 is forbidden until resolved.`,
  }
}

// --- experience store ---
