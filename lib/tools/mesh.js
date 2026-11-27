import { geometryScalePrompt, scaleGateApplies } from '../needs-input.js'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { bashrcFor, bashrcOf, caseLookupHint, readLogTail, resolveCase, runFoam, scanInfo, textOut } from '../runtime.js'
import { computeFirstLayer, inspectStl, planMesh, stlGenerate, stlToAscii } from '../meshlib.js'
import { doRenderStl, renderBlocks } from '../presentation.js'
import { firstFatalLine, parseCheckMesh } from '../of-engine.js'
import { caseRegions, ensureFoamFile } from '../of-case.js'
import { capsSummary, probeCaps } from '../versions.js'

export default function meshTools({ cfg, attachImage }) {
  return [
  // --- tool: y+ first-layer calculator ---
  {
    name: 'openfoam_compute_first_layer',
    description: 'Compute the first-layer thickness, layer count, expansion ratio and total thickness from a target y+ (turbulent flat-plate correlations). Pass the result to a mesh plan.',
    parameters: {
      type: 'object',
      properties: {
        U_ref: { type: 'number', description: 'Reference velocity (m/s).' },
        L_ref: { type: 'number', description: 'Reference length (m).' },
        nu: { type: 'number', description: 'Kinematic viscosity (default 1.5e-5).' },
        y_plus_target: { type: 'number', description: 'Target y+ (default 1).' },
        expansion_ratio: { type: 'number', description: 'Layer expansion ratio (default 1.2).' },
        coverage: { type: 'number', description: 'Fraction of the boundary layer covered (default 0.7).' },
      },
      required: ['U_ref', 'L_ref'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => computeFirstLayer(args),
  },
  // --- tool: STL inspect (+ the deterministic geometry verdict) ---
  {
    name: 'openfoam_stl_inspect',
    description: 'Inspect an STL (ASCII/binary): triangle count, bbox, centroid, volume, surface area and watertightness (open-edge count). With expected_bbox ([x0,y0,z0,x1,y1,z1]) it also returns the geometry verdict: watertight, positive volume, bbox match. The visual check stays with openfoam_stl_render + read_image.',
    parameters: {
      type: 'object',
      properties: {
        stl_path: { type: 'string' },
        expected_bbox: { type: 'array', items: { type: 'number' }, description: 'Optional [x0,y0,z0,x1,y1,z1]: adds a bbox-match check to the verdict.' },
      },
      required: ['stl_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.stl_path)
      if (!p || !existsSync(p)) return { ok: false, error: 'stl not found: ' + p }
      const info = inspectStl(p)
      if (!info.ok) return info
      const checks = [
        { name: 'watertight', pass: info.watertight !== false, detail: info.open_edges != null ? `${info.open_edges} open edges` : 'n/a' },
        { name: 'positive volume', pass: info.volume > 0, detail: info.volume },
      ]
      if (Array.isArray(args.expected_bbox) && args.expected_bbox.length === 6) {
        const [x0, y0, z0, x1, y1, z1] = args.expected_bbox.map(Number)
        const exp = { min: [x0, y0, z0], max: [x1, y1, z1] }
        const d = Math.max(...[0, 1, 2].map((i) => Math.max(Math.abs(exp.max[i] - info.bbox.max[i]), Math.abs(exp.min[i] - info.bbox.min[i]))))
        checks.push({ name: 'bbox matches expected', pass: d < 1e-9, detail: `max deviation ${d}` })
      }
      return { ...info, path: p, pass: checks.every((c) => c.pass), checks }
    },
  },
  // --- tool: generate an STL from primitives ---
  {
    name: 'openfoam_stl_generate',
    description: 'Generate an STL from primitives (box/sphere/cylinder/cone/pipe), a merged parts[] array (translate/rotate_deg/scale), or an axis-aligned box given as bbox_min/bbox_max. Writes to <case>/constant/triSurface/<name>.stl or out_path, and reports bbox/volume/watertightness.',
    parameters: {
      type: 'object',
      properties: {
        out_path: { type: 'string' },
        casePath: { type: 'string' },
        name: { type: 'string', description: 'STL name without .stl (default geometry).' },
        shape: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone', 'pipe'] },
        params: { type: 'object', description: 'box{lx,ly,lz}, sphere{r,segments,rings}, cylinder{r,h,sections}, cone{r,h,sections}, pipe{r_outer,r_inner,h,sections}.' },
        parts: { type: 'array', items: { type: 'object' }, description: '[{shape,params,translate?,rotate_deg?}] merged into one STL.' },
        translate: { type: 'array', items: { type: 'number' } },
        rotate_deg: { type: 'array', items: { type: 'number' } },
        scale: { type: 'number' },
        bbox_min: { type: 'array', items: { type: 'number' }, description: '[x,y,z] of the box corner: with bbox_max this writes an axis-aligned box instead of shape+params (the domain box of a two-STL snappy setup).' },
        bbox_max: { type: 'array', items: { type: 'number' }, description: '[x,y,z] of the opposite box corner.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      let file
      if (args.out_path) {
        file = resolveCase(cfg, args.out_path)
      } else if (args.casePath) {
        const dir = resolveCase(cfg, args.casePath)
        if (!dir) return { ok: false, error: 'casePath is required (or pass out_path)' }
        // A case directory may not exist yet: the STL is the first thing to
        // write, so create it instead of refusing (the reviewer's "cannot build
        // a case from scratch" complaint).
        const createdCase = !existsSync(dir)
        mkdirSync(join(dir, 'constant/triSurface'), { recursive: true })
        const name = String(args.name || 'geometry').replace(/\.stl$/i, '')
        file = join(dir, 'constant/triSurface', name + '.stl')
      } else {
        return { ok: false, error: 'provide out_path or casePath+name' }
      }
      let tris
      try { tris = stlGenerate(args) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
      if (!tris.length) return { ok: false, error: 'no triangles generated' }
      const name = basename(file).replace(/\.stl$/i, '')
      writeFileSync(file, stlToAscii(name, tris))
      const info = inspectStl(file)
      return { ok: true, path: file, triangles: tris.length, bbox: info.bbox, volume: info.volume, watertight: info.watertight, ...(typeof createdCase !== 'undefined' ? { createdCase } : {}) }
    },
  },
  // --- tool: mesh plan ---
  {
    name: 'openfoam_mesh_plan',
    description: 'Generate blockMeshDict + snappyHexMeshDict + the feature dictionary for a case from an STL (family-aware: surfaceFeaturesDict on org, surfaceFeatureExtractDict on com). domain.type is mandatory (external/internal/box/wrap). Writes system/ dictionaries, a placeholder controlDict when there is none, and copies the STL into constant/triSurface/.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        stl_path: { type: 'string' },
        domain: { type: 'object', description: '{type, bbox_min?, bbox_max?, upstream?, downstream?, lateral?, vertical_top?, vertical_bottom?}' },
        target_cell_size: { type: 'number' },
        refinement_level_min: { type: 'number' },
        refinement_level_max: { type: 'number' },
        feature_level: { type: 'number' },
        n_layers: { type: 'number' },
        first_layer_thickness: { type: 'number' },
        expansion_ratio: { type: 'number' },
        location_in_mesh: { type: 'array', items: { type: 'number' } },
      },
      required: ['casePath', 'stl_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      // stl_path may be given relative to the case (the natural way) or to caseRoots.
      const stlArg = String(args.stl_path || '')
      const inCase = isAbsolute(stlArg) ? stlArg : join(dir, stlArg)
      const stlAbs = existsSync(inCase) ? inCase : resolveCase(cfg, stlArg)
      const caps = await probeCaps(bashrcFor(cfg, args.distribution), args.distribution || cfg.defaultDistribution)
      const plan = planMesh(cfg, { ...args, stl_path: stlAbs }, caps)
      if (!plan.ok) return plan
      const sys = join(dir, 'system')
      mkdirSync(sys, { recursive: true })
      writeFileSync(join(sys, 'blockMeshDict'), plan.blockMeshDict)
      writeFileSync(join(sys, 'snappyHexMeshDict'), plan.snappyHexMeshDict)
      const featureFile = plan.featureDictName || 'surfaceFeatureExtractDict'
      writeFileSync(join(sys, featureFile), plan.featureDict || plan.surfaceFeatureExtractDict)
      const stlName = plan.name + '.stl'
      const triDir = join(dir, 'constant/triSurface')
      mkdirSync(triDir, { recursive: true })
      if (plan.stl !== join(triDir, stlName)) {
        try { cpSync(plan.stl, join(triDir, stlName)) } catch {}
      }
      // Mesh utilities (blockMesh, snappyHexMesh) refuse to start without a
      // controlDict; write a minimal placeholder so the generated plan is
      // runnable, and say so (the scaffold later skips existing files).
      const notes = []
      if (!existsSync(join(dir, 'system', 'controlDict'))) {
        mkdirSync(join(dir, 'system'), { recursive: true })
        writeFileSync(join(dir, 'system', 'controlDict'), [
          'FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }',
          '',
          'application     foamRun;',
          '',
          'startFrom       startTime;',
          'startTime       0;',
          'stopAt          endTime;',
          'endTime         1;',
          'deltaT          1e-05;',
          'writeControl    timeStep;',
          'writeInterval   100;',
          'runTimeModifiable true;',
          '',
        ].join('\n'))
        notes.push('placeholder system/controlDict written so blockMesh can run; openfoam_case_scaffold will not overwrite it (delete it first if you want the scaffold defaults)')
      }
      const foam = ensureFoamFile(dir)
      const extent = [0, 1, 2].map((k) => plan.bbox.max[k] - plan.bbox.min[k])
      const maxExtent = Math.max(...extent)
      const askAbove = Number(cfg.scaleAskAbove) || 0
      const result = {
        ok: true,
        casePath: dir,
        stl: stlName,
        domain: plan.domain,
        bbox: plan.bbox,
        scale: { maxExtent: Number(maxExtent.toFixed(6)), askAbove },
        cells: plan.cells,
        target_cell_size: plan.target_cell_size,
        foamFile: foam.ok ? foam.name : null,
        written: ['system/blockMeshDict', 'system/snappyHexMeshDict', `system/${featureFile}`, ...(notes.length ? ['system/controlDict'] : [])],
        caps: { summary: capsSummary(caps), support: caps.support, modular: caps.modular, featuresUtility: caps.featuresUtility },
        ...(caps.support !== 'full' ? { advisory: `this OpenFOAM release is ${caps.support === 'unknown' ? 'not tested' : 'partially tested'}; the dictionaries use the ${caps.family} conventions and may need a review` } : {}),
        ...(notes.length ? { notes } : {}),
      }
      if (scaleGateApplies(maxExtent, askAbove)) {
        result.needs_input = geometryScalePrompt({ extent: maxExtent, askAbove })
      }
      return result
    },
  },
  // --- tool: mesh verify (checkMesh) ---
  {
    name: 'openfoam_mesh_verify',
    description: 'Run checkMesh (per region on multi-region/CHT cases) and judge the mesh the way OpenFOAM does: pass when checkMesh itself prints "Mesh OK." The strict thresholds (aspect ratio, non-orthogonality, skewness) are reported as warnings, not failures. Use this INSTEAD of running checkMesh by hand.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        region: { type: 'string', description: 'Check one region only (multi-region cases); by default every region is checked.' },
        log_path: { type: 'string', description: 'Parse a saved checkMesh log instead of running checkMesh (a log from a previous run, or a remote machine).' },
        allGeometry: { type: 'boolean', description: 'Pass -allGeometry (extra bounding-box checks).' },
        allTopology: { type: 'boolean', description: 'Pass -allTopology (extra topology checks).' },
        timeout_ms: { type: 'number' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      // A saved log is judged exactly like a live run: same parser, same verdict,
      // so a checkMesh log from another machine needs no OpenFOAM (and no case)
      // here.
      const logOnly = !args.casePath && args.log_path
      const dir = logOnly ? null : resolveCase(cfg, args.casePath)
      if (!logOnly && (!dir || !existsSync(dir))) return { ok: false, error: 'case not found: ' + dir + caseLookupHint(cfg) }
      if (!logOnly && !args.log_path && !args.casePath) return { ok: false, error: 'casePath or log_path is required' }
      if (args.log_path) {
        const lp = resolveCase(cfg, args.log_path)
        const scan = readLogTail(lp, Number(cfg.logTailBytes) || undefined)
        if (!scan.text) return { ok: false, error: 'cannot read ' + lp }
        const metrics = parseCheckMesh(scan.text)
        const pass = metrics.meshOk === true && !metrics.failed
        const error = pass ? null : firstFatalLine(scan.text)
        const problems = [...(metrics.problems || [])]
        if (!pass && error && !problems.some((p) => p.includes(error))) problems.push(error)
        return {
          ok: true, pass, failed: !pass, source: lp, logScan: scanInfo(scan),
          metrics, problems,
          warnings: pass ? problems.map((p) => `${p} (checkMesh still reports Mesh OK)`) : [],
          logTail: scan.text.slice(-4000),
        }
      }
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const flags = []
      if (args.allGeometry) flags.push('-allGeometry')
      if (args.allTopology) flags.push('-allTopology')
      const regions = caseRegions(dir)
      if (args.region && regions.length && !regions.includes(args.region)) {
        return { ok: false, error: `no such region: ${args.region}`, regions }
      }
      const targets = args.region ? [args.region] : (regions.length ? regions : [null])
      const checks = []
      let logAll = ''
      for (const region of targets) {
        const argv = ['checkMesh', ...(region ? ['-region', region] : []), ...flags]
        const cmd = argv.join(' ')
        const r = await runFoam(argv, { bashrc: bash, dir, signal: exec && exec.signal, timeoutMs: Math.min(Number(args.timeout_ms) || 300000, 900000) })
        const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
        logAll += `\n===== ${cmd} =====\n` + log
        const metrics = parseCheckMesh(log)
        const pass = r.ok && metrics.meshOk === true && !metrics.failed
        const error = pass ? '' : firstFatalLine(log)
        const problems = [...(metrics.problems || [])]
        if (!pass && error && !problems.some((p) => p.includes(error))) problems.push(error)
        checks.push({
          region: region || '(single region)', command: cmd, exitCode: r.code, ok: r.ok,
          pass, failed: !pass, meshOk: metrics.meshOk === true,
          failedChecks: metrics.failedChecks || 0, metrics, problems, error: error || null,
        })
      }
      const pass = checks.every((c) => c.pass)
      const warnings = []
      for (const c of checks) {
        for (const p of c.problems) warnings.push(`${c.region}: ${p} (checkMesh still reports Mesh OK)`)
      }
      const suggestions = []
      for (const c of checks) {
        if (c.pass) continue
        if (c.exitCode) suggestions.push(`${c.region}: checkMesh exited ${c.exitCode} — read logTail; the mesh may be missing (run blockMesh)`)
        else if (c.failedChecks) suggestions.push(`${c.region}: checkMesh reported ${c.failedChecks} failed mesh check(s) — see logTail for the offending cells`)
        else if (!c.meshOk) suggestions.push(`${c.region}: checkMesh did not print "Mesh OK." — read logTail`)
      }
      if (!pass && regions.length && !args.region) suggestions.push('multi-region case: each region is checked separately; rerun with region="<name>" for details')
      if (warnings.length && pass) suggestions.push('the mesh passes checkMesh; the warnings are the workbench\'s stricter comfort thresholds, not OpenFOAM failures')
      const metrics = checks.length === 1
        ? checks[0].metrics
        : checks.reduce((acc, c) => { acc[`${c.region} cells`] = c.metrics.cells; acc[`${c.region} non-ortho`] = c.metrics['max non-orthogonality']; acc[`${c.region} skewness`] = c.metrics['max skewness']; return acc }, {})
      return {
        ok: true,
        pass,
        failed: !pass,
        multiRegion: regions.length > 0,
        regions: checks.map((c) => ({
          region: c.region, pass: c.pass, meshOk: c.meshOk, failedChecks: c.failedChecks,
          exitCode: c.exitCode, command: c.command,
          ...(c.error ? { error: c.error } : {}),
        })),
        problems: checks.flatMap((c) => c.problems.map((p) => `${c.region}: ${p}`)),
        metrics,
        warnings,
        suggestions,
        logTail: logAll.slice(-4000),
      }
    },
  },
  // --- tool: render an STL geometry ---
  {
    name: 'openfoam_stl_render',
    description: 'Render an STL geometry to PNG off-screen with pvpython (inline image). Useful to check normals/watertightness visually before meshing.',
    parameters: {
      type: 'object',
      properties: {
        stl_path: { type: 'string' },
        azimuth: { type: 'number' },
        elevation: { type: 'number' },
        zoom: { type: 'number' },
      },
      required: ['stl_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => renderBlocks(v) },
    timeoutMs: 360000,
    isConcurrencySafe: () => false,
    execute: async (args) => attachImage(await doRenderStl(cfg, args)),
  },
  ]
}
