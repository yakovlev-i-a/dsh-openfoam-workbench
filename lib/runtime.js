import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'

export const PLUGIN_NAME = '@yakovlev-i-a/dsh-openfoam-workbench'

export const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'
  } catch {
    return 'unknown'
  }
})()

export const pluginInfo = () => ({ name: PLUGIN_NAME, version: PLUGIN_VERSION })

// The always-on core prompt lives in CORE.md, one file, read at runtime.

export const DEFAULTS = {
  foamRoot: '',
  openfoamBash: '',
  foamRoots: {},
  foamBashs: {},
  defaultDistribution: '',
  paraviewExe: '',
  paraviewPython: '',
  pythonPath: '',
  caseRoots: [],
  extraCommands: [],
  corePath: '',
  logTailBytes: 4 * 1024 * 1024,
  scaleAskAbove: 0.1,
  runsDir: '',
  writeMode: 'impact',
  language: '',
}

export function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

/**
 * Read at most `maxBytes` from the end of a log (aligned to a line start).
 * Production logs reach gigabytes; every verdict only needs the last steps plus
 * the tail markers, so scanning the whole file is wasted time and memory.
 */
export function readLogTail(filePath, maxBytes = 4 * 1024 * 1024) {
  try {
    const st = statSync(filePath)
    if (st.size <= maxBytes) return { text: readFileSync(filePath, 'utf8'), truncated: false, bytes: st.size }
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(maxBytes)
      readSync(fd, buf, 0, maxBytes, st.size - maxBytes)
      let text = buf.toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) text = text.slice(nl + 1)
      return { text, truncated: true, bytes: st.size, scannedBytes: maxBytes }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { text: readText(filePath), truncated: false, bytes: 0 }
  }
}

// --- shell execution ---------------------------------------------------------
// Every OpenFOAM call goes through a *static* script: the bashrc, the working
// directory, the log path and the command arrive as positional parameters, so a
// path containing quotes, $(), backticks or a newline can never become shell
// code. Only whitelisted commands reach runFoam (see commandAllowed).
export const FOAM_RUN_SCRIPT = [
  'b="$1"; d="$2"; shift 2; cmd=("$@")',
  // Clear the positional parameters before sourcing: OpenFOAM's bashrc forwards
  // "$@" to etc/config.sh/setup, and a non-empty list makes that path hang.
  'set --',
  'source "$b" >/dev/null 2>&1 || { printf "%s\\n" "openfoam-workbench: cannot source $b" >&2; exit 97; }',
  'cd "$d" || { printf "%s\\n" "openfoam-workbench: cannot cd $d" >&2; exit 98; }',
  'exec "${cmd[@]}"',
].join('\n')

export const FOAM_LOG_SCRIPT = [
  'b="$1"; d="$2"; l="$3"; shift 3; cmd=("$@")',
  'set --',
  'source "$b" >/dev/null 2>&1 || { printf "%s\\n" "openfoam-workbench: cannot source $b" >&2; exit 97; }',
  'cd "$d" || { printf "%s\\n" "openfoam-workbench: cannot cd $d" >&2; exit 98; }',
  'exec "${cmd[@]}" >"$l" 2>&1',
].join('\n')

/** Run one OpenFOAM command (argv array) with the environment sourced. */
export function runFoam(argv, { bashrc = '', dir = process.cwd(), signal, timeoutMs = 600000 } = {}) {
  const args = Array.isArray(argv) ? argv : [String(argv)]
  return run('bash', ['-lc', FOAM_RUN_SCRIPT, 'bash', String(bashrc), String(dir), ...args.map(String)], { signal, timeoutMs })
}

/** Spawn one OpenFOAM command with its output redirected to `logPath`. */
export function spawnFoamLog(argv, { bashrc = '', dir = process.cwd(), logPath = '' } = {}) {
  const args = Array.isArray(argv) ? argv : [String(argv)]
  return spawn('bash', ['-lc', FOAM_LOG_SCRIPT, 'bash', String(bashrc), String(dir), String(logPath), ...args.map(String)], {
    detached: true,
    stdio: 'ignore',
  })
}

/** Probe the sourced environment with a static script (no interpolation). */
export function probeBashrc(bashrc, script, { timeoutMs = 60000 } = {}) {
  const wrapped = 'b="$1"; s="$2"; set --; source "$b" >/dev/null 2>&1 || exit 97; eval "$s"'
  return run('bash', ['-lc', wrapped, 'bash', String(bashrc), String(script)], { timeoutMs })
}

