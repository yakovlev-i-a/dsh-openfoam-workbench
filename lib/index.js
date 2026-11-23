// dsh-openfoam-workbench — OpenFOAM domain layer for DeepSeek Harness.
// Phase 1: thin core prompt section + read-only inspect tools.
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, cpSync, renameSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs'
import { join, resolve, isAbsolute, sep, basename, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  checkCase as checkCaseEngine,
  checkControlDict,
  checkFvSchemes,
  checkFvSolution,
  checkBlockMeshDict,
  checkStrayTimes,
  checkBoundaryFields,
  readCaseDict,
  fieldFiles,
  strayTimeDirs,
  parseCheckMesh,
  parseRunLog,
  CASE_FILES,
} from './of-engine.js'

export const name = 'openfoam-workbench'
export const inject = ['tools', 'systemPrompt', 'skills']

const DEFAULTS = {
  foamRoot: '',
  openfoamBash: '',
  paraviewExe: '',
  paraviewPython: '',
  pythonPath: '',
  caseRoots: [],
}

function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function run(cmd, args, { signal, timeoutMs = 30000 } = {}) {
  return new Promise((res) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; res(v) } }
    let child
    try {
      child = execFile(cmd, args, { timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        done({
          ok: !err,
          code: err && typeof err.code === 'number' ? err.code : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? String((err && err.message) || err) : null,
          killed: !!(err && err.killed),
          signal: err && err.signal ? String(err.signal) : null,
        })
      })
    } catch (e) {
      done({ ok: false, code: -1, stdout: '', stderr: '', error: String((e && e.message) || e) })
      return
    }
    child.on('error', (e) => done({ ok: false, code: -1, stdout: '', stderr: '', error: String((e && e.message) || e) }))
  })
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function dictEntry(text, key) {
  const re = new RegExp('\\b' + key + '\\b\\s+([^;]+);')
  const m = stripComments(text).match(re)
  return m ? m[1].trim() : null
}

function resolveCase(cfg, p) {
  if (!p) return ''
  if (isAbsolute(p)) return p
  const roots = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots : [process.cwd()]
  return resolve(roots[0], p)
}

function bashrcOf(cfg) {
  if (cfg.openfoamBash) return cfg.openfoamBash
  if (cfg.foamRoot) return join(cfg.foamRoot, 'etc/bashrc')
  return ''
}

function validateConfig(cfg) {
  const warnings = []
  if (cfg.foamRoot && !existsSync(cfg.foamRoot)) warnings.push('foamRoot does not exist: ' + cfg.foamRoot)
  const bash = bashrcOf(cfg)
  if (bash && !existsSync(bash)) warnings.push('openfoamBash does not exist: ' + bash)
  if (cfg.pythonPath && !existsSync(cfg.pythonPath)) warnings.push('pythonPath does not exist: ' + cfg.pythonPath)
  if (cfg.paraviewPython && !existsSync(cfg.paraviewPython)) warnings.push('paraviewPython does not exist: ' + cfg.paraviewPython)
  if (cfg.caseRoots && !Array.isArray(cfg.caseRoots)) warnings.push('caseRoots must be an array of paths')
  return warnings
}

const CMD_WHITELIST =
  /^(blockMesh|checkMesh|snappyHexMesh|foamRun|simpleFoam|pimpleFoam|icoFoam|buoyantFoam|reactingFoam|multicomponentFluid|decomposePar|reconstructPar|foamToVTK|postProcess|setFields|topoSet|createPatch|renumberMesh|potentialFoam)\b/

function commandOk(cmd) {
  const c = String(cmd || '').trim()
  if (!c || /[;&|`$(){}<>\n\r]/.test(c)) return false
  return CMD_WHITELIST.test(c)
}

function sourceRoots(cfg) {
  const roots = []
  if (Array.isArray(cfg.allowedReadRoots)) roots.push(...cfg.allowedReadRoots)
  if (cfg.foamRoot) {
    roots.push(join(cfg.foamRoot, 'src'), join(cfg.foamRoot, 'applications'), join(cfg.foamRoot, 'etc', 'codeTemplates'))
  }
  return roots
}

function resolveSource(cfg, p) {
  const roots = sourceRoots(cfg).map((r) => resolve(r))
  if (!roots.length) return { ok: false, error: 'no source roots configured (set foamRoot)' }
  const abs = isAbsolute(p) ? resolve(p) : resolve(roots[0], p)
  const ok = roots.some((r) => abs === r || abs.startsWith(r + sep))
  return ok ? { ok: true, path: abs } : { ok: false, error: `outside allowed source roots: ${abs}` }
}

function walk(root, onFile, maxFiles = 50000) {
  let n = 0
  const stack = [root]
  while (stack.length && n < maxFiles) {
    const d = stack.pop()
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        n++
        if (onFile(p) === false) return
      }
    }
  }
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SKILLS_DIR = join(HERE, '..', 'skills')

function parseSkillMd(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) return null
  const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]
  const description = (m[1].match(/^description:\s*(.+)$/m) || [])[1]
  if (!name || !description) return null
  return {
    name: name.trim().replace(/^["']|["']$/g, ''),
    description: description.trim().replace(/^["']|["']$/g, ''),
    content: m[2].trim(),
  }
}

// --- durable run registry (files are the source of truth) ---
const STALL_MS = 10 * 60 * 1000

function runsDirOf(cfg) {
  if (cfg.runsDir) return cfg.runsDir
  const root = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()
  return join(root, '.openfoam-runs')
}

function ensureRunsDir(cfg) {
  const d = runsDirOf(cfg)
  mkdirSync(d, { recursive: true })
  return d
}

function runJsonPath(cfg, id) { return join(runsDirOf(cfg), id + '.json') }
function runLogPath(cfg, id) { return join(runsDirOf(cfg), id + '.log') }

function readRun(cfg, id) {
  try { return JSON.parse(readFileSync(runJsonPath(cfg, id), 'utf8')) } catch { return null }
}
function writeRun(cfg, run) {
  const p = runJsonPath(cfg, run.id)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(run, null, 2))
  renameSync(tmp, p)
}
function listRunIds(cfg) {
  try { return readdirSync(runsDirOf(cfg)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) } catch { return [] }
}
function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
function logTailFile(cfg, id, n = 4000) {
  try { return readFileSync(runLogPath(cfg, id), 'utf8').slice(-n) } catch { return '' }
}
function logMtime(cfg, id) {
  try { return statSync(runLogPath(cfg, id)).mtimeMs } catch { return 0 }
}
function logFinished(cfg, id) {
  const t = logTailFile(cfg, id, 16000)
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return lines.length > 0 && lines[lines.length - 1] === 'End'
}

// Reconcile the on-disk registry after a restart: a run whose pid is gone, or whose
// log reached `End` while we were not watching, is settled here.
function reconcileAll(cfg) {
  for (const id of listRunIds(cfg)) {
    const r = readRun(cfg, id)
    if (!r || r.status !== 'running') continue
    if (logFinished(cfg, id)) {
      r.status = 'success'
      r.endedAt = logMtime(cfg, id) || Date.now()
    } else if (!pidAlive(r.pid)) {
      r.status = 'interrupted'
      r.endedAt = logMtime(cfg, id) || Date.now()
    }
    try { writeRun(cfg, r) } catch {}
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function readMakeFiles(modulePath) {
  const text = readText(join(modulePath, 'Make/files')) || ''
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean)
  const isLib = /^\s*LIB\s*=/m.test(text)
  const mainSource = lines.find((l) => /\.C$/.test(l) && !/^\s*(LIB|EXE)\s*=/.test(l)) || null
  const targetMatch = text.match(/^\s*(EXE|LIB)\s*=\s*(\S+)/m)
  return { text, isLib, mainSource, target: targetMatch ? targetMatch[2] : null }
}

function firstError(log) {
  const lines = String(log || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/(^|\s)(error|Error):|\bundefined reference\b|make: \*\*\*|Error \d+/.test(lines[i])) {
      return lines.slice(Math.max(0, i - 2), i + 2).join('\n')
    }
  }
  return null
}

function inspectSolverModule(modulePath) {
  const make = readMakeFiles(modulePath)
  const main = make.mainSource ? join(modulePath, make.mainSource) : null
  const code = main ? (readText(main) || '') : ''
  const header = readText(join(modulePath, 'createFields.H')) || ''
  const fields = []
  const fre = /(volScalarField|volVectorField|volTensorField|volSymmTensorField|surfaceScalarField|surfaceVectorField)\s+(\w+)/g
  let m
  while ((m = fre.exec(header)) && fields.length < 60) fields.push({ name: m[2], type: m[1] })
  const includes = []
  const ire = /#include\s+"([^"]+)"/g
  while ((m = ire.exec(code)) && includes.length < 60) includes.push(m[1])
  const loop = ['UEqn', 'pEqn', 'rhoU', 'rhoE', 'simpleControl', 'pimpleControl', 'pisoControl', 'CorrectPhi', 'fvModels', 'fvConstraints', 'thermophysicalTransport'].filter((k) => code.includes(k))
  const risks = []
  if (!make.target) risks.push('Make/files has no EXE/LIB target')
  if (!make.mainSource) risks.push('Make/files has no .C source')
  if (make.target && make.target.includes('$(FOAM_APPBIN)')) risks.push('EXE points at the system install; use $(FOAM_USER_APPBIN)')
  if (code && !/simpleControl|pimpleControl|pisoControl/.test(code)) risks.push('no simple/pimple/piso control header detected')
  return { make, fields, includes, loop, risks }
}

function startSolverRun(cfg, dir, command, bash) {
  ensureRunsDir(cfg)
  const id = 'run' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const log = runLogPath(cfg, id)
  const child = spawn('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; { cd "${dir}" && exec ${command}; } > "${log}" 2>&1`], {
    detached: true,
    stdio: 'ignore',
  })
  const run = { id, casePath: dir, command, pid: child.pid, startedAt: Date.now(), status: 'running', log }
  writeRun(cfg, run)
  child.unref()
  return run
}

function runSnapshot(cfg, id) {
  const r = readRun(cfg, id)
  if (!r) return null
  let status = r.status
  const alive = pidAlive(r.pid)
  const tail = logTailFile(cfg, id)
  if (status === 'running') {
    if (logFinished(cfg, id)) { status = 'success'; r.endedAt = logMtime(cfg, id) || Date.now() }
    else if (!alive) { status = 'interrupted'; r.endedAt = logMtime(cfg, id) || Date.now() }
    else {
      const mtime = logMtime(cfg, id)
      if (mtime && Date.now() - mtime > STALL_MS) status = 'stalled'
    }
  } else if (status === 'stopping') {
    if (!alive) { status = 'stopped'; r.endedAt = Date.now() }
  }
  if (status !== r.status) { r.status = status; try { writeRun(cfg, r) } catch {} }
  const times = [...tail.matchAll(/^Time\s*=\s*([0-9.eE+-]+)/gm)].map((x) => x[1])
  const endedAt = status === 'running' || status === 'stalled' ? Date.now() : (r.endedAt || Date.now())
  return {
    runId: id,
    casePath: r.casePath,
    command: r.command,
    status,
    running: status === 'running' || status === 'stalled',
    pid: r.pid,
    startedAt: r.startedAt,
    durationMs: endedAt - r.startedAt,
    lastTime: times.length ? times[times.length - 1] : null,
    logTail: tail,
  }
}

function stopRun(cfg, id) {
  const r = readRun(cfg, id)
  if (!r) return { ok: false, error: 'no such run: ' + id }
  if (!pidAlive(r.pid)) {
    const snap = runSnapshot(cfg, id)
    return { ok: true, runId: id, alreadyEnded: true, status: snap && snap.status }
  }
  try { process.kill(r.pid, 'SIGTERM') } catch {}
  setTimeout(() => { try { process.kill(r.pid, 'SIGKILL') } catch {} }, 3000)
  r.status = 'stopping'
  try { writeRun(cfg, r) } catch {}
  return { ok: true, runId: id, stopped: true }
}

// --- geometry helpers ---
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

function parseBoundaryPatches(text) {
  const patches = []
  const re = /(\w+)\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(String(text)))) {
    const name = m[1]
    const block = m[2]
    const type = (block.match(/type\s+(\w+)\s*;/) || [])[1] || null
    if (!type) continue
    const nFaces = (block.match(/nFaces\s+(\d+)\s*;/) || [])[1] || null
    const startFace = (block.match(/startFace\s+(\d+)\s*;/) || [])[1] || null
    patches.push({ name, type, nFaces: nFaces ? Number(nFaces) : null, startFace: startFace ? Number(startFace) : null })
  }
  return patches
}

function computeFirstLayer({ U_ref, L_ref, nu = 1.5e-5, y_plus_target = 1, expansion_ratio = 1.2, coverage = 0.7 }) {
  const U = Number(U_ref)
  const L = Number(L_ref)
  if (!(U > 0) || !(L > 0)) return { ok: false, error: 'U_ref and L_ref must be positive' }
  const nuV = Number(nu) > 0 ? Number(nu) : 1.5e-5
  const yp = Number(y_plus_target) > 0 ? Number(y_plus_target) : 1
  const r = Number(expansion_ratio) > 1 ? Number(expansion_ratio) : 1.2
  const cov = Math.min(Math.max(Number(coverage) || 0.7, 0.1), 1)
  const Re = (U * L) / nuV
  const Cf = 0.026 * Math.pow(Re, -1 / 7)
  const uTau = U * Math.sqrt(Cf / 2)
  const firstLayer = (yp * nuV) / uTau
  const delta = 0.37 * L * Math.pow(Re, -0.2)
  const total = cov * delta
  const n = Math.max(1, Math.ceil(Math.log(1 + (total * (r - 1)) / firstLayer) / Math.log(r)))
  const totalThickness = (firstLayer * (Math.pow(r, n) - 1)) / (r - 1)
  return { ok: true, Re, Cf, uTau, delta, first_layer_thickness: firstLayer, n_layers: n, expansion_ratio: r, total_thickness: totalThickness }
}

