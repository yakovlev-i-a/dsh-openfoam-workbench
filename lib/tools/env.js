import { cpSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { bashrcFor, dictEntry, escapeRe, pluginInfo, probeBashrc, readText, resolveCase, resolveCaseInfo, resolveSource, rootFor, run, sourceRoots, stripComments, textOut, walk } from '../runtime.js'
import { resolveLanguage } from '../discover.js'
import { scaleGateApplies } from '../needs-input.js'
import { capsSummary, probeCaps, versionCaps } from '../versions.js'
import { classifySolver } from '../knowledge.js'
import { caseProbeFacts } from '../caselib.js'
import { inspectSolverModule, readMakeFiles } from '../buildlib.js'
import { CASE_FILES, fieldFiles, parseBoundaryPatches, readCaseDict, strayTimeDirs } from '../of-engine.js'
import { caseBBox, caseRegions, ensureFoamFile, findFoamFile, foamFiles, regionFiles, regionGroups, regionSolvers, strayFoamFiles, zeroDirOf } from '../of-case.js'

export default function envTools({ cfg }) {
// One distribution as a row: used by version_info(all: true), which absorbed
// the old openfoam_env_check.
async function distributionRow(cfg, key) {
  const bash = bashrcFor(cfg, key || '')
  const root = rootFor(cfg, key || '')
  const rep = {
    distribution: key || 'default',
    foamRoot: root || null,
    foamRootExists: !!root && existsSync(root),
    bashrc: bash || null,
    bashrcExists: !!bash && existsSync(bash),
    version: null,
    projectDir: null,
    flavor: null,
    ok: false,
  }
  if (rep.bashrcExists) {
    const r = await probeBashrc(bash, 'echo "$WM_PROJECT_VERSION"; echo "$WM_PROJECT_DIR"; echo "$WM_PROJECT"', { timeoutMs: 20000 })
    const lines = r.stdout.split('\n').map((x) => x.trim())
    rep.version = lines[0] || null
    rep.projectDir = lines[1] || null
    rep.flavor = lines[2] || null
    rep.ok = r.ok && !!rep.version
    rep.distributionKind = rep.version && /^v\d/i.test(rep.version) ? 'com (ESI)' : 'org'
    const caps = await probeCaps(bash, key || '')
    rep.caps = {
      summary: capsSummary(caps),
      support: caps.support,
      modular: caps.modular,
      postProcess: caps.postProcess,
      features: caps.featuresUtility,
      transportFile: caps.transportFile,
      turbulenceFile: caps.turbulenceFile,
    }
  }
  return rep
}

  return [
  // --- tool: version info ---
  {
    name: 'openfoam_version_info',
    description: 'Return the installed OpenFOAM flavor/version, key paths and capability summary. Use once per session before solver or source work; `all: true` probes every configured distribution (org and com) instead of one.',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean' },
        distribution: { type: 'string', description: 'org | com' },
        all: { type: 'boolean', description: 'Report every configured distribution (foamRoots) with its bashrc/version/caps instead of the selected one.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      if (args && args.all === true) {
        const keys = Object.keys(cfg.foamRoots || {})
        const rows = []
        for (const key of (keys.length ? keys : [''])) rows.push(await distributionRow(cfg, key))
        const plugin = { ...pluginInfo(), language: cfg.responseLanguage || resolveLanguage(cfg) }
        if (rows.length === 1) return { ...rows[0], plugin }
        return { ok: rows.every((r) => r.ok), plugin, distributions: rows }
      }
      const bash = bashrcFor(cfg, args && args.distribution)
      // The plugin's own identity is answerable even on a machine without OpenFOAM
      // (CI, a fresh container): say which build is loaded and what was not found.
      const plugin = { ...pluginInfo(), language: cfg.responseLanguage || resolveLanguage(cfg) }
      if (!bash || !existsSync(bash)) {
        return { ok: false, error: 'bashrc/foamRoot not configured', plugin, foamRoots: Object.keys(cfg.foamRoots || {}) }
      }
      const r = await probeBashrc(bash, 'echo "$WM_PROJECT_VERSION"; echo "$WM_PROJECT_DIR"; echo "$WM_PROJECT"; echo "$WM_ARCH"', { timeoutMs: 20000 })
      const l = r.stdout.split('\n').map((s) => s.trim())
      const version = l[0] || null
      return {
        ok: r.ok,
        version,
        projectDir: l[1] || null,
        flavor: l[2] || null,
        arch: l[3] || null,
        distribution: version && /^v\d/i.test(version) ? 'com (ESI)' : 'org',
        caps: (() => {
          const caps = versionCaps(version && /^v\d/i.test(version) ? 'com' : 'org', version)
          return { summary: capsSummary(caps), support: caps.support, modular: caps.modular, blockMesh: caps.blockMeshScale, postProcess: caps.postProcess, features: caps.featuresUtility, fieldStats: caps.fieldStats, transportFile: caps.transportFile, turbulenceFile: caps.turbulenceFile, zeroDir: caps.zeroDir }
        })(),
        plugin,
      }
    },
  },
  // --- tool: inspect case (read-only) ---
  {
    name: 'openfoam_inspect_case',
    description: 'Inspect an OpenFOAM case: solver, steady/transient, endTime, fields in 0/, patch types, turbulence model. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string', description: 'Case directory (absolute, or relative to caseRoots[0]).' },
        facts: { type: 'boolean', description: 'Add the solver classification: governing family, compressibility, phases, per-region governing, mesh extents (the step-2 "what does this case actually solve" facts).' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      // case_path is the older spelling (it came with the four-step probe) and is
      // still accepted, so a skill written against it keeps working.
      const caseArg = args && (args.casePath || args.case_path)
      const dir = resolveCase(cfg, caseArg)
      if (!dir || !existsSync(dir)) return { ok: false, error: `case not found: ${dir}` }
      const info = {
        ok: true,
        path: dir,
        solver: null,
        steady: null,
        endTime: null,
        deltaT: null,
        fields: [],
        patches: [],
        turbulenceModel: null,
      }
      const cd = readText(join(dir, 'system/controlDict'))
      if (cd) {
        info.solver = dictEntry(cd, 'application') || dictEntry(cd, 'solver')
        info.endTime = dictEntry(cd, 'endTime')
        info.deltaT = dictEntry(cd, 'deltaT')
      }
      const fsText = readText(join(dir, 'system/fvSchemes'))
      if (fsText) {
        const m = stripComments(fsText).match(/ddtSchemes\s*\{([\s\S]*?)\}/)
        info.steady = m ? /steadyState/.test(m[1]) : /steadyState/.test(fsText)
      }
      try {
        info.fields = readdirSync(join(dir, '0')).filter((f) => !f.startsWith('.')).sort()
      } catch {}
      const regions = caseRegions(dir)
      const parsePatches = (rel) => {
        const bnd = readText(join(dir, rel))
        return bnd ? parseBoundaryPatches(bnd).slice(0, 60).map((p) => ({ name: p.name, type: p.type })) : []
      }
      if (regions.length) {
        const solvers = regionSolvers(dir)
        info.multiRegion = true
        info.regions = regions
        info.regionSolvers = solvers
        info.regionGroups = regionGroups(dir)
        info.regionDetails = regions.map((r) => {
          const f = regionFiles(dir, r)
          return {
            region: r,
            solver: solvers[r] || null,
            fields: f.fields,
            systemDicts: f.system,
            constantDicts: f.constant,
            patches: parsePatches(`constant/${r}/polyMesh/boundary`),
          }
        })
        info.fields = [...new Set(info.regionDetails.flatMap((d) => d.fields))].sort()
        info.patches = []
      } else {
        info.fields = (() => { try { const zd = zeroDirOf(dir); return zd ? readdirSync(zd).filter((f) => !f.startsWith('.')).sort() : [] } catch { return [] } })()
        info.patches = parsePatches('constant/polyMesh/boundary')
      }
      const foam = findFoamFile(dir)
      info.foamFile = foam ? basename(foam) : null
      // The accepted name is `<case-dir-name>.foam`; list what the directory
      // actually carries so a stray `case.foam` (a copy of an older case, or a
      // render helper written by an older build) is visible instead of silent.
      const foams = foamFiles(dir)
      if (foams.length) info.foamFiles = foams
      const strays = strayFoamFiles(dir)
      if (strays.length) {
        info.hint =
          'the case entry file is `' + basename(dir) + '.foam`; ' +
          strays.map((f) => '`' + f + '`').join(', ') +
          ' is not it — `openfoam_render` ignores it (delete or rename it)'
      }
      const bbox = caseBBox(dir)
      if (bbox.ok) {
        info.bbox = { min: bbox.min, max: bbox.max, extent: bbox.extent, maxExtent: Number(bbox.maxExtent.toFixed(6)) }
        const askAbove = Number(cfg.scaleAskAbove) || 0
        info.scale = { maxExtent: Number(bbox.maxExtent.toFixed(6)), askAbove, suspicious: scaleGateApplies(bbox.maxExtent, askAbove) }
      }
      const turbFiles = ['constant/momentumTransport', 'constant/turbulenceProperties', 'constant/transportProperties']
      for (const f of turbFiles) {
        const t = readText(join(dir, f))
        if (t) {
          info.turbulenceModel = dictEntry(t, 'model')
          if (info.turbulenceModel) break
        }
      }
      if (!info.turbulenceModel && regions.length) {
        for (const r of regions) {
          for (const f of turbFiles) {
            const t = readText(join(dir, f.replace('constant/', `constant/${r}/`)))
            if (!t) continue
            const model = dictEntry(t, 'model') || (/(^|\n)\s*laminar\s*;/.test(t) ? 'laminar' : null)
            if (model) { info.turbulenceModel = model; break }
          }
          if (info.turbulenceModel) break
        }
      }
      const out = { ...info, resolvedFrom: (resolveCaseInfo(cfg, args.casePath)).resolvedFrom }
      // facts: true is the old openfoam_case_probe_facts — the solver family a
      // case actually solves, which a steady/transient + fields listing misses.
      if (args.facts === true) {
        const probe = caseProbeFacts(cfg, { ...args, casePath: caseArg })
        if (!probe.ok) return probe
        for (const k of ['governing', 'compressible', 'phases', 'dimensions_xyz', 'region_governing', 'region_facts', 'extras']) {
          if (probe[k] !== undefined) out[k] = probe[k]
        }
        if (probe.turbulence && !out.turbulenceModel) out.turbulenceModel = probe.turbulence
        if (probe.fields_in_0 && probe.fields_in_0.length) out.fields_in_0 = probe.fields_in_0
        if (probe.fields_from) out.fields_from = probe.fields_from
        if (probe.patches) out.patches = probe.patches
        if (probe.regions && probe.regions.length && !(out.regions || []).length) out.regions = probe.regions
      }
      return out
    },
  },
  // --- tool: read native OpenFOAM source (read-only) ---
  {
    name: 'openfoam_read_source',
    description: 'Read a file or list a directory from the OpenFOAM installation (src/, applications/, etc/codeTemplates/) — read-only and outside the workspace. Returns numbered lines with start_line/end_line paging. Use this INSTEAD of cat/ls on the install tree.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path under foamRoot, or relative to src/.' },
        start_line: { type: 'number' },
        end_line: { type: 'number' },
        max_chars: { type: 'number' },
      },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const r = resolveSource(cfg, args && args.path)
      if (!r.ok) return { ok: false, error: r.error }
      let st
      try { st = statSync(r.path) } catch {
        // A near miss should teach the next call: list files with a similar
        // basename and point at the discovery tool instead of just "not found".
        const stem = basename(String(args.path || '')).replace(/\.[^.]+$/, '').toLowerCase()
        const suggestions = []
        if (stem.length >= 4) {
          for (const root of sourceRoots(cfg)) {
            let n = 0
            walk(root, 6, (file) => {
              if (n >= 5) return
              const name = basename(file).toLowerCase()
              if (name.includes(stem.slice(0, Math.max(4, Math.floor(stem.length * 0.7)))) && suggestions.length < 5) {
                suggestions.push(file)
                n += 1
              }
            })
            if (suggestions.length >= 5) break
          }
        }
        return {
          ok: false,
          error: 'not found: ' + r.path,
          ...(suggestions.length ? { suggestions } : {}),
          hint: 'use openfoam_find_source with kind="source" and a shorter query (e.g. "' + (stem || 'limitedLinear') + '")',
        }
      }
      if (st.isDirectory()) {
        try { return { ok: true, path: r.path, entries: readdirSync(r.path).sort() } } catch (e) { return { ok: false, error: String(e.message || e) } }
      }
      const text = readText(r.path) || ''
      const lines = text.split('\n')
      const s = Math.max(1, Number(args.start_line) || 1)
      const e = Number(args.end_line) ? Math.min(lines.length, Number(args.end_line)) : Math.min(lines.length, s + 399)
      let body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(6)}  ${l}`).join('\n')
      const cap = Math.min(Number(args.max_chars) || 60000, 200000)
      if (body.length > cap) body = body.slice(0, cap) + '\n... (truncated)'
      return { ok: true, path: r.path, start: s, end: e, total: lines.length, text: body }
    },
  },
  // --- tool: search source content ---
  {
    name: 'openfoam_source_search',
    description: 'Search OpenFOAM source content (src/, applications/) by regex or plain text, returning file:line and a snippet. Use this INSTEAD of `grep -r` over $FOAM_SRC to answer "does the solver support X" / "where is it computed". Quote the phrase as it appears in the code (e.g. "does not support LTS"), not as a question.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean' },
        top_k: { type: 'number' },
        file_glob: { type: 'string', description: 'Only files ending with this (e.g. ".C").' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const q = String(args.query || '')
      if (!q) return { ok: false, error: 'empty query' }
      let re
      try {
        re = args.regex ? new RegExp(q, 'i') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      } catch (e) {
        return { ok: false, error: 'bad regex: ' + (e.message || e) }
      }
      const topK = Math.min(Number(args.top_k) || 20, 200)
      const hits = []
      const foamRootCfg = rootFor(cfg, '')
      const rel = (file) => (foamRootCfg && file.startsWith(foamRootCfg) ? file.slice(foamRootCfg.length + 1) : file)
      for (const root of sourceRoots(cfg)) {
        if (!existsSync(root)) continue
        walk(root, (file) => {
          if (args.file_glob && !file.endsWith(String(args.file_glob).replace(/^\*/, ''))) return
          if (!/\.(C|H|cc|cpp|hpp|md)$/i.test(file)) return
          let text
          try { text = readFileSync(file, 'utf8') } catch { return }
          if (!re.test(text)) return
          const lines = text.split('\n')
          for (let i = 0; i < lines.length && hits.length < topK; i++) {
            if (re.test(lines[i])) hits.push({ file: rel(file), line: i + 1, text: lines[i].trim().slice(0, 200) })
          }
          return hits.length < topK
        }, 20000)
        if (hits.length >= topK) break
      }
      return { ok: true, count: hits.length, hits }
    },
  },
  // --- tool: find tutorials ---
  {
    name: 'openfoam_find_tutorial',
    description: 'Search the OpenFOAM tutorials/ tree for cases (dirs with system/controlDict). The query is split into tokens and each must match the case path or the text of its system/controlDict (application, solver, regionSolvers, fvModels), so a phrase such as `cht multiRegion regionSolvers` finds multiRegion/CHT/*. Returns candidate paths relative to tutorials/; pair it with openfoam_clone_tutorial.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' }, distribution: { type: 'string', description: 'org | com' } },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const foamRoot = rootFor(cfg, args.distribution)
      const root = foamRoot ? join(foamRoot, 'tutorials') : ''
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot/tutorials not found' }
      const q = String(args.query || '').toLowerCase().trim()
      const topK = Math.min(Number(args.top_k) || 12, 100)
      // A question such as "cht multiRegion solid fluid regionSolvers" names no
      // directory verbatim; match tokens against the path and against the
      // dictionaries that define what a case is.
      const tokens = q.split(/[^a-z0-9_+.]+/).filter((t) => t.length > 1)
      const dirs = []
      walk(root, (file) => {
        if (!file.endsWith('/system/controlDict')) return
        dirs.push(file.slice(0, -'/system/controlDict'.length))
        return dirs.length < 4000
      }, 200000)
      const scored = []
      let dictReads = 0
      for (const dir of dirs) {
        const rel = dir.slice(root.length + 1)
        if (!tokens.length) { scored.push({ path: rel, score: 0, matched: [] }); continue }
        const haystackPath = rel.toLowerCase()
        const inPath = tokens.filter((t) => haystackPath.includes(t))
        if (inPath.length === tokens.length) {
          scored.push({ path: rel, score: tokens.length, matched: inPath })
          continue
        }
        // Read the dictionary only when the path alone does not answer: it holds
        // application, solver, regionSolvers, fvModels and libs, which is what a
        // physics question is really about.
        let matched = inPath
        if (dictReads < 2000) {
          dictReads += 1
          const text = String(readText(join(dir, 'system/controlDict')) || '').toLowerCase()
          matched = tokens.filter((t) => inPath.includes(t) || text.includes(t))
        }
        if (matched.length) scored.push({ path: rel, score: matched.length, matched })
      }
      // Prefer cases that carry every token; fall back to near-misses only when
      // the strict pass finds nothing, and say so instead of pretending.
      const strict = scored.filter((s) => s.score === tokens.length)
      const chosen = strict.length ? strict : scored
      chosen.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
      return {
        ok: true,
        query: q,
        tokens,
        matchedAll: strict.length > 0 || tokens.length === 0,
        count: Math.min(chosen.length, topK),
        tutorials: chosen.slice(0, topK).map((s) => s.path),
        ...(tokens.length ? { scores: chosen.slice(0, topK).map((s) => ({ tutorial: s.path, matched: s.matched })) } : {}),
      }
    },
  },
  // --- tool: clone tutorial into workspace ---
  {
    name: 'openfoam_clone_tutorial',
    description: 'Copy a tutorial case into the workspace (caseRoots[0]). tutorial_path may be relative to foamRoot/tutorials or absolute inside it.',
    parameters: {
      type: 'object',
      properties: { tutorial_path: { type: 'string' }, dest: { type: 'string' }, distribution: { type: 'string', description: 'org | com' } },
      required: ['tutorial_path', 'dest'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const foamRoot = rootFor(cfg, args.distribution)
      const root = foamRoot ? join(foamRoot, 'tutorials') : ''
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot/tutorials not found' }
      const src = isAbsolute(args.tutorial_path) ? args.tutorial_path : join(root, args.tutorial_path)
      if (!existsSync(src)) return { ok: false, error: 'tutorial not found: ' + src }
      if (!existsSync(join(src, 'system/controlDict'))) return { ok: false, error: 'not a case (no system/controlDict): ' + src }
      const destRoot = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()
      const dest = isAbsolute(args.dest) ? args.dest : join(destRoot, args.dest)
      if (existsSync(dest)) return { ok: false, error: 'destination exists: ' + dest }
      try { cpSync(src, dest, { recursive: true }) } catch (e) { return { ok: false, error: String(e.message || e) } }
      const foam = ensureFoamFile(dest)
      return { ok: true, tutorial: src, dest, foamFile: foam.ok ? foam.name : null }
    },
  },
  // --- tool: inspect a solver module ---
  {
    name: 'openfoam_solver_inspect',
    description: 'Inspect an OpenFOAM solver module: Make/files target, main source, includes, fields from createFields.H, loop calls (UEqn/pEqn/controls/CorrectPhi), and risks.',
    parameters: {
      type: 'object',
      properties: { modulePath: { type: 'string' } },
      required: ['modulePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.modulePath)
      if (!existsSync(join(p, 'Make/files'))) return { ok: false, error: 'not a module (no Make/files): ' + p }
      return { ok: true, path: p, ...inspectSolverModule(p) }
    },
  },
  // --- tool: clone a native solver into the workspace ---
  {
    name: 'openfoam_clone_solver',
    description: 'Copy a native solver directory into the workspace, rename the main .C to <newName>.C and rewrite Make/files to EXE = $(FOAM_USER_APPBIN)/<newName>. Never edits the installation. Optionally switch a case controlDict.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Solver directory (absolute, usually from find_source kind=solver).' },
        dest: { type: 'string', description: 'Destination directory relative to caseRoots[0].' },
        new_name: { type: 'string' },
        case_path: { type: 'string' },
      },
      required: ['source', 'dest'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const src = String(args.source || '')
      const destRoot = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()
      const dest = isAbsolute(args.dest) ? args.dest : join(destRoot, args.dest)
      if (!src || !existsSync(src)) return { ok: false, error: 'source not found: ' + src }
      if (existsSync(dest)) return { ok: false, error: 'destination exists: ' + dest }
      const make = readMakeFiles(src)
      if (!make.mainSource) return { ok: false, error: 'source has no main .C in Make/files' }
      const newName = String(args.new_name || basename(dest)).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return { ok: false, error: 'bad new_name: ' + newName }
      try { cpSync(src, dest, { recursive: true }) } catch (e) { return { ok: false, error: String(e.message || e) } }
      const oldMain = join(dest, make.mainSource)
      const newMain = join(dest, newName + '.C')
      try {
        if (existsSync(oldMain) && oldMain !== newMain) renameSync(oldMain, newMain)
      } catch (e) {
        return { ok: false, error: 'rename failed: ' + (e.message || e) }
      }
      const mf = join(dest, 'Make/files')
      let text = readText(mf) || ''
      text = text.replace(new RegExp(escapeRe(make.mainSource), 'g'), newName + '.C')
      text = text.replace(/^\s*(EXE|LIB)\s*=\s*\S+/m, `EXE = $(FOAM_USER_APPBIN)/${newName}`)
      try { writeFileSync(mf, text) } catch (e) { return { ok: false, error: 'write Make/files failed: ' + (e.message || e) } }
      if (args.case_path) {
        const caseDir = resolveCase(cfg, args.case_path)
        const cd = readText(join(caseDir, 'system/controlDict'))
        if (cd) {
          const out = cd.replace(/^(\s*(?:application|solver))\s+\S+;/m, `$1 ${newName};`)
          try { writeFileSync(join(caseDir, 'system/controlDict'), out) } catch {}
        }
      }
      return { ok: true, source: src, dest, newName }
    },
  },
  // --- tool: list installed solvers ---
  {
    name: 'openfoam_list_solvers',
    description: 'List the solvers installed in the OpenFOAM distribution (applications/solvers, applications/modules, applications/legacy) with their classified governing family, compressibility and phase count.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Optional substring to filter names.' }, distribution: { type: 'string', description: 'org | com' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const root = rootFor(cfg, args.distribution)
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot not configured' }
      const solvers = []
      const seen = new Set()
      const add = (name, source) => {
        if (seen.has(name)) return
        seen.add(name)
        const cls = classifySolver(name)
        solvers.push({ name, source, governing: cls.governing, compressible: cls.compressible, phases: cls.phases })
      }
      // A solver is a directory with Make/files; intermediate directories are
      // just categories (basic/combustion/heatTransfer/...), so walk recursively.
      const walkSolvers = (dir, rel, depth) => {
        if (depth < 0) return
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue
          const child = join(dir, e.name)
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (existsSync(join(child, 'Make/files'))) add(e.name, childRel)
          else walkSolvers(child, childRel, depth - 1)
        }
      }
      // applications/modules: every child directory is a modular solver (it may
      // carry Make/files or not, depending on the distribution layout).
      const modulesDir = join(root, 'applications/modules')
      if (existsSync(modulesDir)) {
        for (const e of readdirSync(modulesDir, { withFileTypes: true })) {
          if (e.isDirectory() && e.name !== 'functions' && !e.name.startsWith('.')) add(e.name, 'modules')
        }
      }
      // applications/solvers and applications/legacy: categories above the
      // solver level, so walk down to the directories that hold Make/files.
      for (const base of ['applications/solvers', 'applications/legacy']) {
        const dir = join(root, base)
        if (existsSync(dir)) walkSolvers(dir, base.replace('applications/', ''), 4)
      }
      let out = solvers
      if (args.filter) out = out.filter((s) => s.name.toLowerCase().includes(String(args.filter).toLowerCase()))
      const modular = existsSync(join(root, 'applications/modules'))
      return { ok: true, distribution: modular ? 'org (modular solvers)' : 'com (application solvers)', modular, count: out.length, solvers: out }
    },
  },
  // --- tool: find a native solver or source file by name ---
  {
    name: 'openfoam_find_source',
    description: 'Find a native OpenFOAM solver or source file by name — searches applications/solvers, applications/modules, applications/legacy (directories with Make/files) and/or src/ for paths containing the query. Use this INSTEAD of `find` over the install tree.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['solver', 'source', 'any'], description: 'Default solver.' },
        top_k: { type: 'number' },
        distribution: { type: 'string', description: 'org | com' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const root = rootFor(cfg, args.distribution)
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot not configured' }
      const q = String(args.query || '').toLowerCase()
      if (!q) return { ok: false, error: 'empty query' }
      const kind = args.kind || 'solver'
      const topK = Math.min(Number(args.top_k) || 10, 50)
      const roots = []
      if (kind === 'solver' || kind === 'any') roots.push(join(root, 'applications'))
      if (kind === 'source' || kind === 'any') roots.push(join(root, 'src'))
      const out = []
      const seen = new Set()
      for (const r of roots) {
        if (!existsSync(r)) continue
        walk(r, (file) => {
          if (out.length >= topK * 3) return false
          const rel = file.slice(root.length + 1)
          if (!rel.toLowerCase().includes(q)) return
          let path
          if (kind === 'solver') {
            if (!file.endsWith('/Make/files')) return
            path = file.slice(0, -'/Make/files'.length)
          } else {
            path = file
          }
          if (seen.has(path)) return
          seen.add(path)
          out.push({ path, name: basename(path) })
        }, 30000)
      }
      return { ok: true, count: Math.min(out.length, topK), candidates: out.slice(0, topK) }
    },
  },
  ]
}