export function run(cmd, args, { signal, timeoutMs = 30000 } = {}) {
  return new Promise((res) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; res(v) } }
    let child
    try {
      child = execFile(cmd, args, { timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout, stderr) => {
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

export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

export function dictEntry(text, key) {
  const re = new RegExp('\\b' + key + '\\b\\s+([^;]+);')
  const m = stripComments(text).match(re)
  return m ? m[1].trim() : null
}

/** Path plus how it was resolved, so an answer can trace itself (K2). */
export function resolveCaseInfo(cfg, p) {
  if (isAbsolute(String(p || ''))) return { path: p, resolvedFrom: { kind: 'absolute', input: p } }
  const roots = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots : [process.cwd()]
  const root = roots[0]
  return {
    path: resolve(root, String(p || '')),
    resolvedFrom: {
      kind: Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? 'caseRoot' : 'cwd',
      root,
      input: p,
    },
  }
}

export function resolveCase(cfg, p) {
  if (!p) return ''
  if (isAbsolute(p)) return p
  const roots = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots : [process.cwd()]
  return resolve(roots[0], p)
}

export function inferCaseDir(cfg, logPath, explicit) {
  if (explicit) {
    const d = resolveCase(cfg, explicit)
    if (d && existsSync(join(d, 'system', 'controlDict'))) return d
  }
  let d = dirname(logPath)
  for (let i = 0; i < 4 && d && d !== dirname(d); i += 1) {
    if (existsSync(join(d, 'system', 'controlDict'))) return d
    d = dirname(d)
  }
  return null
}

export function topLevelKeys(text) {
  const keys = []
  let depth = 0
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    const m = depth === 0 ? /^(\w+)\s/.exec(t) : null
    if (m && !/^(FoamFile|include|includeEtc|libs)$/.test(m[1])) keys.push(m[1])
    depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length
  }
  return [...new Set(keys)]
}

export function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else { try { total += statSync(full).size } catch {} }
    }
  }
  return total
}

/** A registry log lives in <caseRoots[0]>/.openfoam-runs/<id>.log; its sibling
 *  <id>.json carries casePath, so progress works without an explicit casePath. */
export function caseFromRunRecord(logPath) {
  try {
    const rec = JSON.parse(readFileSync(logPath.replace(/\.log$/, '.json'), 'utf8'))
    if (rec && typeof rec.casePath === 'string' && existsSync(join(rec.casePath, 'system', 'controlDict'))) return rec.casePath
  } catch {}
  return null
}

export function rootFor(cfg, dist) {
  const d = dist || cfg.defaultDistribution
  if (d && cfg.foamRoots && cfg.foamRoots[d]) return String(cfg.foamRoots[d])
  if (cfg.foamRoot) return String(cfg.foamRoot)
  if (cfg.foamRoots) { const k = Object.keys(cfg.foamRoots)[0]; if (k) return String(cfg.foamRoots[k]) }
  return ''
}

export function bashrcFor(cfg, dist) {
  const d = dist || cfg.defaultDistribution
  if (d && cfg.foamBashs && cfg.foamBashs[d]) return String(cfg.foamBashs[d])
  const root = rootFor(cfg, dist)
  if (!d && cfg.openfoamBash) return String(cfg.openfoamBash)
  return root ? join(root, 'etc/bashrc') : ''
}

export function bashrcOf(cfg) {
  return bashrcFor(cfg, '')
}

/**
 * The log argument accepts both spellings: `log_path` (run tools) and `path`
 * (residual_series). A wrong name must not degrade into an empty path.
 */
export function pickLogPath(args = {}) {
  for (const key of ['log_path', 'path']) {
    const value = args ? args[key] : undefined
    if (typeof value === 'string' && value.trim()) return { path: value.trim(), key }
  }
  const keys = Object.keys(args || {})
  return {
    error: `log_path (alias: path) is required — accepted names: log_path, path; got: ${keys.length ? keys.join(', ') : '(no arguments)'}`,
  }
}

/** Hint appended to "case not found": which roots were searched. */
export function caseLookupHint(cfg) {
  const roots = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots : [process.cwd()]
  return ` (searched caseRoots: ${roots.join(', ')}; relative paths resolve against caseRoots, not the session cwd)`
}

