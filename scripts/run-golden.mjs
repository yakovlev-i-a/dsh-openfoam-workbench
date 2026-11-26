#!/usr/bin/env node
// Golden-case runner.
//
// Runs a small set of cases against one installed OpenFOAM distribution, extracts
// a handful of quantities and compares them with test/golden/expected/<dist>.json.
// `--update` re-blesses the expected values; that must be a reviewed change.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CASES, copyTutorial, resolveTutorial } from '../test/golden/cases.mjs'
import { discoverFoamRoots, resolveLanguage } from '../lib/discover.js'
import { bashrcFor, runFoam } from '../lib/runtime.js'
import { parseCheckMesh, parseDict, parseBoundaryPatches, checkCase } from '../lib/of-engine.js'
import { caseRegions } from '../lib/of-case.js'
import { probeCaps } from '../lib/versions.js'
import { scaffoldFiles } from '../lib/scaffold.js'
import { scaffoldCht } from '../lib/scaffold-cht.js'
import { scaffoldCompressible } from '../lib/scaffold-compressible.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOL = { cells: 0, maxNonOrtho: 0.01, finalTime: 1e-3, default: 0.05 }

function parseArgs(argv) {
  const out = { cases: [], distributions: [], update: false, json: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--case') out.cases.push(argv[++i])
    else if (a === '--distribution') out.distributions.push(argv[++i])
    else if (a === '--update') out.update = true
    else if (a === '--json') out.json = true
    else if (a === '--keep') out.keep = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

function makeCfg() {
  const discovered = discoverFoamRoots()
  const foamRoots = {}
  const foamBashs = {}
  for (const found of discovered.found || []) {
    foamRoots[found.key] = found.dir
    foamBashs[found.key] = join(found.dir, 'etc', 'bashrc')
  }
  return { foamRoots, foamBashs, defaultDistribution: Object.keys(foamRoots)[0] || 'org', caseRoots: [ROOT], language: 'en', scaleAskAbove: 0.1 }
}

async function run(cfg, dist, argv, dir) {
  const bash = bashrcFor(cfg, dist)
  const r = await runFoam(argv, { bashrc: bash, dir, timeoutMs: 900000 })
  return { ok: r.ok, text: (r.stdout || '') + (r.stderr || ''), argv: argv.join(' ') }
}

function readTextSafe(p) {
  try { return readFileSync(p, 'utf8') } catch {}
  // the stored fixtures keep polyMesh as .gz; OpenFOAM reads both
  try { return gunzipSync(readFileSync(p + '.gz')).toString('utf8') } catch {}
  return ''
}

/** Which command starts the solver this case ends up with. */
function solverCommand(caseDir) {
  if (existsSync(join(caseDir, 'system', 'regionSolvers'))) return 'foamMultiRun'
  const control = readTextSafe(join(caseDir, 'system', 'controlDict'))
  if (/application\s+foamMultiRun\s*;/.test(control)) return 'foamMultiRun'
  if (/solver\s+\w+\s*;/.test(control) && !/application\s+(simpleFoam|icoFoam|rhoPimpleFoam|chtMultiRegionFoam)/.test(control)) return 'foamRun'
  const app = /application\s+(\w+)\s*;/.exec(control)
  return app ? app[1] : 'foamRun'
}

/** Last "Time = X" and the worst initial residual of the solver log. */
function logMetrics(text) {
  const times = [...text.matchAll(/^\s*Time = ([\d.eE+-]+)s?/gm)].map((m) => Number(m[1]))
  const res = [...text.matchAll(/Initial residual = ([\d.eE+-]+)/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n))
  return { finalTime: times.length ? times[times.length - 1] : null, lastResidual: res.length ? res[res.length - 1] : null }
}

async function fieldExtreme(cfg, dist, caseDir, field, kind, region) {
  const utility = /^v\d|^com/i.test(dist) ? 'postProcess' : 'foamPostProcess'
  const regionArgs = region ? ['-region', region] : []
  const r = await run(cfg, dist, [utility, ...regionArgs, '-func', `cell${kind}(${field})`, '-latestTime'], caseDir)
  const re = /(?:min|max|maxMag|minMag)\([^)]*\) of \w+ = (?:\(([^)]*)\)|([-\d.eE+]+))/
  for (const line of r.text.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    if (m[1] !== undefined) {
      const nums = m[1].trim().split(/\s+/).map(Number)
      if (kind === 'MaxMag') return Math.sqrt(nums.reduce((s, n) => s + n * n, 0))
      return nums
    }
    return Number(m[2])
  }
  return null
}

