import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bashrcFor, caseFromRunRecord, dictEntry, inferCaseDir, listRunIds, readLogTail, readText, resolveCase, run, runSnapshot, startSolverRun, stopRun, textOut } from '../runtime.js'
import { parseCheckMesh, parseRunLog } from '../of-engine.js'
import { commandAllowed, mtimeOf, progressFrom } from '../of-case.js'

function scanInfo(scan) {
  return scan.truncated
    ? { truncated: true, scannedBytes: scan.scannedBytes, totalBytes: scan.bytes, note: 'only the log tail was read; earlier errors are not visible' }
    : { truncated: false, totalBytes: scan.bytes }
}

export default function runTools({ cfg }) {
  return [
  // --- tool: run a whitelisted OpenFOAM command ---
  {
    name: 'openfoam_run',
    description: 'Run a whitelisted OpenFOAM command inside a case directory with the OpenFOAM environment sourced: blockMesh, checkMesh, snappyHexMesh, setFields, topoSet, decomposePar, foamRun, foamMultiRun, or a solver, optionally wrapped as `mpirun -np N <app>`. Use this INSTEAD of bash for any OpenFOAM executable. Synchronous with a timeout and refuses `mpirun` — use openfoam_run_solver_async for parallel/production runs. Returns the log tail.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
        distribution: { type: 'string', description: 'org | com' },
      },
      required: ['casePath', 'command'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 700000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const bash = bashrcFor(cfg, args.distribution)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const cmd = String(args.command || '').trim()
      const chk = commandAllowed(cmd, cfg.extraCommands)
      if (!chk.ok) return { ok: false, error: chk.reason, hint: chk.hint, command: cmd, allowed: chk.allowed }
      // A synchronous tool must never start a production run: it would be killed
      // by the timeout halfway through a time step, or block the whole turn.
      if (chk.launcher) {
        return {
          ok: false,
          error: 'refusing to start an MPI (production) run from the synchronous tool',
          hint: 'use openfoam_run_solver_async for `mpirun ...` runs — it returns a runId and you can track it with openfoam_run_progress / openfoam_solver_status',
          command: cmd,
        }
      }
      const t0 = Date.now()
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${dir}" && ${cmd}`], {
        signal: exec && exec.signal,
        timeoutMs: Math.min(Number(args.timeout_ms) || 600000, 3600000),
      })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, command: cmd, exitCode: r.code, killed: r.killed, durationMs: Date.now() - t0, logTail: log.slice(-4000) }
    },
  },
  // --- tool: parse residuals from a log ---
  {
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
      const scan = readLogTail(p, Number(cfg.logTailBytes) || undefined)
      const text = scan.text
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
      return { ok: true, path: p, timeSteps: take.length, logScan: scanInfo(scan), series: take.map((x) => ({ time: x, residuals: byTime.get(x) })) }
    },
  },
  // --- tool: parse a log ---
  {
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
      const scan = readLogTail(p, Number(cfg.logTailBytes) || undefined)
      const text = scan.text
      if (!text) return { ok: false, error: 'cannot read ' + p }
      const isMesh = /checkMesh|Mesh stats|non-orthogonality|aspect ratio/i.test(text)
      return { ok: true, kind: isMesh ? 'checkMesh' : 'run', logScan: scanInfo(scan), summary: isMesh ? parseCheckMesh(text) : parseRunLog(text) }
    },
  },
  // --- tool: start a background solver run ---
  {
    name: 'openfoam_run_solver_async',
    description: 'Start a whitelisted OpenFOAM command in the background with the OpenFOAM environment sourced — including multi-region runs as `mpirun -np N foamMultiRun`, which openfoam_run cannot hold synchronously. Use this INSTEAD of bash for production runs. Returns a runId for openfoam_solver_status / openfoam_solver_stop; track progress with openfoam_run_progress.',
    parameters: {
      type: 'object',
      properties: {
        casePath: { type: 'string' },
        command: { type: 'string' },
        distribution: { type: 'string', description: 'org | com' },
      },
      required: ['casePath', 'command'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const bash = bashrcFor(cfg, args.distribution)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const dir = resolveCase(cfg, args.casePath)
      if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
      const cmd = String(args.command || '').trim()
      const chk = commandAllowed(cmd, cfg.extraCommands)
      if (!chk.ok) return { ok: false, error: chk.reason, hint: chk.hint, command: cmd, allowed: chk.allowed }
      const run = startSolverRun(cfg, dir, cmd, bash)
      return { ok: true, runId: run.id, casePath: dir, command: cmd, log: run.log }
    },
  },
  // --- tool: background run status ---
  {
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
  },
  // --- tool: stop a background run ---
  {
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
  },
  // --- tool: solve verify ---
  {
    name: 'openfoam_solve_verify',
    description: 'Judge a solver run from its log: RUNNING (t, steps, s/step, ETA), finished/End, divergence, residual floor. Understands multi-region and parallel logs (`      Time = 0.071s`, rank prefixes) and ignores the startup sigFpe banner. Returns a deterministic state; the visual check is left to the agent.',
    parameters: {
      type: 'object',
      properties: {
        log_path: { type: 'string' },
        casePath: { type: 'string', description: 'Case directory; when omitted it is inferred from the log path (used for endTime/ETA).' },
        residual_floor_tol: { type: 'number' },
      },
      required: ['log_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.log_path)
      const scan = readLogTail(p, Number(cfg.logTailBytes) || undefined)
      const text = scan.text
      if (!text) return { ok: false, error: 'log not found: ' + p }
      const tol = Number(args.residual_floor_tol) || 1e-3
      const caseDir = inferCaseDir(cfg, p, args.casePath)
      let endTime = null
      if (caseDir) {
        const cd = readText(join(caseDir, 'system', 'controlDict'))
        if (cd) endTime = Number(dictEntry(cd, 'endTime')) || null
      }
      const prog = progressFrom(text, { endTime, mtimeMs: mtimeOf(p), nowMs: Date.now(), tolerance: tol })
      const reasons = []
      if (prog.state === 'running') {
        reasons.push(`run is in progress: t = ${prog.time}${endTime ? ' / ' + endTime : ''}, ${prog.steps} time steps, ${prog.secondsPerStep ? prog.secondsPerStep.toFixed(2) + ' s/step' : 's/step unknown'}${prog.eta ? ', ETA ' + prog.eta : ''}`)
      }
      if (prog.state === 'stalled') reasons.push(`log has not grown for ${prog.staleSeconds}s while the run has no End`)
      if (prog.state === 'finished' && !prog.pass) reasons.push(prog.residualFloor != null ? `residual floor ${prog.residualFloor} >= ${tol}` : 'no residual floor parsed')
      if (prog.diverged) reasons.push('divergence signals found in the log')
      if (prog.errors.length) reasons.push('errors in the log: ' + prog.errors.slice(0, 2).join(' | '))
      return {
        ok: true,
        state: prog.state,
        pass: prog.pass,
        decision: prog.decision,
        metrics: {
          finished: prog.finished,
          diverged: prog.diverged,
          residualFloor: prog.residualFloor,
          lastTime: prog.time,
          timeSteps: prog.steps,
          secondsPerStep: prog.secondsPerStep,
          eta: prog.eta,
          elapsed: prog.elapsed,
          endTime,
          errors: prog.errors,
          warnings: prog.warnings,
        },
        reasons,
        casePath: caseDir,
        logScan: scanInfo(scan),
        visual: 'render the final state and judge with read_image',
      }
    },
  },
  // --- tool: list durable background runs ---
  {
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
  },
  // --- tool: run progress (t, steps, s/step, ETA) ---
  {
    name: 'openfoam_run_progress',
    description: 'Report run progress from a solver log: current time, time steps done, seconds per step, ETA, residual floor and state (running | stalled | finished | failed). Understands multi-region and parallel logs. Use this INSTEAD of grepping the log or writing a python progress parser.',
    parameters: {
      type: 'object',
      properties: {
        log_path: { type: 'string' },
        casePath: { type: 'string', description: 'Optional case dir (inferred from the log path); used for endTime/ETA.' },
        endTime: { type: 'number', description: 'Override the case endTime.' },
      },
      required: ['log_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const p = resolveCase(cfg, args.log_path)
      const scan = readLogTail(p, Number(cfg.logTailBytes) || undefined)
      const text = scan.text
      if (text == null) return { ok: false, error: 'log not found: ' + p }
      const caseDir = inferCaseDir(cfg, p, args.casePath) || caseFromRunRecord(p)
      let endTime = Number(args.endTime) || null
      if (!endTime && caseDir) {
        const cd = readText(join(caseDir, 'system', 'controlDict'))
        if (cd) endTime = Number(dictEntry(cd, 'endTime')) || null
      }
      const prog = progressFrom(text, { endTime, mtimeMs: mtimeOf(p) })
      return { ok: true, log: p, casePath: caseDir, endTime, logScan: scanInfo(scan), ...prog }
    },
  },
  ]
}