export function validateConfig(cfg) {
  const warnings = []
  if (cfg.foamRoot && !existsSync(cfg.foamRoot)) warnings.push('foamRoot does not exist: ' + cfg.foamRoot)
  for (const [k, v] of Object.entries(cfg.foamRoots || {})) {
    if (v && !existsSync(v)) warnings.push('foamRoots.' + k + ' does not exist: ' + v)
  }
  const bash = bashrcOf(cfg)
  if (bash && !existsSync(bash)) warnings.push('openfoamBash does not exist: ' + bash)
  if (cfg.pythonPath && !existsSync(cfg.pythonPath)) warnings.push('pythonPath does not exist: ' + cfg.pythonPath)
  if (cfg.paraviewPython && !existsSync(cfg.paraviewPython)) warnings.push('paraviewPython does not exist: ' + cfg.paraviewPython)
  if (cfg.caseRoots && !Array.isArray(cfg.caseRoots)) warnings.push('caseRoots must be an array of paths')
  return warnings
}

export function sourceRoots(cfg) {
  const roots = []
  if (Array.isArray(cfg.allowedReadRoots)) roots.push(...cfg.allowedReadRoots)
  const foamRoot = rootFor(cfg, '')
  if (foamRoot) {
    roots.push(join(foamRoot, 'src'), join(foamRoot, 'applications'), join(foamRoot, 'etc', 'codeTemplates'))
  }
  return roots
}

export function resolveSource(cfg, p) {
  const roots = sourceRoots(cfg).map((r) => resolve(r))
  if (!roots.length) return { ok: false, error: 'no source roots configured (set foamRoot)' }
  const abs = isAbsolute(p) ? resolve(p) : resolve(roots[0], p)
  const ok = roots.some((r) => abs === r || abs.startsWith(r + sep))
  return ok ? { ok: true, path: abs } : { ok: false, error: `outside allowed source roots: ${abs}` }
}

export function walk(root, onFile, maxFiles = 50000) {
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

/**
 * Count time steps over the whole log without loading it: a solver log can be
 * hundreds of megabytes, while the verifiers read only the tail. Costs ~0.2 s
 * per 100 MB on a warm page cache; the budget bounds a cold network mount.
 */
export function countTimeSteps(filePath, { maxBytes = 8 * 1024 * 1024 * 1024, budgetMs = 4000 } = {}) {
  let fd
  try { fd = openSync(filePath, 'r') } catch { return { count: 0, bytes: 0, truncated: false, budgetExceeded: false } }
  const started = Date.now()
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  let count = 0
  let bytes = 0
  let carry = ''
  let budgetExceeded = false
  try {
    for (;;) {
      if (bytes >= maxBytes || Date.now() - started > budgetMs) { budgetExceeded = true; break }
      let read = 0
      try { read = readSync(fd, chunk, 0, chunk.length, bytes) } catch { break }
      if (!read) break
      const text = carry + chunk.toString('utf8', 0, read)
      // A line may be split across chunks: keep the last partial line for the next round.
      const cut = text.lastIndexOf('\n')
      const body = cut >= 0 ? text.slice(0, cut + 1) : ''
      carry = cut >= 0 ? text.slice(cut + 1) : text
      count += (body.match(/^Time\s*=/gm) || []).length
      bytes += read
      if (cut < 0) continue
    }
    if (carry) count += (/^Time\s*=/.test(carry) ? 1 : 0)
  } finally {
    try { closeSync(fd) } catch {}
  }
  return { count, bytes, truncated: false, budgetExceeded }
}

export const HERE = fileURLToPath(new URL('.', import.meta.url))

export const STALL_MS = 10 * 60 * 1000

// --- durable solver runs -------------------------------------------------
// Each case keeps its own registry next to itself (`<case>/.openfoam-runs`), so
// a run never lands in an unrelated project. `runsDir` pins one directory when a
// user wants a single place; discovery scans the case roots for case-local
// registries (bounded depth) and remembers every directory it has written to.

const RUN_DIR_BY_ID = new Map()

/** Registry directory for a run of `caseDir` (falls back to the first case root). */
export function runsDirOf(cfg, caseDir) {
  if (cfg.runsDir) return cfg.runsDir
  if (caseDir) return join(caseDir, '.openfoam-runs')
  const root = Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()
  return join(root, '.openfoam-runs')
}

function collectRunsDirs(dir, depth, out, budget) {
  if (depth < 0 || budget.left <= 0) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === '.openfoam-runs') { out.add(join(dir, e.name)); continue }
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    budget.left -= 1
    if (depth > 0) collectRunsDirs(join(dir, e.name), depth - 1, out, budget)
  }
}

/** Every registry directory this configuration can own. */
export function runsDirsOf(cfg) {
  const out = new Set(RUN_DIR_BY_ID.values())
  if (cfg.runsDir) { out.add(cfg.runsDir); return [...out] }
  const roots = [...(Array.isArray(cfg.caseRoots) ? cfg.caseRoots : []), process.cwd()]
  const budget = { left: 4000 }
  for (const root of roots) {
    out.add(join(root, '.openfoam-runs'))
    collectRunsDirs(root, 3, out, budget)
  }
  return [...out]
}