function parseStlTris(file) {
  const buf = readFileSync(file)
  let isBinary = false
  let count = 0
  if (buf.length >= 84) {
    const c = buf.readUInt32LE(80)
    if (c > 0 && buf.length === 84 + c * 50) { isBinary = true; count = c }
  }
  const tris = []
  if (isBinary) {
    for (let i = 0; i < count; i++) {
      const off = 84 + i * 50
      const t = []
      for (let k = 0; k < 3; k++) {
        const o = off + 12 + k * 12
        t.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)])
      }
      tris.push(t)
    }
  } else {
    const text = buf.toString('utf8')
    const vre = /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g
    let m
    const vs = []
    while ((m = vre.exec(text))) vs.push([+m[1], +m[2], +m[3]])
    for (let i = 0; i + 2 < vs.length; i += 3) tris.push([vs[i], vs[i + 1], vs[i + 2]])
  }
  return { isBinary, tris }
}

function inspectStl(file) {
  const { isBinary, tris } = parseStlTris(file)
  if (!tris.length) return { ok: false, error: 'no triangles parsed (not an STL?)' }
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  let area = 0
  let vol = 0
  let nv = 0
  const ctr = [0, 0, 0]
  for (const t of tris) {
    for (const v of t) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < mn[k]) mn[k] = v[k]
        if (v[k] > mx[k]) mx[k] = v[k]
        ctr[k] += v[k]
      }
      nv++
    }
    const cr = vcross(vsub(t[1], t[0]), vsub(t[2], t[0]))
    area += 0.5 * Math.hypot(cr[0], cr[1], cr[2])
    vol += (t[0][0] * (t[1][1] * t[2][2] - t[1][2] * t[2][1]) - t[0][1] * (t[1][0] * t[2][2] - t[1][2] * t[2][0]) + t[0][2] * (t[1][0] * t[2][1] - t[1][1] * t[2][0])) / 6
  }
  for (let k = 0; k < 3; k++) ctr[k] /= nv
  let watertight = null
  let openEdges = null
  if (tris.length <= 200000) {
    const edge = new Map()
    const key = (a, b) => {
      const k1 = a.map((x) => Math.round(x * 1e6)).join(',')
      const k2 = b.map((x) => Math.round(x * 1e6)).join(',')
      return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1
    }
    for (const t of tris) {
      for (let i = 0; i < 3; i++) {
        const k = key(t[i], t[(i + 1) % 3])
        edge.set(k, (edge.get(k) || 0) + 1)
      }
    }
    openEdges = 0
    for (const c of edge.values()) if (c !== 2) openEdges++
    watertight = openEdges === 0
  }
  return { ok: true, format: isBinary ? 'binary' : 'ascii', triangles: tris.length, bbox: { min: mn, max: mx }, centroid: ctr, volume: Math.abs(vol), area, watertight, open_edges: openEdges }
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function closestPtTriangle(p, a, b, c) {
  const ab = vsub(b, a), ac = vsub(c, a), ap = vsub(p, a)
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = vsub(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]] }
  const cp = vsub(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])] }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w = vc * denom
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

// Symmetric max over sampled triangle centroids of the nearest-distance to the other mesh.
function hausdorffApprox(fromTris, toTris, maxSamples = 2000) {
  if (!fromTris.length || !toTris.length) return null
  const step = Math.max(1, Math.ceil(fromTris.length / maxSamples))
  let worst = 0
  for (let i = 0; i < fromTris.length; i += step) {
    const t = fromTris[i]
    const p = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]
    let best = Infinity
    for (const u of toTris) {
      const q = closestPtTriangle(p, u[0], u[1], u[2])
      const dd = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
      if (dd < best) best = dd
    }
    if (best > worst) worst = best
  }
  return worst
}

function stlBoxTriangles(mn, mx) {
  const [x0, y0, z0] = mn
  const [x1, y1, z1] = mx
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
  const quads = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
    [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]],
  ]
  const tris = []
  for (const q of quads) {
    const n = vcross(vsub(q[1], q[0]), vsub(q[2], q[0]))
    const fc = q.reduce((a, v) => [a[0] + v[0] / 4, a[1] + v[1] / 4, a[2] + v[2] / 4], [0, 0, 0])
    const out = [fc[0] - c[0], fc[1] - c[1], fc[2] - c[2]]
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) q.reverse()
    tris.push([q[0], q[1], q[2]])
    tris.push([q[0], q[2], q[3]])
  }
  return tris
}

function stlToAscii(name, tris) {
  const lines = ['solid ' + name]
  for (const t of tris) {
    const n = vcross(vsub(t[1], t[0]), vsub(t[2], t[0]))
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    lines.push(`  facet normal ${n[0] / len} ${n[1] / len} ${n[2] / len}`, '    outer loop')
    for (const v of t) lines.push(`      vertex ${v[0]} ${v[1]} ${v[2]}`)
    lines.push('    endloop', '  endfacet')
  }
  lines.push('endsolid ' + name)
  return lines.join('\n') + '\n'
}

// --- primitive STL generators ---
function ring(r, z, sections) {
  return Array.from({ length: sections }, (_, j) => {
    const a = (j / sections) * 2 * Math.PI
    return [r * Math.cos(a), r * Math.sin(a), z]
  })
}

function primBox(lx, ly, lz) {
  return stlBoxTriangles([-lx / 2, -ly / 2, -lz / 2], [lx / 2, ly / 2, lz / 2])
}

function primSphere(r, segments = 32, rings = 16) {
  const tris = []
  const vert = (i, j) => {
    const th = (i / rings) * Math.PI
    const ph = (j / segments) * 2 * Math.PI
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = vert(i, j)
      const b = vert(i, j + 1)
      const c = vert(i + 1, j + 1)
      const d = vert(i + 1, j)
      tris.push([a, b, c], [a, c, d])
    }
  }
  return tris.filter((t) => area2(t) > 1e-18)
}

const area2 = (t) => {
  const cr = vcross(vsub(t[1], t[0]), vsub(t[2], t[0]))
  return Math.hypot(cr[0], cr[1], cr[2])
}

function primCylinder(r, h, sections = 32, rInner = 0) {
  const tris = []
  const z0 = -h / 2
  const z1 = h / 2
  const o0 = ring(r, z0, sections)
  const o1 = ring(r, z1, sections)
  for (let j = 0; j < sections; j++) {
    const j2 = (j + 1) % sections
    tris.push([o0[j], o1[j], o1[j2]], [o0[j], o1[j2], o0[j2]])
  }
  if (rInner > 0) {
    const i0 = ring(rInner, z0, sections)
    const i1 = ring(rInner, z1, sections)
    for (let j = 0; j < sections; j++) {
      const j2 = (j + 1) % sections
      tris.push([i0[j], i1[j2], i1[j]], [i0[j], i0[j2], i1[j2]])
      tris.push([o0[j], i0[j], i0[j2]], [o0[j], i0[j2], o0[j2]])
      tris.push([o1[j], o1[j2], i1[j2]], [o1[j], i1[j2], i1[j]])
    }
  } else {
    const c0 = [0, 0, z0]
    const c1 = [0, 0, z1]
    for (let j = 0; j < sections; j++) {
      const j2 = (j + 1) % sections
      tris.push([c0, o0[j2], o0[j]], [c1, o1[j], o1[j2]])
    }
  }
  return tris
}

function primCone(r, h, sections = 32) {
  const tris = []
  const z0 = -h / 2
  const base = ring(r, z0, sections)
  const apex = [0, 0, h / 2]
  for (let j = 0; j < sections; j++) {
    const j2 = (j + 1) % sections
    tris.push([base[j], base[j2], apex], [[0, 0, z0], base[j2], base[j]])
  }
  return tris
}

function makePrimitive(shape, p = {}) {
  const s = String(shape)
  if (s === 'box') return primBox(Number(p.lx), Number(p.ly), Number(p.lz))
  if (s === 'sphere') return primSphere(Number(p.r), Number(p.segments) || 32, Number(p.rings) || 16)
  if (s === 'cylinder') return primCylinder(Number(p.r), Number(p.h), Number(p.sections) || 32)
  if (s === 'pipe') return primCylinder(Number(p.r_outer), Number(p.h), Number(p.sections) || 32, Number(p.r_inner))
  if (s === 'cone') return primCone(Number(p.r), Number(p.h), Number(p.sections) || 32)
  throw new Error('unsupported shape: ' + s)
}

function transformTris(tris, translate = [0, 0, 0], rotateDeg = [0, 0, 0], scale = 1) {
  const [rx, ry, rz] = rotateDeg.map((d) => (d * Math.PI) / 180)
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  const sc = Number(scale) || 1
  return tris.map((t) =>
    t.map((v) => {
      let [x, y, z] = v.map((c) => c * sc)
      const y1 = y * cx - z * sx
      const z1 = y * sx + z * cx
      const x1 = x * cy + z1 * sy
      const z2 = -x * sy + z1 * cy
      const x2 = x1 * cz - y1 * sz
      const y2 = x1 * sz + y1 * cz
      return [x2 + translate[0], y2 + translate[1], z2 + translate[2]]
    }),
  )
}

function stlGenerate(spec = {}) {
  let tris = []
  if (Array.isArray(spec.parts) && spec.parts.length) {
    for (const part of spec.parts) {
      const pt = makePrimitive(part.shape, part.params || {})
      tris.push(...transformTris(pt, part.translate || [0, 0, 0], part.rotate_deg || [0, 0, 0]))
    }
  } else {
    tris = makePrimitive(spec.shape, spec.params || {})
  }
  tris = transformTris(tris, spec.translate || [0, 0, 0], spec.rotate_deg || [0, 0, 0], spec.scale || 1)
  return tris
}

// --- mesh plan dictionaries ---
function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(8)))
}

function planMesh(cfg, args) {
  const stlPath = resolveCase(cfg, args.stl_path)
  if (!stlPath || !existsSync(stlPath)) return { ok: false, error: 'stl not found: ' + stlPath }
  const info = inspectStl(stlPath)
  if (!info.ok) return info
  const mn = info.bbox.min
  const mx = info.bbox.max
  const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
  const L = Math.max(size[0], size[1], size[2]) || 1
  const cell = Number(args.target_cell_size) > 0 ? Number(args.target_cell_size) : L / 30
  const domain = args.domain || { type: 'wrap' }
  let dmn = [mn[0], mn[1], mn[2]]
  let dmx = [mx[0], mx[1], mx[2]]
  const type = domain.type || 'wrap'
  if (type === 'box') {
    if (!Array.isArray(domain.bbox_min) || !Array.isArray(domain.bbox_max)) return { ok: false, error: 'box domain needs bbox_min/bbox_max' }
    dmn = domain.bbox_min.map(Number)
    dmx = domain.bbox_max.map(Number)
  } else if (type === 'external') {
    const up = Number(domain.upstream) > 0 ? Number(domain.upstream) : 3
    const down = Number(domain.downstream) > 0 ? Number(domain.downstream) : 5
    const lat = Number(domain.lateral) > 0 ? Number(domain.lateral) : 3
    const vt = Number(domain.vertical_top) > 0 ? Number(domain.vertical_top) : 3
    const vb = Number(domain.vertical_bottom) > 0 ? Number(domain.vertical_bottom) : 3
    dmn = [mn[0] - up * L, mn[1] - lat * L, mn[2] - vb * L]
    dmx = [mx[0] + down * L, mx[1] + lat * L, mx[2] + vt * L]
  } else if (type === 'internal') {
    dmn = [mn[0], mn[1], mn[2]]
    dmx = [mx[0], mx[1], mx[2]]
  } else {
    const m = 0.1 * L
    dmn = [mn[0] - m, mn[1] - m, mn[2] - m]
    dmx = [mx[0] + m, mx[1] + m, mx[2] + m]
  }
  const nx = Math.max(1, Math.round((dmx[0] - dmn[0]) / cell))
  const ny = Math.max(1, Math.round((dmx[1] - dmn[1]) / cell))
  const nz = Math.max(1, Math.round((dmx[2] - dmn[2]) / cell))
  const v = [
    [dmn[0], dmn[1], dmn[2]], [dmx[0], dmn[1], dmn[2]], [dmx[0], dmx[1], dmn[2]], [dmn[0], dmx[1], dmn[2]],
    [dmn[0], dmn[1], dmx[2]], [dmx[0], dmn[1], dmx[2]], [dmx[0], dmx[1], dmx[2]], [dmn[0], dmx[1], dmx[2]],
  ]
  const name = basename(stlPath).replace(/\.stl$/i, '') || 'geometry'
  const header = (cls, obj) => `FoamFile\n{\n    format      ascii;\n    class       ${cls};\n    object      ${obj};\n}\n`
  const blockMesh = header('dictionary', 'blockMeshDict') + `\nscale 1;\n\nvertices\n(\n${v.map((p) => `    (${p.map(fmt).join(' ')})`).join('\n')}\n);\n\nblocks\n(\n    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1)\n);\n\nboundary\n(\n    inlet\n    {\n        type patch;\n        faces ((0 4 7 3));\n    }\n    outlet\n    {\n        type patch;\n        faces ((1 2 6 5));\n    }\n    walls\n    {\n        type wall;\n        faces ((0 1 5 4) (3 2 6 7) (0 1 2 3) (4 5 6 7));\n    }\n);\n`
  const loc = Array.isArray(args.location_in_mesh) && args.location_in_mesh.length === 3
    ? args.location_in_mesh.map(Number)
    : type === 'internal'
      ? [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2]
      : [dmn[0] + 0.05 * (dmx[0] - dmn[0]), (dmn[1] + dmx[1]) / 2, (dmn[2] + dmx[2]) / 2]
  const refMin = Number(args.refinement_level_min) || 1
  const refMax = Number(args.refinement_level_max) || 3
  const feat = Number(args.feature_level) || refMax
  const nLayers = Number(args.n_layers) || 0
  const firstLayer = Number(args.first_layer_thickness) || 0
  const expRatio = Number(args.expansion_ratio) || 1.2
  const snappy = header('dictionary', 'snappyHexMeshDict') + `\ncastellatedMesh true;\nsnap true;\naddLayers ${nLayers > 0 ? 'true' : 'false'};\n\ngeometry\n{\n    ${name}\n    {\n        type triSurfaceMesh;\n        file "${name}.stl";\n    }\n}\n\ncastellatedMeshControls\n{\n    maxLocalCells 1000000;\n    maxGlobalCells 8000000;\n    minRefinementCells 10;\n    nCellsBetweenLevels 5;\n    features\n    (\n        {\n            file "${name}.eMesh";\n            level ${feat};\n        }\n    )\n    refinementSurfaces\n    {\n        ${name}\n        {\n            level (${refMin} ${refMax});\n            patchInfo\n            {\n                type wall;\n            }\n        }\n    }\n    resolveFeatureAngle 30;\n    refinementRegions\n    {\n    }\n    locationInMesh (${loc.map(fmt).join(' ')});\n    allowFreeStandingZoneFaces true;\n}\n\nsnapControls\n{\n    nSmoothPatch 3;\n    tolerance 2.0;\n    nSolveIter 30;\n    nRelaxIter 5;\n}\n\naddLayersControls\n{\n    relativeSizes false;\n    layers\n    {\n        ${name}\n        {\n            nSurfaceLayers ${nLayers};\n        }\n    }\n    expansionRatio ${expRatio};\n    ${firstLayer > 0 ? `firstLayerThickness ${firstLayer};` : 'firstLayerThickness 0.001;'}\n    minThickness 1e-6;\n    nGrow 0;\n    featureAngle 30;\n}\n\nmeshQualityControls\n{\n    maxNonOrtho 65;\n    maxBoundarySkewness 20;\n    maxInternalSkewness 4;\n    maxConcave 80;\n    minVol 1e-13;\n    minTetQuality 1e-15;\n    minArea -1;\n    minTwist 0.02;\n    minDeterminant 0.001;\n    minFaceWeight 0.05;\n    minVolRatio 0.01;\n    minTriangleTwist -1;\n}\n\ndebug 0;\nmergeTolerance 1e-6;\n`
  const featureDict = header('dictionary', 'surfaceFeatureExtractDict') + `\nsurfaces\n(\n    "${name}.stl"\n    {\n        extractionMethod extractFromSurface;\n        includedAngle 150;\n    }\n);\n`
  return { ok: true, stl: stlPath, name, bbox: { min: mn, max: mx }, domain: { type, min: dmn, max: dmx }, cells: [nx, ny, nz], target_cell_size: cell, blockMeshDict: blockMesh, snappyHexMeshDict: snappy, surfaceFeatureExtractDict: featureDict }
}

