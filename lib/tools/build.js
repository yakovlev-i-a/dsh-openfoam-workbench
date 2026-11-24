import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { bashrcFor, resolveCase, run, textOut } from '../runtime.js'
import { firstError, readMakeFiles } from '../buildlib.js'

export default function buildTools({ cfg }) {
  return [
  // --- tool: build a solver module ---
  {
    name: 'openfoam_solver_build',
    description: 'Build an OpenFOAM solver or library module from the workspace: sources the bashrc, optionally wclean, then wmake -jN (EXE) or wmake libso -jN (LIB). Returns the first error and the log tail.',
    parameters: {
      type: 'object',
      properties: {
        modulePath: { type: 'string' },
        clean: { type: 'boolean' },
        jobs: { type: 'number' },
        distribution: { type: 'string', description: 'org | com' },
      },
      required: ['modulePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const p = resolveCase(cfg, args.modulePath)
      if (!existsSync(join(p, 'Make/files'))) return { ok: false, error: 'not a module: ' + p }
      const bash = bashrcFor(cfg, args.distribution)
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
  },
  // --- tool: dry compile (first error) ---
  {
    name: 'openfoam_dry_compile',
    description: 'Quick compile of a solver module to catch the first error (no wclean). Sources the bashrc, runs wmake/wmake libso, returns the first compile/link error with context.',
    parameters: {
      type: 'object',
      properties: { modulePath: { type: 'string' }, distribution: { type: 'string', description: 'org | com' } },
      required: ['modulePath'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const p = resolveCase(cfg, args.modulePath)
      if (!existsSync(join(p, 'Make/files'))) return { ok: false, error: 'not a module: ' + p }
      const bash = bashrcFor(cfg, args.distribution)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const make = readMakeFiles(p)
      const build = make.isLib ? 'wmake libso' : 'wmake'
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; cd "${p}" && ${build}`], { signal: exec && exec.signal, timeoutMs: 600000 })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, exitCode: r.code, firstError: r.ok ? null : firstError(log), logTail: log.slice(-4000) }
    },
  },
  // --- tool: solver smoke test ---
  {
    name: 'openfoam_solver_smoke',
    description: 'Smoke-test a built solver: run `<solver> -help` with the OpenFOAM environment sourced and report the exit code. Use after a successful build.',
    parameters: {
      type: 'object',
      properties: { solver: { type: 'string' }, modulePath: { type: 'string' }, distribution: { type: 'string', description: 'org | com' } },
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
      const bash = bashrcFor(cfg, args.distribution)
      if (!bash || !existsSync(bash)) return { ok: false, error: 'bashrc/foamRoot not configured' }
      const r = await run('bash', ['-lc', `source "${bash}" >/dev/null 2>&1; ${solver} -help`], { timeoutMs: 90000 })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, solver, exitCode: r.code, logTail: log.slice(-2000) }
    },
  },
  ]
}