/** Locate the directory that holds run `id`. */
export function findRunDir(cfg, id) {
  const cached = RUN_DIR_BY_ID.get(id)
  if (cached) return cached
  for (const dir of runsDirsOf(cfg)) {
    try {
      if (existsSync(join(dir, id + '.json'))) { RUN_DIR_BY_ID.set(id, dir); return dir }
    } catch {}
  }
  return null
}

/** Forget cached run locations (tests and long-lived hosts after a registry move). */
export function resetRunDirCache() { RUN_DIR_BY_ID.clear() }

export function ensureRunsDir(cfg, caseDir) {
  const d = runsDirOf(cfg, caseDir)
  mkdirSync(d, { recursive: true })
  return d
}

export function runJsonPathIn(dir, id) { return join(dir, id + '.json') }
export function runLogPathIn(dir, id) { return join(dir, id + '.log') }

export function runJsonPath(cfg, id) {
  const dir = findRunDir(cfg, id)
  return dir ? runJsonPathIn(dir, id) : runJsonPathIn(runsDirOf(cfg), id)
}

export function runLogPath(cfg, id) {
  const dir = findRunDir(cfg, id)
  return dir ? runLogPathIn(dir, id) : runLogPathIn(runsDirOf(cfg), id)
}

export function readRun(cfg, id) {
  const dir = findRunDir(cfg, id)
  if (!dir) return null
  try { return JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')) } catch { return null }
}

export function writeRun(cfg, run) {
  const dir = run.runsDir || RUN_DIR_BY_ID.get(run.id) || runsDirOf(cfg, run.casePath)
  mkdirSync(dir, { recursive: true })
  run.runsDir = dir
  const p = join(dir, run.id + '.json')
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(run, null, 2))
  renameSync(tmp, p)
  RUN_DIR_BY_ID.set(run.id, dir)
}

export function listRunIds(cfg) {
  const ids = new Set()
  for (const dir of runsDirsOf(cfg)) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.json')) ids.add(f.slice(0, -5))
    } catch {}
  }
  return [...ids]
}

export function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function logTailFile(cfg, id, n = 4000) {
  const r = readLogTail(runLogPath(cfg, id), Math.max(n, 65536))
  return r.text ? r.text.slice(-n) : ''
}

export function logMtime(cfg, id) {
  try { return statSync(runLogPath(cfg, id)).mtimeMs } catch { return 0 }
}

export function logFinished(cfg, id) {
  const t = logTailFile(cfg, id, 16000)
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return lines.length > 0 && lines[lines.length - 1] === 'End'
}

// Reconcile the on-disk registry after a restart: a run whose pid is gone, or whose
// log reached `End` while we were not watching, is settled here.

export function reconcileAll(cfg) {
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

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function startSolverRun(cfg, dir, argvOrCommand, bash) {
  const runsDir = ensureRunsDir(cfg, dir)
  const id = 'run' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const log = runLogPathIn(runsDir, id)
  const argv = Array.isArray(argvOrCommand)
    ? argvOrCommand.map(String)
    : String(argvOrCommand).split(/\s+/).filter(Boolean)
  const child = spawnFoamLog(argv, { bashrc: bash, dir, logPath: log })
  const run = { id, casePath: dir, runsDir, command: argv.join(' '), argv, pid: child.pid, startedAt: Date.now(), status: 'running', log }
  writeRun(cfg, run)
  child.unref()
  return run
}

export function runSnapshot(cfg, id) {
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

export function stopRun(cfg, id) {
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

export function experienceDirOf(cfg) {
  return cfg.experienceDir || join(HERE, '..', '.experience')
}

export function ensureExpDir(cfg) {
  const d = experienceDirOf(cfg)
  mkdirSync(d, { recursive: true })
  return d
}

/** Text-only tool output. */
export function textOut(v) {
  if (typeof v === 'string') return [{ type: 'text', text: v }]
  const pretty = JSON.stringify(v, null, 2)
  if (pretty.length <= 8000) return [{ type: 'text', text: pretty }]
  // Large payloads (case lists, tutorials, run lists) are token bombs: keep the
  // JSON valid-looking by compacting first, then cut with an explicit note.
  const compact = JSON.stringify(v)
  if (compact.length <= 8000) return [{ type: 'text', text: compact }]
  return [{ type: 'text', text: compact.slice(0, 8000) + `\n... (truncated: ${compact.length} chars; narrow the query)` }]
}