/** Collect the quantities listed in the case definition. */
async function collectQoi(cfg, dist, caseDir, qoiList, checkText, logText, regions) {
  const out = {}
  const mesh = parseCheckMesh(checkText)
  const regionCheck = {}
  const checkFor = async (region) => {
    if (!region) return mesh
    if (!regionCheck[region]) {
      const r = await run(cfg, dist, ['checkMesh', '-region', region], caseDir)
      regionCheck[region] = parseCheckMesh(r.text)
    }
    return regionCheck[region]
  }
  const log = logMetrics(logText)
  for (const key of qoiList) {
    if (key === 'finalTime') { out[key] = log.finalTime; continue }
    if (key === 'lastResidual') { out[key] = log.lastResidual; continue }
    const parts = key.split('.')
    let region = ''
    let metric = key
    if (parts.length === 2 && parts[1] === 'cells') {
      region = parts[0]
      metric = 'cells'
    } else if (parts.length === 3 && (parts[1] === 'cells')) {
      region = parts[0]
      metric = 'cells'
    } else if (parts.length === 3) {
      region = parts[0]
      metric = parts.slice(1).join('.')
    }
    if (metric === 'cells') {
      const m2 = await checkFor(region)
      out[key] = m2.cells ? Number(m2.cells) : null
      continue
    }
    if (metric === 'maxNonOrtho') { const v = mesh['max non-orthogonality']; out[key] = v !== undefined ? Number(v) : null; continue }
    const m = /^(\w+)\.(min|max|maxMagnitude)$/.exec(metric)
    if (!m) { out[key] = null; continue }
    const [, field, kind] = m
    out[key] = await fieldExtreme(cfg, dist, caseDir, field, kind === 'min' ? 'Min' : kind === 'max' ? 'Max' : 'MaxMag', region)
  }
  void regions
  return out
}

function compare(expected, actual) {
  const problems = []
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key]
    if (got === null || got === undefined) { problems.push(`${key}: missing (expected ${JSON.stringify(want)})`); continue }
    if (typeof want === 'number' && typeof got === 'number') {
      const tol = key in TOL ? TOL[key] : TOL.default
      const scale = Math.max(Math.abs(want), 1e-12)
      const rel = Math.abs(got - want) / scale
      if (rel > tol) problems.push(`${key}: ${got} vs ${want} (${(rel * 100).toFixed(2)}% > ${(tol * 100).toFixed(2)}%)`)
      continue
    }
    if (Array.isArray(want) && Array.isArray(got)) {
      if (want.length !== got.length) { problems.push(`${key}: length ${got.length} vs ${want.length}`); continue }
      for (let i = 0; i < want.length; i++) {
        const scale = Math.max(Math.abs(want[i]), 1e-12)
        const rel = Math.abs(got[i] - want[i]) / scale
        if (rel > TOL.default) problems.push(`${key}[${i}]: ${got[i]} vs ${want[i]} (${(rel * 100).toFixed(2)}%)`)
      }
      continue
    }
    if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`${key}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`)
  }
  return problems
}