// --- diagnostics + four-step + experience store ---
const ERROR_PATTERNS = [
  { re: /floating point exception|FOAM FATAL ERROR.*FPE|signal\s+FPE/i, category: 'NaN/Inf numerical divergence (FPE)', causes: ['CFL too large -> reduce dt or use adaptive deltaT', 'inconsistent BCs cause a division by zero at t=0', '0/ was not setFields-ed, alpha/T are still default', 'a property is zero (e.g. mu=0, sigma=0)'], steps: ['openfoam_solver_status to find the first nan/Inf step', 'openfoam_residual_series to see which field diverges first', 'openfoam_case_probe_facts to confirm properties', 'openfoam_inspect_case to check dimensions/internalField'] },
  { re: /Cannot find file.*system\/(controlDict|fvSchemes|fvSolution|blockMeshDict)/i, category: 'missing system/ dictionary', causes: ['the case is incomplete', 'the cwd is not the case directory'], steps: ['openfoam_inspect_case to verify system/', 'check the cwd'] },
  { re: /keyword (\w+) is undefined in dictionary/i, category: 'missing or misspelled dictionary keyword', causes: ['template and solver versions do not match', 'a required entry is missing', 'the keyword was renamed in this OpenFOAM version'], steps: ['openfoam_find_tutorial for a template of the same solver', 'openfoam_read_dict for the accepted keys'] },
  { re: /unknown patch type|Unknown patchField type|unknown boundary condition/i, category: 'BC / patch type not registered', causes: ['BC name misspelled', 'the required lib is not linked in controlDict.libs', 'the solver does not support that BC'], steps: ['openfoam_find_source for the correct spelling', 'add libs ("...") in controlDict', 'openfoam_case_probe_facts for the BCs the solver supports'] },
  { re: /dimensions of .* are not (correct|consistent|dimensionally)/i, category: 'inconsistent dimensions', causes: ['wrong dimensions in 0/ (k = [0 2 -2 0 0 0 0])', 'the BC value has wrong units', '0/ out of sync with 0.orig/'], steps: ['read the dimensions line of the failing field', 'openfoam_algo_extract_contract for the paper units', 're-copy from 0.orig'] },
  { re: /Maximum number of iterations exceeded.*GAMG|smoothSolver.*did not converge|PCG.*did not converge/i, category: 'linear solver did not converge', causes: ['poor mesh quality, maxNonOrtho > 70', 'tolerance/relTol too strict', 'wrong smoother'], steps: ['openfoam_mesh_verify for maxNonOrtho/skewness', 'tune fvSolution: loosen tolerance / GaussSeidel / DIC'] },
  { re: /Inconsistent\s+addressing|negative volume|negative determinant|skewness exceeds/i, category: 'bad mesh cells', causes: ['snappyHexMesh carved out a region', 'thin sliver cells', 'the STL normals are inverted'], steps: ['openfoam_mesh_verify', 'openfoam_mesh_stl_check', 'raise minVol / reduce first_layer_thickness'] },
  { re: /Cannot find cellSet|Cannot find cellZone/i, category: 'setFields region selector matched nothing', causes: ['the boxToCell bbox extends beyond the mesh', 'cellSet/cellZone name misspelled', 'setSet/topoSet was not run'], steps: ['shrink the setFieldsDict bbox to the mesh extent', 'run topoSet/setFields'] },
  { re: /Maximum number of nonlinear iterations|Continuity error/i, category: 'continuity / p-U coupling imbalance', causes: ['not enough PIMPLE nOuterCorrectors', 'inlet/outlet do not conserve mass', 'wrong atmosphere BC type'], steps: ['raise nOuterCorrectors to 3-5', 'openfoam_case_probe_facts to check patch pairing'] },
  { re: /undefined reference to|error: .*was not declared|fatal error: .*\.H: No such file/i, category: 'C++ compile error', causes: ['header path missing from EXE_INC', 'library missing from LIB_LIBS', 'an inherited virtual function is not implemented'], steps: ['openfoam_dry_compile to catch the first error', 'read Make/options for -I and -l', 'openfoam_find_source for a reference'] },
  { re: /signal\s+(11|SIGSEGV)|segmentation fault/i, category: 'SegFault', causes: ['out-of-bounds container access', 'inconsistent parallel decomposition', 'an unregistered scheme name'], steps: ['rerun serially', 'validate every scheme name in fvSchemes'] },
  { re: /not in patches|patches do not match|patches don't match/i, category: 'patch name mismatch', causes: ['patch names in 0/ != polyMesh/boundary', '0/ was not updated after blockMesh regenerated the mesh'], steps: ['openfoam_inspect_case to list actual patches', 'align boundaryField in every 0/ field'] },
  { re: /Time step continuity errors.*sum local = [\d.eE+-]+, global = [\d.eE+-]+, cumulative/i, category: 'mass conservation drift', causes: ['inlet/outlet fluxes are unbalanced', 'wrong p BC type'], steps: ['openfoam_case_probe_facts for inlet/outlet pairing', 'openfoam_inspect_case for boundaryField of 0/p'] },
  { re: /No such file or directory/i, category: 'file not found', causes: ['wrong path', 'the previous step never produced it'], steps: ['verify the parent directory', 'check the previous step exit code'] },
  { re: /Floating point exception.*nan|Foam::error::printStack|FOAM aborting/i, category: 'OpenFOAM aborted deliberately', causes: ['the solver stopped after seeing nan', 'patch pairing error'], steps: ['read the 50 log lines before the abort', 'diagnose the previous error block'] },
]

function loadErrorPatterns(cfg) {
  try {
    const a = JSON.parse(readFileSync(join(experienceDirOf(cfg), '_error_patterns.json'), 'utf8'))
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

function diagnoseError(cfg, text) {
  const s = String(text || '')
  if (!s.trim()) return { ok: false, error: 'text is empty' }
  const learned = loadErrorPatterns(cfg).map((e) => {
    let re
    try { re = new RegExp(e.pattern, e.flags || 'i') } catch { re = /$a^/ }
    return { re, category: (e.category || 'Learned') + ' (learned)', causes: e.causes || [], steps: e.steps || [] }
  })
  const hits = []
  for (const p of ERROR_PATTERNS.concat(learned)) {
    const m = s.match(p.re)
    if (m) hits.push({ category: p.category, matched_snippet: m[0].slice(0, 120), causes: p.causes, next_steps: p.steps })
  }
  if (!hits.length) {
    return { ok: true, matched: false, hint: `No known pattern matched (${ERROR_PATTERNS.length} built-in + ${learned.length} learned). Paste the log tail and, after fixing it, register the pattern with openfoam_learn_error_pattern.` }
  }
  return { ok: true, matched: true, count: hits.length, hits }
}

function algoExtractContract(cfg, args) {
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
const SOLVER_MAP = {
  // OF14 modules (foamRun "solver" values)
  incompressibleFluid: ['incompressible single-phase', false, 1],
  isothermalFluid: ['isothermal compressible single-phase', true, 1],
  multicomponentFluid: ['compressible multicomponent/combustion', true, 1],
  shockFluid: ['compressible (shock capturing)', true, 1],
  XiFluid: ['premixed combustion (Xi)', true, 1],
  incompressibleVoF: ['VOF two-phase (incompressible)', false, 2],
  compressibleVoF: ['VOF two-phase (compressible)', true, 2],
  incompressibleMultiphaseVoF: ['VOF multiphase (incompressible)', false, 2],
  compressibleMultiphaseVoF: ['VOF multiphase (compressible)', true, 2],
  multiphaseEuler: ['Euler-Euler multiphase', null, 2],
  incompressibleDriftFlux: ['drift-flux two-phase (incompressible)', false, 2],
  incompressibleDenseParticleFluid: ['Euler-Lagrange dense particles', false, 1],
  solid: ['solid mechanics', null, 1],
  solidDisplacement: ['solid displacement', null, 1],
  film: ['thin film', null, 1],
  isothermalFilm: ['thin film (isothermal)', null, 1],
  movingMesh: ['mesh motion', null, 1],
  fluid: ['generic fluid', null, 1],
  // application entry points (applications/solvers)
  chemFoam: ['chemical kinetics (0-D reactor)', true, 1],
  potentialFoam: ['potential flow', false, 1],
  boundaryFoam: ['boundary-layer profile', false, 1],
  foamRun: ['generic modular solver runner', null, null],
  foamMultiRun: ['generic multi-region runner', null, null],
  basicFluidSolver: ['base fluid solver module', null, null],
  twoPhaseSolver: ['two-phase base', null, 2],
  // legacy solvers
  icoFoam: ['incompressible single-phase', false, 1],
  simpleFoam: ['incompressible single-phase', false, 1],
  pisoFoam: ['incompressible single-phase', false, 1],
  pimpleFoam: ['incompressible single-phase', false, 1],
  laplacianFoam: ['scalar transport (incompressible)', false, 1],
  porousSimpleFoam: ['incompressible porous', false, 1],
  rhoPorousSimpleFoam: ['compressible porous', true, 1],
  shallowWaterFoam: ['shallow water', false, 1],
  adjointShapeOptimisationFoam: ['incompressible adjoint', false, 1],
  PDRFoam: ['premixed combustion (PDR)', true, 1],
  mhdFoam: ['magnetohydrodynamics', false, 1],
  electrostaticFoam: ['electrostatics', false, 1],
  magneticFoam: ['magnetostatics', false, 1],
  dsmcFoam: ['DSMC (rarefied gas)', true, 1],
  mdFoam: ['molecular dynamics', null, 1],
  mdEquilibrationFoam: ['molecular dynamics (equilibration)', null, 1],
  financialFoam: ['financial (not CFD)', null, 1],
}

function classifySolver(name) {
  const sm = SOLVER_MAP[name]
  if (sm) return { governing: sm[0], compressible: sm[1], phases: sm[2] }
  if (/^rho/.test(name)) return { governing: 'compressible single-phase', compressible: true, phases: 1 }
  if (/VoF/i.test(name) || /^inter/.test(name)) return { governing: 'VOF two-phase', compressible: null, phases: 2 }
  if (/(twoPhaseEuler|multiphaseEuler)/.test(name)) return { governing: 'Euler-Euler multiphase', compressible: null, phases: 2 }
  if (/buoyant/.test(name)) return { governing: 'buoyant (T-coupled)', compressible: null, phases: 1 }
  if (/reacting|combustion|Xi/i.test(name)) return { governing: 'reacting/combustion', compressible: true, phases: 1 }
  return { governing: null, compressible: null, phases: null }
}

function caseProbeFacts(cfg, args) {
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

function algoCaseAudit(args) {
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
function experienceDirOf(cfg) {
  return cfg.experienceDir || join(HERE, '..', '.experience')
}

function ensureExpDir(cfg) {
  const d = experienceDirOf(cfg)
  mkdirSync(d, { recursive: true })
  return d
}

function loadExperience(cfg) {
  const d = experienceDirOf(cfg)
  let names = []
  try { names = readdirSync(d) } catch { return [] }
  const cards = []
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('_')) continue
    try {
      const c = JSON.parse(readFileSync(join(d, n), 'utf8'))
      if (c && c.id) cards.push(c)
    } catch {}
  }
  return cards
}

function contentHash(card) {
  return createHash('sha1')
    .update(JSON.stringify({ t: String(card.title || '').toLowerCase().trim(), r: (card.recipe || []).map((x) => String(x).toLowerCase().trim()), k: card.key_params || {}, p: (card.pitfalls || []).map((x) => String(x).toLowerCase().trim()) }))
    .digest('hex')
    .slice(0, 16)
}

function saveExperience(cfg, input) {
  const d = ensureExpDir(cfg)
  const card = {
    id: '',
    title: String(input.title || 'Untitled'),
    domain: String(input.domain || 'general'),
    triggers: Array.isArray(input.triggers) ? input.triggers.map(String) : [],
    solver: String(input.solver || ''),
    physics: String(input.physics || ''),
    recipe: Array.isArray(input.recipe) ? input.recipe.map(String) : [],
    key_params: input.key_params && typeof input.key_params === 'object' ? input.key_params : {},
    verify_seq: Array.isArray(input.verify_seq) ? input.verify_seq.map(String) : [],
    pitfalls: Array.isArray(input.pitfalls) ? input.pitfalls.map(String) : [],
    provenance: input.provenance && typeof input.provenance === 'object' ? input.provenance : {},
  }
  card.content_hash = contentHash(card)
  const all = loadExperience(cfg)
  const ex = all.find((c) => c.content_hash === card.content_hash)
  if (ex) {
    ex.stats = ex.stats || { hits: 0 }
    ex.stats.hits = (ex.stats.hits || 0) + 1
    ex.stats.updated = Date.now()
    writeFileSync(join(d, ex.id + '.json'), JSON.stringify(ex, null, 2))
    return { ok: true, id: ex.id, deduped: true }
  }
  const slug = (card.solver || card.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'card'
  card.id = `${card.domain}-${slug}-${card.content_hash.slice(0, 6)}`
  card.stats = { created: Date.now(), updated: Date.now(), hits: 0 }
  writeFileSync(join(d, card.id + '.json'), JSON.stringify(card, null, 2))
  return { ok: true, id: card.id, deduped: false }
}

function recallExperience(cfg, query, topK = 3) {
  const text = String(query || '').toLowerCase()
  if (!text.trim()) return { ok: true, count: 0, cards: [] }
  const scored = []
  for (const card of loadExperience(cfg)) {
    let score = 0
    for (const t of card.triggers || []) {
      const trig = String(t).toLowerCase().trim()
      if (trig.length >= 3 && text.includes(trig)) score += 1 + Math.min(trig.length / 12, 2)
    }
    const solver = String(card.solver || '').toLowerCase()
    if (solver.length >= 4 && text.includes(solver.split(/[\s(]/)[0])) score += 1.5
    score += Math.min((card.stats && card.stats.hits ? card.stats.hits : 0) * 0.05, 0.5)
    if (score > 0) scored.push({ card, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return { ok: true, count: Math.min(scored.length, topK), cards: scored.slice(0, Math.max(1, topK)).map((x) => x.card) }
}

function forgetExperience(cfg, id) {
  const d = experienceDirOf(cfg)
  const p = join(d, String(id) + '.json')
  if (!existsSync(p)) return { ok: false, error: 'no such experience: ' + id }
  try { rmSync(p) } catch (e) { return { ok: false, error: String(e.message || e) } }
  return { ok: true, id }
}

function exportExperience(cfg, outPath) {
  const d = ensureExpDir(cfg)
  const file = outPath ? resolveCase(cfg, outPath) : join(d, 'experience-bundle.json')
  const cards = loadExperience(cfg)
  const payload = { format: 'openfoam-workbench-experience', version: 1, exported_at: Date.now(), cards, error_patterns: loadErrorPatterns(cfg) }
  writeFileSync(file, JSON.stringify(payload, null, 2))
  return { ok: true, count: cards.length, path: file }
}

function importExperience(cfg, inPath) {
  const file = resolveCase(cfg, inPath)
  if (!existsSync(file)) return { ok: false, error: 'bundle not found: ' + file }
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { ok: false, error: 'bad JSON: ' + e.message } }
  let imported = 0
  for (const c of data.cards || []) {
    const r = saveExperience(cfg, c)
    if (r.ok && !r.deduped) imported++
  }
  for (const e of data.error_patterns || []) addErrorPattern(cfg, e)
  return { ok: true, imported, path: file }
}

function addErrorPattern(cfg, input) {
  const d = ensureExpDir(cfg)
  const pattern = String(input.pattern || '').trim()
  if (!pattern) return { ok: false, error: 'pattern is empty' }
  try { new RegExp(pattern, input.flags || 'i') } catch (e) { return { ok: false, error: 'invalid regex: ' + e.message } }
  const arr = loadErrorPatterns(cfg)
  const cat = String(input.category || 'Learned error')
  const ex = arr.find((e) => e.pattern === pattern && e.category === cat)
  if (ex) {
    ex.hits = (ex.hits || 0) + 1
    writeFileSync(join(d, '_error_patterns.json'), JSON.stringify(arr, null, 2))
    return { ok: true, deduped: true, total: arr.length }
  }
  arr.push({ pattern, flags: input.flags || 'i', category: cat, causes: input.causes || [], steps: input.steps || [], hits: 0, ts: Date.now() })
  writeFileSync(join(d, '_error_patterns.json'), JSON.stringify(arr, null, 2))
  return { ok: true, deduped: false, total: arr.length }
}

function appendSft(cfg, sample) {
  const d = ensureExpDir(cfg)
  const file = join(d, '_sft.jsonl')
  appendFileSync(file, JSON.stringify(sample) + '\n')
  let total = 0
  try { total = readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch {}
  return { ok: true, path: file, total }
}

// --- pvpython render helper ---
const PV_RENDER_SCRIPT = `import sys, os
from paraview.simple import *

def main():
    def num(s, default):
        try:
            return float(s[1:]) if s.startswith('n') else float(s)
        except Exception:
            return default

    case = sys.argv[1]
    field = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != 'none' else ''
    step = int(num(sys.argv[3] if len(sys.argv) > 3 else 'n-1', -1))
    az = num(sys.argv[4] if len(sys.argv) > 4 else 'n0', 0.0)
    el = num(sys.argv[5] if len(sys.argv) > 5 else 'n0', 0.0)
    zoom = num(sys.argv[6] if len(sys.argv) > 6 else 'n1', 1.0)
    out = sys.argv[7] if len(sys.argv) > 7 else 'render.png'
    foam = os.path.join(case, 'case.foam')
    if not os.path.exists(foam):
        open(foam, 'w').close()
    reader = OpenFOAMReader(FileName=foam)
    try:
        reader.MeshRegions = ['internalMesh']
    except Exception:
        pass
    if field:
        try:
            reader.CellArrays = [field]
        except Exception:
            pass
    UpdatePipeline()
    view = GetActiveViewOrCreate('RenderView')
    display = Show(reader, view)
    if field:
        for loc in ('CELLS', 'POINTS'):
            try:
                ColorBy(display, (loc, field))
                break
            except Exception:
                continue
    if step >= 0:
        try:
            view.ViewTime = reader.TimestepValues[step]
        except Exception:
            pass
    ResetCamera(view)
    cam = view.GetActiveCamera()
    cam.Azimuth(az)
    cam.Elevation(el)
    cam.Zoom(zoom)
    Render()
    SaveScreenshot(out, view, ImageResolution=[1200, 800])

main()
`

async function doRender(cfg, args) {
  const dir = resolveCase(cfg, args.case_path || args.casePath)
  if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
  const pv = cfg.paraviewPython || 'pvpython'
  const script = join(dir, '.pv_render.py')
  try { writeFileSync(script, PV_RENDER_SCRIPT) } catch (e) { return { ok: false, error: 'cannot write render script: ' + (e.message || e) } }
  const field = String(args.field || 'none')
  const step = args.time_step != null ? Number(args.time_step) : -1
  const az = Number(args.azimuth) || 0
  const el = Number(args.elevation) || 0
  const zoom = Number(args.zoom) || 1
  const out = join(dir, `.render_${Date.now()}.png`)
  const runArgs = [script, dir, field, 'n' + step, 'n' + az, 'n' + el, 'n' + zoom, out]
  let r = await run('/usr/bin/env', ['-u', 'DISPLAY', pv, ...runArgs], { timeoutMs: 300000 })
  let log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  if ((!r.ok || !existsSync(out)) && /GLX|BadValue|X Error|X_GLX/i.test(log) && existsSync('/usr/bin/xvfb-run')) {
    r = await run('/usr/bin/xvfb-run', ['-a', pv, ...runArgs], { timeoutMs: 300000 })
    log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  }
  if (r.ok && existsSync(out)) return { ok: true, path: out, case: dir, field, time_step: step }
  if (/GLX|BadValue|X Error|X_GLX|SIGSEGV|Segmentation fault|core dumped/i.test(log)) {
    return { ok: false, error: 'headless rendering unavailable: this ParaView build needs a GLX display (no OSMesa/EGL) and cannot create an offscreen GL context.', hint: 'Use a machine with a display, or an OSMesa/EGL ParaView build. xvfb alone is not enough for this build.', log: log.slice(-1200) }
  }
  return { ok: false, error: 'render failed', log: log.slice(-1200) }
}

const PV_STL_SCRIPT = `import sys
from paraview.simple import *

stl, out = sys.argv[1], sys.argv[2]
def num(s, d):
    try:
        return float(s[1:]) if s.startswith('n') else float(s)
    except Exception:
        return d
az = num(sys.argv[3] if len(sys.argv) > 3 else 'n0', 0.0)
el = num(sys.argv[4] if len(sys.argv) > 4 else 'n0', 0.0)
zoom = num(sys.argv[5] if len(sys.argv) > 5 else 'n1', 1.0)
r = OpenDataFile(stl)
r.UpdatePipeline()
view = GetActiveViewOrCreate('RenderView')
Show(r, view)
view.ViewSize = [1200, 900]
ResetCamera(view)
cam = view.GetActiveCamera()
cam.Azimuth(az)
cam.Elevation(el)
cam.Zoom(zoom)
Render()
SaveScreenshot(out, view, ImageResolution=[1200, 900])
print('DONE', out)
`

async function doRenderStl(cfg, args) {
  const stl = resolveCase(cfg, args.stl_path || args.stlPath)
  if (!stl || !existsSync(stl)) return { ok: false, error: 'stl not found: ' + stl }
  const pv = cfg.paraviewPython || 'pvpython'
  const base = join(tmpdir(), 'ofwb-stl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
  const script = base + '.py'
  const out = join(dirname(stl), '.stl_render_' + Date.now().toString(36) + '.png')
  try { writeFileSync(script, PV_STL_SCRIPT) } catch (e) { return { ok: false, error: 'cannot write render script: ' + (e.message || e) } }
  const runArgs = [script, stl, out, 'n' + (Number(args.azimuth) || 0), 'n' + (Number(args.elevation) || 0), 'n' + (Number(args.zoom) || 1)]
  let r = await run('/usr/bin/env', ['-u', 'DISPLAY', pv, ...runArgs], { timeoutMs: 300000 })
  let log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  if (!r.ok || !existsSync(out)) {
    r = await run('/usr/bin/env', ['-u', 'DISPLAY', '/usr/bin/xvfb-run', '-a', pv, ...runArgs], { timeoutMs: 300000 })
    log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  }
  if (r.ok && existsSync(out)) return { ok: true, path: out, stl }
  return { ok: false, error: 'stl render failed', log: log.slice(-1200) }
}

// --- paper / document helpers ---
async function pdfText(cfg, file) {
  const bin = cfg.pdftotext || 'pdftotext'
  const r = await run(bin, ['-layout', file, '-'], { timeoutMs: 120000 })
  if (r.ok && r.stdout.trim()) return { ok: true, text: r.stdout, tool: 'pdftotext' }
  const py = cfg.pythonPath || 'python3'
  const script = 'import sys, fitz\nd = fitz.open(sys.argv[1])\nprint("\\n".join(p.get_text() for p in d))'
  const r2 = await run(py, ['-c', script, file], { timeoutMs: 120000 })
  if (r2.ok && r2.stdout.trim()) return { ok: true, text: r2.stdout, tool: 'pymupdf' }
  return { ok: false, error: 'PDF text extraction failed', log: ((r.stderr || '') + (r2.stderr || '')).slice(-1000) }
}

function splitSections(text) {
  const out = { body: [] }
  let cur = 'body'
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    let key = null
    if (/^\d+\.?\s+[A-Z][^\n]{0,80}$/.test(t) && t.length < 90) {
      key = slug(t)
    } else if (/^(Abstract|References)\b/i.test(t) && t.length < 60) {
      key = t.toLowerCase().split(/\s/)[0]
    }
    if (key) cur = key
    if (!out[cur]) out[cur] = []
    out[cur].push(line)
  }
  const res = {}
  for (const [k, v] of Object.entries(out)) res[k] = v.join('\n').trim().slice(0, 20000)
  return res
}

async function paperSearch(cfg, args) {
  const q = String(args.query || '')
  if (!q) return { ok: false, error: 'empty query' }
  const limit = Math.min(Number(args.top_k) || 10, 50)
  const merge = []
  const errors = []
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,venue,citationCount,abstract,externalIds,openAccessPdf`
    const r = await fetch(url, { headers: { 'User-Agent': 'openfoam-workbench/0.1' }, signal: AbortSignal.timeout(20000) })
    if (r.ok) {
      const j = await r.json()
      for (const p of j.data || []) {
        merge.push({ source: 's2', title: p.title, authors: (p.authors || []).map((a) => a.name), year: p.year, venue: p.venue, citations: p.citationCount, doi: p.externalIds && p.externalIds.DOI, arxiv: p.externalIds && p.externalIds.ArXiv, abstract: p.abstract, pdf: p.openAccessPdf && p.openAccessPdf.url })
      }
    } else {
      errors.push('semantic-scholar: HTTP ' + r.status)
    }
  } catch (e) {
    errors.push('semantic-scholar: ' + ((e && e.message) || e))
  }
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${limit}`
    const r = await fetch(url, { headers: { 'User-Agent': 'openfoam-workbench/0.1' }, signal: AbortSignal.timeout(25000) })
    if (r.ok) {
      const xml = await r.text()
      if (!/<entry>/.test(xml)) errors.push('arxiv: ' + xml.slice(0, 120))
      for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const e = m[1]
        const title = ((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim().replace(/\s+/g, ' ')
        const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1]
        const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1]
        merge.push({ source: 'arxiv', title, arxiv: id ? id.split('/abs/').pop() : null, year: published ? new Date(published).getFullYear() : null, pdf: id ? id.trim() : null })
      }
    } else {
      errors.push('arxiv: HTTP ' + r.status)
    }
  } catch (e) {
    errors.push('arxiv: ' + ((e && e.message) || e))
  }
  const seen = new Set()
  const out = []
  for (const p of merge) {
    const k = String(p.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return { ok: true, count: Math.min(out.length, limit), papers: out.slice(0, limit), errors: errors.length ? errors : undefined }
}

async function paperFetch(cfg, args) {
  const id = String(args.id || '').trim()
  if (!id) return { ok: false, error: 'empty id' }
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=title,authors,year,venue,abstract,tldr,externalIds,openAccessPdf,references.title,references.year`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'openfoam-workbench/0.1' }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) return { ok: false, error: 'Semantic Scholar returned ' + r.status }
    const p = await r.json()
    const out = { ok: true, title: p.title, authors: (p.authors || []).map((a) => a.name), year: p.year, venue: p.venue, abstract: p.abstract, tldr: p.tldr && p.tldr.text, doi: p.externalIds && p.externalIds.DOI, arxiv: p.externalIds && p.externalIds.ArXiv, pdf: p.openAccessPdf && p.openAccessPdf.url, references: (p.references || []).slice(0, Number(args.max_refs) || 10) }
    if (args.download && p.openAccessPdf && p.openAccessPdf.url) {
      const dir = join((Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()), 'downloads/papers')
      mkdirSync(dir, { recursive: true })
      const base = (p.externalIds && p.externalIds.ArXiv ? 'arxiv_' + p.externalIds.ArXiv : String(p.title || 'paper').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60)) + '.pdf'
      const file = join(dir, base)
      try {
        const pr = await fetch(p.openAccessPdf.url, { signal: AbortSignal.timeout(60000) })
        if (pr.ok) { writeFileSync(file, Buffer.from(await pr.arrayBuffer())); out.downloaded = file }
      } catch {}
    }
    return out
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function pdfTextBlocks(cfg, file) {
  const py = cfg.pythonPath || 'python3'
  const script = [
    'import sys, fitz',
    'doc = fitz.open(sys.argv[1])',
    'out = []',
    'for page in doc:',
    '    blocks = [b for b in page.get_text("blocks") if b[6] == 0]',
    '    if not blocks:',
    '        continue',
    '    mid = page.rect.width * 0.5',
    '    left = [b for b in blocks if b[2] <= mid + 5]',
    '    right = [b for b in blocks if b[0] >= mid - 5]',
    '    if left and right and len(left) + len(right) >= len(blocks) - 2:',
    '        left.sort(key=lambda b: (b[1], b[0]))',
    '        right.sort(key=lambda b: (b[1], b[0]))',
    '        ordered = left + right',
    '    else:',
    '        ordered = sorted(blocks, key=lambda b: (b[1], b[0]))',
    '    out.append("\\n".join(b[4].strip() for b in ordered))',
    'print("\\n\\n".join(out))',
  ].join('\n')
  const r = await run(py, ['-c', script, file], { timeoutMs: 120000 })
  if (r.ok && r.stdout.trim()) return { ok: true, text: r.stdout, tool: 'pymupdf-blocks' }
  return pdfText(cfg, file)
}

async function readPaper(cfg, args) {
  const p = resolveCase(cfg, args.path)
  if (!p || !existsSync(p)) return { ok: false, error: 'file not found: ' + p }
  const t = await pdfTextBlocks(cfg, p)
  if (!t.ok) return t
  const sections = splitSections(t.text)
  let focusHits = null
  if (args.focus) {
    const f = String(args.focus).toLowerCase()
    focusHits = t.text.split('\n').filter((line) => line.toLowerCase().includes(f)).slice(0, 20)
  }
  return { ok: true, path: p, tool: t.tool, chars: t.text.length, sections, focusHits }
}

async function paperExtract(cfg, args) {
  const p = resolveCase(cfg, args.path)
  if (!p || !existsSync(p)) return { ok: false, error: 'file not found: ' + p }
  const t = await pdfText(cfg, p)
  if (!t.ok) return t
  const text = t.text
  const equations = []
  for (const m of text.matchAll(/^\s*([^\n]{3,200})\s*\((\d+)\)\s*$/gm)) {
    equations.push({ eq: m[2], text: m[1].trim() })
    if (equations.length >= 60) break
  }
  const tables = []
  for (const m of text.matchAll(/\bTable\s+(\d+)[^\n]{0,120}/g)) {
    tables.push({ table: m[1], caption: m[0].trim() })
    if (tables.length >= 40) break
  }
  const params = []
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{1,20})\s*=\s*([0-9.+\-eE]+)\s*([A-Za-z/%^0-9]+)?/g)) {
    params.push({ name: m[1], value: m[2], unit: m[3] || '' })
    if (params.length >= 200) break
  }
  return { ok: true, path: p, equations, tables, params }
}

async function readDocument(cfg, args) {
  const p = resolveCase(cfg, args.path)
  if (!p || !existsSync(p)) return { ok: false, error: 'file not found: ' + p }
  const ext = extname(p).toLowerCase()
  if (ext === '.pdf') return pdfText(cfg, p)
  if (['.txt', '.md', '.csv', '.log', '.dat', '.json', '.yaml', '.yml'].includes(ext)) {
    return { ok: true, text: (readText(p) || '').slice(0, 200000), tool: 'raw' }
  }
  return { ok: false, error: `unsupported format ${ext}; supported: pdf, txt, md, csv, log, dat, json, yaml` }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const configWarnings = validateConfig(cfg)
  if (configWarnings.length) console.warn('[openfoam-workbench] config warnings:\n ' + configWarnings.join('\n '))
  try { reconcileAll(cfg) } catch (e) { /* registry may be unwritable */ }
  const textOut = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]

  // --- presentation helpers: inline images + tool-call cards ---
  async function attachImage(result) {
    if (!result || !result.ok || !result.path || !existsSync(result.path)) return result
    try {
      const att = ctx.get('attachments')
      if (!att || typeof att.saveImage !== 'function') return result
      const ref = await att.saveImage({ data: readFileSync(result.path), mediaType: 'image/png', name: 'render.png' })
      return { ...result, image: ref }
    } catch (e) {
      return result
    }
  }
  const renderBlocks = (v) => (v && v.image ? [...textOut(v), { type: 'image', attachment: v.image }] : textOut(v))
  const renderCompare = (v) => {
    const out = textOut(v)
    for (const r of [v && v.a, v && v.b]) if (r && r.image) out.push({ type: 'image', attachment: r.image })
    return out
  }

  const fmtDuration = (ms) => {
    if (ms == null) return ''
    const s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    const m = Math.floor(s / 60)
    if (m < 60) return m + 'm' + (s % 60) + 's'
    return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
  }
  function fmtTable(headers, rows) {
    const all = [headers, ...rows]
    const widths = headers.map((_, i) => Math.max(1, ...all.map((r) => String(r[i] == null ? '' : r[i]).length)))
    const fmt = (r) => r.map((c, i) => String(c == null ? '' : c).padEnd(widths[i])).join('  ')
    return [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n')
  }
  const RENDERS = {
    openfoam_check: (_args, v) => {
      if (!v || v.ok === false) return textOut(v)
      const f = v.findings || []
      if (!f.length) return [{ type: 'text', text: `check: ${v.path || ''} — no findings` }]
      const body = fmtTable(['SEVERITY', 'RULE', 'TITLE'], f.map((x) => [x.severity || '', x.rule || '', x.title || '']))
      const fixes = f.map((x, i) => `  ${i + 1}. ${x.fix || ''}`).join('\n')
      return [{ type: 'text', text: `check: ${v.path || ''} — ${f.length} finding(s)\n\n${body}\n\nfixes:\n${fixes}` }]
    },
    openfoam_run_list: (_args, v) => {
      if (!v || v.ok === false) return textOut(v)
      const runs = v.runs || []
      if (!runs.length) return [{ type: 'text', text: 'runs: none' }]
      const rows = runs.map((r) => [r.runId || '', r.status || (r.running ? 'running' : ''), fmtDuration(r.durationMs), r.lastTime == null ? '' : r.lastTime, r.command || ''])
      return [{ type: 'text', text: `runs: ${runs.length}\n\n${fmtTable(['ID', 'STATUS', 'TIME', 'LAST TIME', 'COMMAND'], rows)}` }]
    },
    openfoam_mesh_verify: (_args, v) => {
      if (!v || v.ok === false) return textOut(v)
      const m = v.metrics || {}
      const rows = Object.entries(m).map(([k, val]) => [k, typeof val === 'object' ? JSON.stringify(val) : String(val)])
      const head = `mesh verify: ${v.pass === true ? 'PASS' : v.pass === false ? 'FAIL' : '?'}`
      const sug = v.suggestions && v.suggestions.length ? '\n\nsuggestions:\n' + v.suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : ''
      return [{ type: 'text', text: `${head}\n\n${fmtTable(['METRIC', 'VALUE'], rows)}${sug}` }]
    },
  }

  const PRESENT = {
    openfoam_run_solver_async: { title: (a) => 'run async: ' + (a.command || ''), kind: 'execute' },
    openfoam_solver_status: { title: (a) => 'status: ' + (a.run_id || ''), kind: 'read' },
    openfoam_solver_stop: { title: (a) => 'stop: ' + (a.run_id || ''), kind: 'execute' },
    openfoam_run_list: { title: () => 'runs', kind: 'read' },
    openfoam_render: { title: (a) => 'render ' + (a.field || '') + ': ' + (a.case_path || ''), kind: 'read' },
    openfoam_compare_render: { title: () => 'compare render', kind: 'read' },
    openfoam_check: { title: (a) => 'check: ' + (a.casePath || a.case_path || ''), kind: 'read' },
    openfoam_mesh_verify: { title: (a) => 'mesh verify: ' + (a.casePath || a.case_path || ''), kind: 'read' },
    openfoam_inspect_case: { title: (a) => 'inspect: ' + (a.casePath || a.case_path || ''), kind: 'read' },
    openfoam_patch_diff: { title: (a) => 'patches: ' + (a.casePath || a.case_path || ''), kind: 'read' },
    openfoam_read_dict: { title: (a) => 'dict: ' + (a.file || ''), kind: 'read' },
    openfoam_list_cases: { title: (a) => 'cases: ' + (a.root || ''), kind: 'read' },
    openfoam_find_source: { title: (a) => 'find: ' + (a.query || ''), kind: 'search' },
    openfoam_source_search: { title: (a) => 'search: ' + (a.query || ''), kind: 'search' },
    openfoam_paper_search: { title: (a) => 'papers: ' + (a.query || ''), kind: 'search' },
    openfoam_read_paper: { title: (a) => 'paper: ' + (a.path || ''), kind: 'read' },
    openfoam_solver_build: { title: (a) => 'build: ' + (a.modulePath || ''), kind: 'execute' },
    openfoam_solver_smoke: { title: () => 'smoke', kind: 'execute' },
    openfoam_dry_compile: { title: () => 'dry compile', kind: 'execute' },
    openfoam_case_probe_facts: { title: (a) => 'facts: ' + (a.case_path || ''), kind: 'read' },
    openfoam_diagnose_error: { title: () => 'diagnose', kind: 'read' },
    openfoam_mesh_plan: { title: () => 'mesh plan', kind: 'execute' },
    openfoam_mesh_stl_check: { title: () => 'mesh fit', kind: 'read' },
    openfoam_stl_inspect: { title: () => 'stl', kind: 'read' },
    openfoam_stl_render: { title: (a) => 'stl: ' + (a.stl_path || ''), kind: 'read' },
    openfoam_geom_verify: { title: () => 'geometry', kind: 'read' },
    openfoam_env_check: { title: () => 'env', kind: 'read' },
    openfoam_version_info: { title: () => 'version', kind: 'read' },
    openfoam_list_solvers: { title: () => 'solvers', kind: 'read' },
  }
  function reg(tool) {
    if (RENDERS[tool.name]) tool.output = { ...(tool.output || {}), render: RENDERS[tool.name] }
    if (!tool.presentCall) {
      if (tool.name === 'openfoam_run') {
        tool.presentCall = (args) => ({ card: 'terminal', title: String(args.command || 'openfoam'), description: 'OpenFOAM command', cwd: args.casePath })
      } else {
        const p = PRESENT[tool.name]
        if (p) tool.presentCall = (args) => ({ card: 'generic', title: typeof p.title === 'function' ? p.title(args || {}) : p.title, kind: p.kind, rawInput: args })
      }
    }
    ctx.tools.register(tool)
  }

  // --- register the bundled skills so the `skill` tool can discover them ---
  try {
    for (const d of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const p = join(SKILLS_DIR, d.name, 'SKILL.md')
      if (!existsSync(p)) continue
      const s = parseSkillMd(readFileSync(p, 'utf8'))
      if (!s) continue
      ctx.skills.register({
        name: s.name,
        description: s.description,
        content: s.content,
        source: 'bundled',
        invocation: { modelInvocable: true, userInvocable: true },
      })
    }
  } catch (e) {
    console.error('[openfoam-workbench] skill registration skipped:', (e && e.message) || e)
  }

  // --- thin core prompt section (always in context) ---
  ctx.systemPrompt.section({
    name: 'openfoam-workbench:core',
    order: 250,
    text: [
      '# OpenFOAM Workbench (core)',
      'You are an OpenFOAM CFD agent running locally. Use the openfoam_* tools to inspect, set up, run and verify cases.',
      'Rules: act-don\'t-talk (call a tool every turn); small steps; check, don\'t guess; ask on ambiguity; minimal change + verify.',
      'Skills load on demand: openfoam-case-builder, openfoam-solver-development, openfoam-code-modify, openfoam-meshing, openfoam-mesh-independence, openfoam-stats, openfoam-viz, openfoam-analyze, openfoam-paper-reproduction, openfoam-self-evolution.',
      'Reply to the user in Russian; write code, identifiers and comments in English.',
    ].join('\n'),
  })

  // --- tool: environment check ---
  reg({
    name: 'openfoam_env_check',
    description: 'Check the local OpenFOAM environment: whether foamRoot exists, the bashrc is present, and (by sourcing it) the version / project dir. Use at the start of a session or when commands are "not found".',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'openfoam_env_check', kind: 'read' }),
    execute: async (_args, exec) => {
      const bash = bashrcOf(cfg)
      const report = {
        ok: false,
        foamRoot: cfg.foamRoot || null,
        foamRootExists: !!cfg.foamRoot && existsSync(cfg.foamRoot),
        bashrc: bash || null,
        bashrcExists: !!bash && existsSync(bash),
        version: null,
        projectDir: null,
        flavor: null,
      }
      if (report.bashrcExists) {
        const r = await run(
          'bash',
          ['-lc', `source "${bash}" >/dev/null 2>&1; echo "$WM_PROJECT_VERSION"; echo "$WM_PROJECT_DIR"; echo "$WM_PROJECT"`],
          { signal: exec && exec.signal },
        )
        const lines = r.stdout.split('\n').map((s) => s.trim())
        report.version = lines[0] || null
        report.projectDir = lines[1] || null
        report.flavor = lines[2] || null
        report.ok = r.ok && !!report.version
      }
      report.distribution = report.version && /^v\d/i.test(report.version) ? 'com (ESI)' : 'org'
      return report
    },
  })

  // --- tool: version info ---
  reg({
    name: 'openfoam_version_info',
    description: 'Return the installed OpenFOAM flavor/version and key paths. Use once per session before solver or source work.',
    parameters: { type: 'object', properties: { refresh: { type: 'boolean' } } },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const r = await run(
        'bash',
        ['-lc', `source "${bash}" >/dev/null 2>&1; echo "$WM_PROJECT_VERSION"; echo "$WM_PROJECT_DIR"; echo "$WM_PROJECT"; echo "$WM_ARCH"`],
        { signal: exec && exec.signal },
      )
      const l = r.stdout.split('\n').map((s) => s.trim())
      const version = l[0] || null
      return { ok: r.ok, version, projectDir: l[1] || null, flavor: l[2] || null, arch: l[3] || null, distribution: version && /^v\d/i.test(version) ? 'com (ESI)' : 'org' }
    },
  })

  // --- tool: inspect case (read-only) ---
  reg({
    name: 'openfoam_inspect_case',
    description: 'Inspect an OpenFOAM case: solver, steady/transient, endTime, fields in 0/, patch types, turbulence model. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string', description: 'Case directory (absolute, or relative to caseRoots[0]).' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: 'openfoam_inspect_case', kind: 'read', rawInput: args }),
    execute: async (args) => {
      const dir = resolveCase(cfg, args && args.casePath)
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
      const bnd = readText(join(dir, 'constant/polyMesh/boundary'))
      if (bnd) {
        const re = /(\w+)\s*\{[^}]*?type\s+(\w+)/g
        let m
        while ((m = re.exec(bnd)) && info.patches.length < 60) info.patches.push({ name: m[1], type: m[2] })
      }
      for (const f of ['constant/momentumTransport', 'constant/turbulenceProperties', 'constant/transportProperties']) {
        const t = readText(join(dir, f))
        if (t) {
          info.turbulenceModel = dictEntry(t, 'model')
          if (info.turbulenceModel) break
        }
      }
      return info
    },
  })

  // --- tool: read native OpenFOAM source (read-only) ---
  reg({
    name: 'openfoam_read_source',
    description: 'Read a file or list a directory from the OpenFOAM installation (src/, applications/, etc/codeTemplates/) — read-only and outside the workspace. Returns numbered lines with start_line/end_line paging.',
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
      try { st = statSync(r.path) } catch { return { ok: false, error: 'not found: ' + r.path } }
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
  })

  // --- tool: search source content ---
  reg({
    name: 'openfoam_source_search',
    description: 'Search OpenFOAM source content (src/, applications/) by regex or plain text, returning file:line and a snippet. Use to locate classes/symbols in the installed version.',
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
      const rel = (file) => (cfg.foamRoot && file.startsWith(cfg.foamRoot) ? file.slice(cfg.foamRoot.length + 1) : file)
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
  })

  // --- tool: find tutorials ---
  reg({
    name: 'openfoam_find_tutorial',
    description: 'Search the OpenFOAM tutorials/ tree for cases (dirs with system/controlDict) by keyword. Returns candidate paths relative to tutorials/.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const root = cfg.foamRoot ? join(cfg.foamRoot, 'tutorials') : ''
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot/tutorials not found' }
      const q = String(args.query || '').toLowerCase()
      const topK = Math.min(Number(args.top_k) || 12, 100)
      const out = []
      walk(root, (file) => {
        if (!file.endsWith('/system/controlDict')) return
        const dir = file.slice(0, -'/system/controlDict'.length)
        if (!q || dir.toLowerCase().includes(q)) out.push(dir.slice(root.length + 1))
        return out.length < topK * 4
      }, 200000)
      return { ok: true, count: Math.min(out.length, topK), tutorials: out.slice(0, topK) }
    },
  })

  // --- tool: clone tutorial into workspace ---
  reg({
    name: 'openfoam_clone_tutorial',
    description: 'Copy a tutorial case into the workspace (caseRoots[0]). tutorial_path may be relative to foamRoot/tutorials or absolute inside it.',
    parameters: {
      type: 'object',
      properties: { tutorial_path: { type: 'string' }, dest: { type: 'string' } },
      required: ['tutorial_path', 'dest'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const root = cfg.foamRoot ? join(cfg.foamRoot, 'tutorials') : ''
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot/tutorials not found' }
      const src = isAbsolute(args.tutorial_path) ? args.tutorial_path : join(root, args.tutorial_path)
      if (!existsSync(src)) return { ok: false, error: 'tutorial not found: ' + src }
      if (!existsSync(join(src, 'system/controlDict'))) return { ok: false, error: 'not a case (no system/controlDict): ' + src }
      const destRoot = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()
      const dest = isAbsolute(args.dest) ? args.dest : join(destRoot, args.dest)
      if (existsSync(dest)) return { ok: false, error: 'destination exists: ' + dest }
      try { cpSync(src, dest, { recursive: true }) } catch (e) { return { ok: false, error: String(e.message || e) } }
      return { ok: true, tutorial: src, dest }
    },
  })

  // --- tool: run a whitelisted OpenFOAM command ---
  reg({
    name: 'openfoam_run',
    description: 'Run a whitelisted OpenFOAM command (blockMesh, checkMesh, snappyHexMesh, foamRun, a solver, setFields, postProcess, ...) inside a case directory with the OpenFOAM environment sourced. Synchronous with a timeout; returns the log tail.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['casePath', 'command'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 700000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const cmd = String(args.command || '').trim()
      if (!commandOk(cmd)) return { ok: false, error: 'command not allowed (whitelist): ' + cmd }
      const t0 = Date.now()
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${dir}" && ${cmd}`], {
        signal: exec && exec.signal,
        timeoutMs: Math.min(Number(args.timeout_ms) || 600000, 3600000),
      })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, command: cmd, exitCode: r.code, killed: r.killed, durationMs: Date.now() - t0, logTail: log.slice(-4000) }
    },
  })

  // --- tool: parse residuals from a log ---
  reg({
    name: 'openfoam_residual_series',
    description: 'Parse an OpenFOAM solver log into time steps and initial-residual series. Use to judge convergence from a saved log.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, max_points: { type: 'number' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.path)
      const text = readText(p)
      if (!text) return { ok: false, error: 'cannot read ' + p }
      const byTime = new Map()
      const order = []
      let t = null
      for (const line of text.split('\n')) {
        const tm = line.match(/Time\s*=\s*([0-9.eE+-]+)/)
        if (tm) { t = Number(tm[1]); continue }
        const rm = line.match(/Solving for (\w+), Initial residual = ([0-9.eE+-]+)/)
        if (rm && t !== null) {
          if (!byTime.has(t)) { byTime.set(t, {}); order.push(t) }
          byTime.get(t)[rm[1]] = Number(rm[2])
        }
      }
      const max = Math.min(Number(args.max_points) || 60, 500)
      const take = order.slice(-max)
      return { ok: true, path: p, timeSteps: take.length, series: take.map((x) => ({ time: x, residuals: byTime.get(x) })) }
    },
  })

  // --- tool: case doctor (silent failures, from dsh-openfoam-doctor, MIT) ---
  reg({
    name: 'openfoam_check',
    description: 'Audit an OpenFOAM case for the failures that do not announce themselves: steadyState paired with timeStep writes, limiter=1 (negative k/epsilon), unbounded advection, nNonOrthogonalCorrectors 0 on skewed meshes, stray time dirs, boundary mistakes. Deterministic — every finding has a fix. Run before the first solver run.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'Optional: check only one dict — controlDict | fvSchemes | fvSolution | blockMeshDict | boundaries | times.' },
      },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args && args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      let findings
      if (args.file === 'controlDict') findings = checkControlDict(dir)
      else if (args.file === 'fvSchemes') findings = checkFvSchemes(dir)
      else if (args.file === 'fvSolution') findings = checkFvSolution(dir)
      else if (args.file === 'blockMeshDict') findings = checkBlockMeshDict(dir)
      else if (args.file === 'boundaries') findings = checkBoundaryFields(dir)
      else if (args.file === 'times') findings = checkStrayTimes(dir)
      else findings = checkCaseEngine(dir)
      return { ok: true, path: dir, count: findings.length, findings }
    },
  })

  // --- tool: read a dictionary as JSON ---
  reg({
    name: 'openfoam_read_dict',
    description: 'Read an OpenFOAM dictionary and return it as JSON (controlDict, fvSchemes, fvSolution, blockMeshDict, snappyHexMeshDict, or 0/<field>). No OpenFOAM run needed.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        file: { type: 'string', description: 'controlDict | fvSchemes | fvSolution | blockMeshDict | snappyHexMeshDict | 0/<field>' },
      },
      required: ['casePath', 'file'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const dir = resolveCase(cfg, args && args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const rel = String(args.file).startsWith('0/') ? args.file : 'system/' + args.file
      const dict = readCaseDict(dir, rel)
      if (dict === null) return { ok: false, error: 'not found: ' + rel }
      return { ok: true, file: rel, dict }
    },
  })

  // --- tool: list cases under a directory ---
  reg({
    name: 'openfoam_list_cases',
    description: 'List OpenFOAM cases under a directory: solver, steady/transient, endTime, fields, stray time dirs, and whether blockMesh/snappy dicts exist.',
    parameters: {
      type: 'object',
      properties: { root: { type: 'string' }, depth: { type: 'number' } },
      required: ['root'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const root = resolveCase(cfg, args.root)
      if (!root || !existsSync(root)) return { ok: false, error: 'not found: ' + root }
      const depth = Math.max(1, Number(args.depth) || 2)
      const cases = []
      const scan = (dir, d) => {
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (!e.isDirectory()) continue
          if (e.name === '0' || e.name === 'constant' || e.name === 'system' || e.name.startsWith('.')) continue
          const full = join(dir, e.name)
          const cd = readCaseDict(full, CASE_FILES.control)
          if (cd) {
            const schemes = readCaseDict(full, CASE_FILES.schemes)
            const steady = schemes && schemes.ddtSchemes ? /steadyState/.test(String(schemes.ddtSchemes.default ?? '')) : null
            cases.push({
              path: full,
              name: e.name,
              solver: (cd.application ?? cd.solver) ?? null,
              steady,
              endTime: cd.endTime ?? null,
              fields: fieldFiles(full),
              strayTimes: strayTimeDirs(full),
              hasBlockMesh: existsSync(join(full, CASE_FILES.blockMesh)),
              hasSnappy: existsSync(join(full, CASE_FILES.snappyMesh)),
            })
            continue
          }
          if (d > 1) scan(full, d - 1)
        }
      }
      scan(root, depth)
      return { ok: true, count: cases.length, cases }
    },
  })

  // --- tool: parse a log ---
  reg({
    name: 'openfoam_log',
    description: 'Parse an OpenFOAM log (checkMesh, foamRun, snappyHexMesh...): checkMesh metrics + out-of-range judgment, or the run outcome (residual floor, fatal errors, divergence).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.path)
      const text = readText(p)
      if (!text) return { ok: false, error: 'cannot read ' + p }
      const isMesh = /checkMesh|Mesh stats|non-orthogonality|aspect ratio/i.test(text)
      return { ok: true, kind: isMesh ? 'checkMesh' : 'run', summary: isMesh ? parseCheckMesh(text) : parseRunLog(text) }
    },
  })

  // --- tool: inspect a solver module ---
  reg({
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
  })

  // --- tool: build a solver module ---
  reg({
    name: 'openfoam_solver_build',
    description: 'Build an OpenFOAM solver or library module from the workspace: sources the bashrc, optionally wclean, then wmake -jN (EXE) or wmake libso -jN (LIB). Returns the first error and the log tail.',
    parameters: {
      type: 'object',
      properties: {
        modulePath: { type: 'string' },
        clean: { type: 'boolean' },
        jobs: { type: 'number' },
      },
      required: ['modulePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const p = resolveCase(cfg, args.modulePath)
      if (!existsSync(join(p, 'Make/files'))) return { ok: false, error: 'not a module: ' + p }
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const make = readMakeFiles(p)
      const jobs = Math.max(1, Math.min(Number(args.jobs) || 4, 32))
      const build = make.isLib ? `wmake libso -j${jobs}` : `wmake -j${jobs}`
      const cmd = (args.clean ? 'wclean >/dev/null 2>&1 || true; ' : '') + build
      const t0 = Date.now()
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${p}" && ${cmd}`], { signal: exec && exec.signal, timeoutMs: 600000 })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, modulePath: p, target: make.target, isLib: make.isLib, exitCode: r.code, durationMs: Date.now() - t0, firstError: r.ok ? null : firstError(log), logTail: log.slice(-4000) }
    },
  })

  // --- tool: dry compile (first error) ---
  reg({
    name: 'openfoam_dry_compile',
    description: 'Quick compile of a solver module to catch the first error (no wclean). Sources the bashrc, runs wmake/wmake libso, returns the first compile/link error with context.',
    parameters: {
      type: 'object',
      properties: { modulePath: { type: 'string' } },
      required: ['modulePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const p = resolveCase(cfg, args.modulePath)
      if (!existsSync(join(p, 'Make/files'))) return { ok: false, error: 'not a module: ' + p }
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const make = readMakeFiles(p)
      const build = make.isLib ? 'wmake libso' : 'wmake'
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${p}" && ${build}`], { signal: exec && exec.signal, timeoutMs: 600000 })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, exitCode: r.code, firstError: r.ok ? null : firstError(log), logTail: log.slice(-4000) }
    },
  })

  // --- tool: solver smoke test ---
  reg({
    name: 'openfoam_solver_smoke',
    description: 'Smoke-test a built solver: run `<solver> -help` with the OpenFOAM environment sourced and report the exit code. Use after a successful build.',
    parameters: {
      type: 'object',
      properties: { solver: { type: 'string' }, modulePath: { type: 'string' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      let solver = args.solver
      if (!solver && args.modulePath) {
        const make = readMakeFiles(resolveCase(cfg, args.modulePath))
        solver = make.target ? basename(make.target) : null
      }
      if (!solver) return { ok: false, error: 'provide solver or modulePath with a Make/files target' }
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; ${solver} -help`], { timeoutMs: 90000 })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, solver, exitCode: r.code, logTail: log.slice(-2000) }
    },
  })

  // --- tool: clone a native solver into the workspace ---
  reg({
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
  })

  // --- tool: start a background solver run ---
  reg({
    name: 'openfoam_run_solver_async',
    description: 'Start a whitelisted OpenFOAM command (blockMesh, checkMesh, snappyHexMesh, foamRun, a solver, ...) in the background with the OpenFOAM environment sourced. Returns a runId for openfoam_solver_status / openfoam_solver_stop.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        command: { type: 'string' },
      },
      required: ['casePath', 'command'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const cmd = String(args.command || '').trim()
      if (!commandOk(cmd)) return { ok: false, error: 'command not allowed (whitelist): ' + cmd }
      const run = startSolverRun(cfg, dir, cmd, bash)
      return { ok: true, runId: run.id, casePath: dir, command: cmd, log: run.log }
    },
  })

  // --- tool: background run status ---
  reg({
    name: 'openfoam_solver_status',
    description: 'Check a background run started by openfoam_run_solver_async: running state, exit code, last Time, duration and log tail.',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const s = runSnapshot(cfg, args.run_id)
      if (!s) return { ok: false, error: 'no such run: ' + args.run_id }
      return { ok: true, ...s }
    },
  })

  // --- tool: stop a background run ---
  reg({
    name: 'openfoam_solver_stop',
    description: 'Stop a background run started by openfoam_run_solver_async (SIGTERM, then SIGKILL after 3 s).',
    parameters: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => stopRun(cfg, args.run_id),
  })

  // --- tool: patch diff ---
  reg({
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
  })

  // --- tool: y+ first-layer calculator ---
  reg({
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
  })

  // --- tool: STL inspect ---
  reg({
    name: 'openfoam_stl_inspect',
    description: 'Inspect an STL (ASCII/binary): triangle count, bbox, centroid, volume, surface area and watertightness (open-edge count).',
    parameters: {
      type: 'object',
      properties: { stl_path: { type: 'string' } },
      required: ['stl_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.stl_path)
      if (!p || !existsSync(p)) return { ok: false, error: 'not found: ' + p }
      try { return { ...inspectStl(p), path: p } } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    },
  })

  // --- tool: write an axis-aligned box STL ---
  reg({
    name: 'openfoam_mesh_box_stl',
    description: 'Write an axis-aligned box STL (outward normals) under <case>/constant/triSurface/<name>.stl. Used for the outer domain in a two-STL snappy setup.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        bbox_min: { type: 'array', items: { type: 'number' }, description: '[xmin,ymin,zmin] in meters.' },
        bbox_max: { type: 'array', items: { type: 'number' }, description: '[xmax,ymax,zmax] in meters.' },
        name: { type: 'string', description: 'STL name without .stl (default domain_box).' },
      },
      required: ['casePath', 'bbox_min', 'bbox_max'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const mn = args.bbox_min
      const mx = args.bbox_max
      if (!Array.isArray(mn) || mn.length !== 3 || !Array.isArray(mx) || mx.length !== 3) return { ok: false, error: 'bbox_min/bbox_max must be [x,y,z]' }
      const name = String(args.name || 'domain_box').replace(/\.stl$/i, '')
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return { ok: false, error: 'bad name: ' + name }
      const outDir = join(dir, 'constant/triSurface')
      mkdirSync(outDir, { recursive: true })
      const file = join(outDir, name + '.stl')
      const tris = stlBoxTriangles(mn.map(Number), mx.map(Number))
      writeFileSync(file, stlToAscii(name, tris))
      return { ok: true, path: file, triangles: tris.length }
    },
  })

  // --- tool: generate an STL from primitives ---
  reg({
    name: 'openfoam_stl_generate',
    description: 'Generate an STL from primitives (box/sphere/cylinder/cone/pipe) or a merged parts[] array, with translate/rotate_deg/scale. Writes to <case>/constant/triSurface/<name>.stl or out_path, and reports bbox/volume/watertightness.',
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
        if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
        const name = String(args.name || 'geometry').replace(/\.stl$/i, '')
        mkdirSync(join(dir, 'constant/triSurface'), { recursive: true })
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
      return { ok: true, path: file, triangles: tris.length, bbox: info.bbox, volume: info.volume, watertight: info.watertight }
    },
  })

  // --- tool: mesh plan ---
  reg({
    name: 'openfoam_mesh_plan',
    description: 'Generate blockMeshDict + snappyHexMeshDict + surfaceFeatureExtractDict for a case from an STL. domain.type is mandatory (external/internal/box/wrap). Writes system/ dictionaries and copies the STL into constant/triSurface/.',
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
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const plan = planMesh(cfg, args)
      if (!plan.ok) return plan
      const sys = join(dir, 'system')
      mkdirSync(sys, { recursive: true })
      writeFileSync(join(sys, 'blockMeshDict'), plan.blockMeshDict)
      writeFileSync(join(sys, 'snappyHexMeshDict'), plan.snappyHexMeshDict)
      writeFileSync(join(sys, 'surfaceFeatureExtractDict'), plan.surfaceFeatureExtractDict)
      const stlName = plan.name + '.stl'
      const triDir = join(dir, 'constant/triSurface')
      mkdirSync(triDir, { recursive: true })
      if (plan.stl !== join(triDir, stlName)) {
        try { cpSync(plan.stl, join(triDir, stlName)) } catch {}
      }
      return { ok: true, casePath: dir, stl: stlName, domain: plan.domain, cells: plan.cells, target_cell_size: plan.target_cell_size, written: ['system/blockMeshDict', 'system/snappyHexMeshDict', 'system/surfaceFeatureExtractDict'] }
    },
  })

  // --- tool: mesh verify (checkMesh) ---
  reg({
    name: 'openfoam_mesh_verify',
    description: 'Run checkMesh on a case, parse the metrics (cells, aspect ratio, non-orthogonality, skewness, volume) and judge pass/fail. The visual check is left to the agent (render + read_image).',
    parameters: {
      type: 'object',
      properties: { casePath: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['casePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const bash = bashrcOf(cfg)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${dir}" && checkMesh`], { signal: exec && exec.signal, timeoutMs: Math.min(Number(args.timeout_ms) || 300000, 900000) })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      const metrics = parseCheckMesh(log)
      const pass = r.ok && !metrics.failed && metrics.problems.length === 0
      const suggestions = []
      if (!r.ok) suggestions.push('checkMesh failed: read the log tail; the mesh may be missing (run blockMesh) or invalid')
      for (const p of metrics.problems) suggestions.push('out of range: ' + p)
      if (metrics.failed) suggestions.push('OpenFOAM reported failed mesh checks')
      return { ok: true, pass, metrics, suggestions, logTail: log.slice(-3000) }
    },
  })

  // --- tool: diagnose an error ---
  reg({
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
  })

  // --- tool: four-step step 1 ---
  reg({
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
  })

  // --- tool: four-step step 2 ---
  reg({
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
  })

  // --- tool: four-step step 3 ---
  reg({
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
  })

  // --- tool: experience save ---
  reg({
    name: 'openfoam_experience_save',
    description: 'Distil a verified practice into a reusable experience card (deduped by content hash). Save only after a verifier passed.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        domain: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' } },
        solver: { type: 'string' },
        physics: { type: 'string' },
        recipe: { type: 'array', items: { type: 'string' } },
        key_params: { type: 'object' },
        verify_seq: { type: 'array', items: { type: 'string' } },
        pitfalls: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => saveExperience(cfg, args),
  })

  // --- tool: experience recall ---
  reg({
    name: 'openfoam_experience_recall',
    description: 'Recall the most relevant experience cards for a task by trigger/solver keyword scoring. Call at the start of a non-trivial task.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => recallExperience(cfg, args.query, Math.min(Number(args.top_k) || 3, 10)),
  })

  // --- tool: experience list ---
  reg({
    name: 'openfoam_experience_list',
    description: 'List the experience cards (id, domain, title, triggers, hits).',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const cards = loadExperience(cfg).map((c) => ({ id: c.id, domain: c.domain, title: c.title, triggers: c.triggers, hits: c.stats && c.stats.hits }))
      return { ok: true, count: cards.length, cards }
    },
  })

  // --- tool: experience forget ---
  reg({
    name: 'openfoam_experience_forget',
    description: 'Delete one experience card by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => forgetExperience(cfg, args.id),
  })

  // --- tool: experience export ---
  reg({
    name: 'openfoam_experience_export',
    description: 'Pack the experience library (cards + learned error patterns) into one JSON bundle for sharing or migration.',
    parameters: {
      type: 'object',
      properties: { out_path: { type: 'string' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => exportExperience(cfg, args.out_path),
  })

  // --- tool: experience import ---
  reg({
    name: 'openfoam_experience_import',
    description: 'Import experience cards and error patterns from a bundle JSON (deduped).',
    parameters: {
      type: 'object',
      properties: { in_path: { type: 'string' } },
      required: ['in_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => importExperience(cfg, args.in_path),
  })

  // --- tool: learn error pattern ---
  reg({
    name: 'openfoam_learn_error_pattern',
    description: 'Register a new error pattern (regex + category + causes + steps) so openfoam_diagnose_error matches it next time.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        flags: { type: 'string' },
        category: { type: 'string' },
        causes: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['pattern', 'category'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => addErrorPattern(cfg, args),
  })

  // --- tool: experience export SFT ---
  reg({
    name: 'openfoam_experience_export_sft',
    description: 'Append a verified sample (jsonl) to the SFT corpus for future local fine-tuning.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        domain: { type: 'string' },
        sample: { type: 'object', description: 'Opaque JSON sample to store.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => appendSft(cfg, { ts: Date.now(), label: args.label || '', domain: args.domain || 'general', sample: args.sample || null }),
  })

  // --- tool: experience eval compare ---
  reg({
    name: 'openfoam_experience_eval_compare',
    description: 'Compare two evaluation records (A/B) and report the difference in pass rate / error-iteration count.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'object' },
        b: { type: 'object' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const a = args.a || {}
      const b = args.b || {}
      const rate = (r) => (r && typeof r.verifyPassRate === 'number' ? r.verifyPassRate : null)
      const iters = (r) => (r && typeof r.errorIters === 'number' ? r.errorIters : null)
      const ra = rate(a), rb = rate(b), ia = iters(a), ib = iters(b)
      let verdict = 'insufficient data'
      if (ra != null && rb != null) {
        if (rb > ra) verdict = 'B (with skill) wins on pass rate'
        else if (rb < ra) verdict = 'A (baseline) wins on pass rate'
        else verdict = 'tie on pass rate'
      }
      return { ok: true, a: { label: a.label || 'A', verifyPassRate: ra, errorIters: ia }, b: { label: b.label || 'B', verifyPassRate: rb, errorIters: ib }, verdict }
    },
  })

  // --- tool: render a case (pvpython) ---
  reg({
    name: 'openfoam_render',
    description: 'Off-screen render one frame of a case with pvpython to PNG (ParaView 6.x renders headless without a display; legacy 5.x GLX builds fall back to xvfb). Optional field colors it, time_step picks a step.',
    parameters: {
      type: 'object',
      properties: {
        case_path: { type: 'string' },
        field: { type: 'string', description: 'Cell/point field to color by (e.g. T / U / p).' },
        time_step: { type: 'number', description: '0-based step index, or -1 for the last.' },
        azimuth: { type: 'number' },
        elevation: { type: 'number' },
        zoom: { type: 'number' },
      },
      required: ['case_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => renderBlocks(v) },
    timeoutMs: 360000,
    isConcurrencySafe: () => false,
    execute: async (args) => attachImage(await doRender(cfg, args)),
  })

  // --- tool: render an STL geometry ---
  reg({
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
  })

  // --- tool: compare two renders ---
  reg({
    name: 'openfoam_compare_render',
    description: 'Render the same field at the same step from two cases, returning both image paths for a side-by-side comparison.',
    parameters: {
      type: 'object',
      properties: {
        case_a: { type: 'string' },
        case_b: { type: 'string' },
        field: { type: 'string' },
        time_step: { type: 'number' },
        azimuth: { type: 'number' },
        elevation: { type: 'number' },
      },
      required: ['case_a', 'case_b'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => renderCompare(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const a = await attachImage(await doRender(cfg, { ...args, case_path: args.case_a }))
      const b = await attachImage(await doRender(cfg, { ...args, case_path: args.case_b }))
      return { ok: a.ok && b.ok, a, b }
    },
  })

  // --- tool: mesh/STL fit check ---
  reg({
    name: 'openfoam_mesh_stl_check',
    description: 'Export the given patches to an STL with surfaceMeshTriangulate and compare bbox/area/volume against the reference STL. A lightweight proxy for the full Hausdorff check.',
    parameters: {
      type: 'object',
      properties: {
        case_path: { type: 'string' },
        ref_stl: { type: 'string' },
        patches: { type: 'array', items: { type: 'string' } },
        tol: { type: 'number', description: 'Relative tolerance (default 0.05).' },
      },
      required: ['case_path', 'ref_stl', 'patches'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const dir = resolveCase(cfg, args.case_path)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const ref = resolveCase(cfg, args.ref_stl)
      if (!ref || !existsSync(ref)) return { ok: false, error: 'ref_stl not found: ' + ref }
      const patches = (args.patches || []).map(String).filter((p) => /^[A-Za-z0-9_-]+$/.test(p))
      if (!patches.length) return { ok: false, error: 'patches is required' }
      const bash = bashrcOf(cfg)
      const exportFile = join(dir, '.patch_export.stl')
      const cmd = `surfaceMeshTriangulate -patches '(${patches.join(' ')})' "${exportFile}"`
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${dir}" && ${cmd}`], { timeoutMs: 300000 })
      if (!r.ok || !existsSync(exportFile)) return { ok: false, error: 'surfaceMeshTriangulate failed', log: ((r.stdout || '') + (r.stderr || '')).slice(-1500) }
      const pa = parseStlTris(ref)
      const pb = parseStlTris(exportFile)
      const a = inspectStl(ref)
      const b = inspectStl(exportFile)
      if (!a.ok || !b.ok) return { ok: false, error: 'STL parse failed' }
      const diag = Math.hypot(a.bbox.max[0] - a.bbox.min[0], a.bbox.max[1] - a.bbox.min[1], a.bbox.max[2] - a.bbox.min[2]) || 1
      const bboxRel = Math.max(...[0, 1, 2].map((i) => Math.max(Math.abs(a.bbox.max[i] - b.bbox.max[i]), Math.abs(a.bbox.min[i] - b.bbox.min[i])))) / diag
      const areaRel = Math.abs(a.area - b.area) / (a.area || 1)
      const volRel = Math.abs(a.volume - b.volume) / (a.volume || 1)
      const h1 = hausdorffApprox(pa.tris, pb.tris)
      const h2 = hausdorffApprox(pb.tris, pa.tris)
      const hausdorff = Math.max(h1 ?? 0, h2 ?? 0)
      const hausdorffRel = hausdorff / diag
      const tol = Number(args.tol) || 0.05
      const pass = bboxRel <= tol && areaRel <= tol * 2 && hausdorffRel <= tol
      return { ok: true, pass, ref: { bbox: a.bbox, area: a.area, volume: a.volume }, mesh: { bbox: b.bbox, area: b.area, volume: b.volume }, diffs: { bboxRel, areaRel, volRel, hausdorffRel }, hausdorff, note: 'Hausdorff approx = max triangle-centroid sampling distance; bbox/area/volume also compared' }
    },
  })

  // --- tool: geometry verify ---
  reg({
    name: 'openfoam_geom_verify',
    description: 'Deterministic geometry checks on an STL (watertight, positive volume, bbox) plus a checklist for the visual check. The visual part is done by the agent with read_image.',
    parameters: {
      type: 'object',
      properties: { stl_path: { type: 'string' }, expected_bbox: { type: 'array', items: { type: 'number' } } },
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
        const [x0, y0, z0, x1, y1, z1] = args.expected_bbox
        const exp = { min: [x0, y0, z0], max: [x1, y1, z1] }
        const d = Math.max(...[0, 1, 2].map((i) => Math.max(Math.abs(exp.max[i] - info.bbox.max[i]), Math.abs(exp.min[i] - info.bbox.min[i]))))
        checks.push({ name: 'bbox matches expected', pass: d < 1e-9, detail: `max deviation ${d}` })
      }
      return { ok: true, pass: checks.every((c) => c.pass), checks, inspect: { bbox: info.bbox, volume: info.volume, area: info.area, watertight: info.watertight }, visual: 'render with openfoam_render and judge with read_image' }
    },
  })

  // --- tool: solve verify ---
  reg({
    name: 'openfoam_solve_verify',
    description: 'Judge solver convergence from a run log: finished/End, divergence signals, residual floor, last time. Returns a deterministic pass/fail; the visual check is left to the agent.',
    parameters: {
      type: 'object',
      properties: { log_path: { type: 'string' }, residual_floor_tol: { type: 'number' } },
      required: ['log_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.log_path)
      const text = readText(p)
      if (!text) return { ok: false, error: 'log not found: ' + p }
      const parsed = parseRunLog(text)
      const tol = Number(args.residual_floor_tol) || 1e-3
      const floor = parsed.residualFloor != null ? Number(parsed.residualFloor) : null
      const pass = parsed.finished && !parsed.diverged && floor != null && floor < tol
      const reasons = []
      if (!parsed.finished) reasons.push('the log does not end with End (run did not finish cleanly)')
      if (parsed.diverged) reasons.push('divergence signals found in the log')
      if (floor == null) reasons.push('no residual floor parsed')
      else if (floor >= tol) reasons.push(`residual floor ${floor} >= ${tol}`)
      const decision = pass ? 'PROCEED' : (parsed.finished && !parsed.diverged) ? 'REVISE' : 'RERUN'
      return { ok: true, pass, decision, metrics: { finished: parsed.finished, diverged: parsed.diverged, residualFloor: floor, lastTime: parsed.iterations, errors: parsed.errors.slice(0, 5), warnings: parsed.warnings.slice(0, 5) }, reasons, visual: 'render the final state and judge with read_image' }
    },
  })

  // --- tool: post verify ---
  reg({
    name: 'openfoam_post_verify',
    description: 'Checklist for post-processing review: confirm renders exist and an expectation was stated; the physical judgement is done by the agent with read_image.',
    parameters: {
      type: 'object',
      properties: { images: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const images = Array.isArray(args.images) ? args.images : []
      const checks = []
      checks.push({ name: 'renders provided', pass: images.length > 0, detail: `${images.length} image(s)` })
      checks.push({ name: 'expectation stated', pass: !!args.expected, detail: args.expected || '(none)' })
      const missing = []
      const invalid = []
      const tooSmall = []
      for (const raw of images) {
        const p = resolveCase(cfg, raw)
        if (!p || !existsSync(p)) { missing.push(raw); continue }
        try {
          const buf = readFileSync(p)
          const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
          const isJpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
          if (!isPng && !isJpg) invalid.push(raw)
          else if (buf.length < 20 * 1024) tooSmall.push(`${raw} (${buf.length} B)`)
        } catch (e) {
          invalid.push(raw)
        }
      }
      checks.push({ name: 'all images exist', pass: missing.length === 0, detail: missing.join(', ') || 'ok' })
      checks.push({ name: 'valid image format', pass: invalid.length === 0, detail: invalid.join(', ') || 'ok' })
      checks.push({ name: 'non-trivial image size (>=20 KB)', pass: tooSmall.length === 0, detail: tooSmall.join(', ') || 'ok' })
      return { ok: true, pass: checks.every((c) => c.pass), checks, note: 'open the images with read_image and judge divergence, symmetry and units' }
    },
  })

  // --- tool: paper parameter verify ---
  reg({
    name: 'openfoam_paper_param_verify',
    description: 'Sanity-check extracted paper parameters: non-empty finite values, and (when expected_units is given) that every expected parameter is present and its unit is a known dimension.',
    parameters: {
      type: 'object',
      properties: { params: { type: 'object' }, expected_units: { type: 'object' } },
      required: ['params'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const params = args.params || {}
      const expectedUnits = args.expected_units || {}
      const issues = []
      for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') issues.push({ param: k, issue: 'empty value' })
        else if (typeof v === 'number' && !Number.isFinite(v)) issues.push({ param: k, issue: 'non-finite value' })
      }
      const KNOWN = new Set(['m', 's', 'm/s', 'm2/s', '1/s', 'kg/m3', 'kg/s', 'pa', 'k', 'j/kg', 'w/m2', '-', ''])
      for (const [k, u] of Object.entries(expectedUnits)) {
        if (!(k in params)) issues.push({ param: k, issue: `expected unit ${u}, but the parameter is missing` })
        else if (!KNOWN.has(String(u).toLowerCase())) issues.push({ param: k, issue: `unknown unit ${u}` })
      }
      return { ok: true, pass: issues.length === 0, issues }
    },
  })

  // --- tool: paper search ---
  reg({
    name: 'openfoam_paper_search',
    description: 'Search academic papers via Semantic Scholar + arXiv (merged, deduped by title). Returns title/authors/year/venue/citations/DOI/arXiv/PDF. Better than web_search for finding the original paper of an algorithm.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => paperSearch(cfg, args),
  })

  // --- tool: paper fetch ---
  reg({
    name: 'openfoam_paper_fetch',
    description: 'Fetch paper details by DOI / ARXIV:<id> / S2 paperId (abstract, tldr, references, OA PDF link). download=true saves the OA PDF to <caseRoots[0]>/downloads/papers/.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, download: { type: 'boolean' }, max_refs: { type: 'number' } },
      required: ['id'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => paperFetch(cfg, args),
  })

  // --- tool: read a paper ---
  reg({
    name: 'openfoam_read_paper',
    description: 'Read a PDF and split it into sections (abstract/introduction/methods/results/conclusion/references); optional focus returns matching passages.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, focus: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => readPaper(cfg, args),
  })

  // --- tool: extract from a paper ---
  reg({
    name: 'openfoam_paper_extract',
    description: 'Heuristically extract numbered equations, tables and numeric parameters from a PDF (grounded — nothing invented).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, focus: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => paperExtract(cfg, args),
  })

  // --- tool: read a document ---
  reg({
    name: 'openfoam_read_document',
    description: 'Read a local document: PDF (text via pdftotext/pymupdf) or plain text formats (txt/md/csv/log/dat/json/yaml).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => readDocument(cfg, args),
  })

  // --- tool: list installed solvers ---
  reg({
    name: 'openfoam_list_solvers',
    description: 'List the solvers installed in the OpenFOAM distribution (applications/solvers, applications/modules, applications/legacy) with their classified governing family, compressibility and phase count.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Optional substring to filter names.' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const root = cfg.foamRoot
      if (!root || !existsSync(root)) return { ok: false, error: 'foamRoot not configured' }
      const solvers = []
      const add = (name, source) => {
        const cls = classifySolver(name)
        solvers.push({ name, source, governing: cls.governing, compressible: cls.compressible, phases: cls.phases })
      }
      const solversDir = join(root, 'applications/solvers')
      if (existsSync(solversDir)) {
        for (const d of readdirSync(solversDir, { withFileTypes: true })) if (d.isDirectory()) add(d.name, 'applications/solvers')
      }
      const modulesDir = join(root, 'applications/modules')
      if (existsSync(modulesDir)) {
        for (const d of readdirSync(modulesDir, { withFileTypes: true })) if (d.isDirectory() && d.name !== 'functions') add(d.name, 'applications/modules')
      }
      const legacyDir = join(root, 'applications/legacy')
      if (existsSync(legacyDir)) {
        for (const cat of readdirSync(legacyDir, { withFileTypes: true })) {
          if (!cat.isDirectory()) continue
          const catDir = join(legacyDir, cat.name)
          for (const s of readdirSync(catDir, { withFileTypes: true })) {
            if (!s.isDirectory()) continue
            if (existsSync(join(catDir, s.name, 'Make/files'))) add(s.name, 'legacy/' + cat.name)
          }
        }
      }
      let out = solvers
      if (args.filter) out = out.filter((s) => s.name.toLowerCase().includes(String(args.filter).toLowerCase()))
      const modular = existsSync(join(root, 'applications/modules'))
      return { ok: true, distribution: modular ? 'org (modular solvers)' : 'com (application solvers)', modular, count: out.length, solvers: out }
    },
  })

  // --- tool: find a native solver or source file by name ---
  reg({
    name: 'openfoam_find_source',
    description: 'Find a native OpenFOAM solver or source file by name — searches applications/solvers, applications/modules, applications/legacy (directories with Make/files) and/or src/ for paths containing the query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kind: { type: 'string', enum: ['solver', 'source', 'any'], description: 'Default solver.' },
        top_k: { type: 'number' },
      },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const root = cfg.foamRoot
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
  })

  // --- tool: list durable background runs ---
  reg({
    name: 'openfoam_run_list',
    description: 'List background runs from the durable registry (id, case, command, status, last Time, duration). Survives restarts; statuses: running | stalled | success | interrupted | stopped | stopping.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional filter: running | stalled | success | interrupted | stopped | stopping.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const runs = []
      for (const id of listRunIds(cfg)) {
        const s = runSnapshot(cfg, id)
        if (!s) continue
        if (args.status && s.status !== args.status) continue
        runs.push(s)
      }
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      return { ok: true, count: runs.length, runs }
    },
  })
}