async function runCase(cfg, dist, name, spec, opts) {
  if (spec.skip && spec.skip[dist]) return { name, skipped: spec.skip[dist] }
  const workRoot = join(ROOT, 'test/golden/work', dist)
  const caseDir = join(workRoot, name)
  if (existsSync(caseDir)) rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(caseDir, { recursive: true })
  const steps = []
  const record = (step, r) => { steps.push({ step, ok: r.ok, argv: r.argv }); return r }

  if (spec.tutorial) {
    const tutorialRel = spec.tutorial[dist]
    if (!tutorialRel) return { name, skipped: `no tutorial for ${dist}` }
    const src = resolveTutorial(cfg.foamRoots[dist], tutorialRel)
    if (!src) return { name, skipped: `tutorial not found: ${tutorialRel}` }
    copyTutorial(src, caseDir)
    record('copy tutorial', { ok: true, argv: tutorialRel })
    const sharedMesh = spec.blockMeshFrom && spec.blockMeshFrom[dist]
    if (sharedMesh) {
      const srcMesh = join(cfg.foamRoots[dist], 'tutorials', sharedMesh)
      if (!existsSync(srcMesh)) return { name, steps, error: `shared blockMeshDict not found: ${sharedMesh}` }
      mkdirSync(join(caseDir, 'system'), { recursive: true })
      copyFileSync(srcMesh, join(caseDir, 'system', 'blockMeshDict'))
      record('blockMeshFrom', { ok: true, argv: sharedMesh })
    }
    if (spec.controlOverride) {
      const file = join(caseDir, 'system', 'controlDict')
      let text = readTextSafe(file)
      for (const [key, value] of Object.entries(spec.controlOverride)) {
        text = new RegExp(`^${key}\\s+[^;]*;`, 'm').test(text)
          ? text.replace(new RegExp(`^${key}\\s+[^;]*;`, 'm'), `${key} ${value};`)
          : text + `\n${key} ${value};\n`
      }
      writeFileSync(file, text)
      record('controlOverride', { ok: true, argv: JSON.stringify(spec.controlOverride) })
    }
  } else {
    spec.prepare({ caseDir, dist })
    record('prepare', { ok: true, argv: 'case files' })
    if (spec.meshFixture) {
      const src = join(ROOT, 'test/golden/meshes', spec.meshFixture, 'constant')
      if (!existsSync(src)) return { name, skipped: `mesh fixture not found: ${spec.meshFixture}` }
      copyTutorial(src, join(caseDir, 'constant'))
      record('mesh fixture', { ok: true, argv: spec.meshFixture })
    }
  }

  const caps = await probeCaps(bashrcFor(cfg, dist), dist)

  // Mesh first: scaffolds read the patches the mesh creates.
  for (const step of spec.steps || ['blockMesh']) {
    if (step === 'splitMeshRegions') {
      const argv = ['splitMeshRegions', ...caps.splitRegions]
      const r = record(argv.join(' '), await run(cfg, dist, argv, caseDir))
      if (!r.ok) return { name, steps, error: `${argv.join(' ')} failed`, log: r.text.slice(-1500) }
      continue
    }
    const argv = step.split(' ')
    const r = record(step, await run(cfg, dist, argv, caseDir))
    if (!r.ok) return { name, steps, error: `${step} failed`, log: r.text.slice(-1500) }
  }

  if (spec.scaffold) {
    const patches = parseBoundaryPatches(readTextSafe(join(caseDir, 'constant', 'polyMesh', 'boundary')))
      .map((p) => ({ name: p.name, type: p.type }))
    const plan = scaffoldFiles({
      caps,
      distribution: dist,
      patches,
      algorithm: spec.scaffold.algorithm,
      U: spec.scaffold.U,
      p: spec.scaffold.p,
      nu: spec.scaffold.nu,
      endTime: spec.scaffold.endTime,
      deltaT: spec.scaffold.deltaT,
      writeInterval: spec.scaffold.writeInterval,
    })
    for (const [rel, body] of Object.entries(plan.files)) {
      const file = join(caseDir, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
    }
    record('scaffold', { ok: true, argv: `${Object.keys(plan.files).length} files` })
  }

  if (spec.compressible) {
    const patches = parseBoundaryPatches(readTextSafe(join(caseDir, 'constant', 'polyMesh', 'boundary')))
      .map((p) => ({ name: p.name, type: p.type }))
    const plan = scaffoldCompressible({ caps, patches, ...spec.compressible })
    if (!plan.warnings.length === false) record('scaffold warnings', { ok: true, argv: plan.warnings.join('; ') })
    for (const [rel, body] of Object.entries(plan.files)) {
      const file = join(caseDir, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
    }
    record('scaffold compressible', { ok: true, argv: `${Object.keys(plan.files).length} files` })
  }

  if (spec.cht) {
    const regions = caseRegions(caseDir)
    const found = regions.length ? regions : spec.cht.regions.map((r) => r.name)
    const detected = caseRegions(caseDir)
    const resolved = spec.cht.regions.map((r) => {
      if (r.kind === 'solid') return { ...r, name: r.name }
      const other = detected.find((n) => n !== r.name && n !== 'solid')
      return { ...r, name: detected.includes(r.name) ? r.name : (other || r.name) }
    })
    const withPatches = resolved.map((r) => ({
      ...r,
      patches: parseBoundaryPatches(readTextSafe(join(caseDir, 'constant', r.name, 'polyMesh', 'boundary'))),
    }))
    const { regions: _ignoredRegions, ...chtOptions } = spec.cht
    const plan = scaffoldCht({ caps, regions: withPatches, ...chtOptions })
    if (!plan.ok) return { name, steps, error: plan.error }
    for (const [rel, body] of Object.entries(plan.files)) {
      const file = join(caseDir, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
    }
    record('scaffold cht', { ok: true, argv: `${Object.keys(plan.files).length} files` })
    void found
  }

  if (typeof spec.afterScaffold === 'function') spec.afterScaffold({ caseDir, dist, caps })

  const cmd = solverCommand(caseDir)
  const solver = record(cmd, await run(cfg, dist, [cmd], caseDir))
  if (!solver.ok) return { name, steps, error: `${cmd} failed`, log: solver.text.slice(-2000) }

  const check = await run(cfg, dist, ['checkMesh'], caseDir)
  record('checkMesh', check)
  const qoi = await collectQoi(cfg, dist, caseDir, spec.qoi, check.text, solver.text, caseRegions(caseDir))
  return { name, steps, qoi, dir: caseDir }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('usage: run-golden.mjs [--case name] [--distribution org|com] [--update] [--json] [--keep]')
    return 0
  }
  const cfg = makeCfg()
  const known = Object.keys(cfg.foamRoots)
  if (args.distributions.length) {
    const missing = args.distributions.filter((d) => !known.includes(d))
    if (missing.length) {
      console.error(`no OpenFOAM installation found for: ${missing.join(', ')} (discovered: ${known.join(', ') || 'none'})`)
      return 2
    }
  }
  const dists = args.distributions.length ? args.distributions : known
  if (!dists.length) {
    console.error('no OpenFOAM installation discovered; set WM_PROJECT_DIR or install one')
    return 2
  }
  const names = args.cases.length ? args.cases : Object.keys(CASES)
  let failed = 0
  for (const dist of dists) {
    const expectedPath = join(ROOT, 'test/golden/expected', `${dist}.json`)
    const expected = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : {}
    for (const name of names) {
      const spec = CASES[name]
      if (!spec) throw new Error(`unknown case: ${name}`)
      process.stdout.write(`\n[${dist}] ${name} — ${spec.title}\n`)
      const res = await runCase(cfg, dist, name, spec, args)
      if (res.skipped) { console.log(`  skipped: ${res.skipped}`); continue }
      if (res.error) {
        failed++
        console.log(`  FAILED: ${res.error}`)
        if (res.log) console.log(res.log.split('\n').slice(-6).join('\n'))
        continue
      }
      const want = expected[name] || {}
      if (args.update) {
        expected[name] = res.qoi
        console.log(`  blessed: ${JSON.stringify(res.qoi)}`)
      } else if (!Object.keys(want).length) {
        failed++
        console.log(`  FAILED: no reference values for ${name} (run with --update once, then commit)`)
      } else {
        const problems = compare(want, res.qoi)
        if (problems.length) { failed++; console.log('  FAILED'); for (const p of problems) console.log('   - ' + p) }
        else console.log('  ok')
      }
      if (args.json) console.log(JSON.stringify({ distribution: dist, case: name, qoi: res.qoi }))
      if (!args.keep && existsSync(res.dir)) rmSync(res.dir, { recursive: true, force: true })
    }
    if (args.update) {
      mkdirSync(dirname(expectedPath), { recursive: true })
      writeFileSync(expectedPath, JSON.stringify(expected, null, 2) + '\n')
      console.log(`\nwrote ${expectedPath}`)
    }
  }
  return failed ? 1 : 0
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2) })
