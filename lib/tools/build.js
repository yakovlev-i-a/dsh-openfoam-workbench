import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { bashrcFor, foamEnv, resolveCase, runFoam, textOut } from '../runtime.js'

/** Where a build actually installs: FOAM_USER_LIBBIN as the sourced bashrc sets it. */
async function effectiveUserLibbin(bash, dir) {
  const r = await runFoam(['bash', '-c', 'printf %s \"$FOAM_USER_LIBBIN\"'], { bashrc: bash, dir, timeoutMs: 60000 })
  return r.ok ? String(r.stdout || '').trim() : ''
}

/**
 * Can a build write there? The check walks up to the nearest existing ancestor,
 * because wmake creates the platform directory itself. A read-only target is the
 * usual outcome of a lib dir outside the workspace (the file sandbox) or of a
 * system-owned ~/OpenFOAM tree.
 */
function writableTarget(target) {
  let p = resolve(target)
  for (;;) {
    if (existsSync(p)) {
      try {
        accessSync(p, fsConstants.W_OK)
        return { ok: true, existing: p }
      } catch (e) {
        return { ok: false, existing: p, error: String((e && e.message) || e) }
      }
    }
    const parent = dirname(p)
    if (parent === p) return { ok: false, existing: null, error: 'no existing ancestor' }
    p = parent
  }
}
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
        libbin: { type: 'string', description: 'Absolute directory to install a library into (overrides FOAM_USER_LIBBIN for wmake). Use it when the run must load the library from a place the sourced bashrc does not point at — for example a lib dir inside the workspace, which is the only place the file sandbox lets a build write.' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra build environment. Only LD_LIBRARY_PATH and FOAM_USER_LIBBIN are accepted; LD_PRELOAD/PATH are refused.' },
        libPaths: { type: 'array', items: { type: 'string' }, description: 'Shortcut for env.LD_LIBRARY_PATH: libraries the build links against.' },
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
      const buildArgv = make.isLib ? ['wmake', 'libso', `-j${jobs}`] : ['wmake', `-j${jobs}`]
      // A library installs where FOAM_USER_LIBBIN points, and that dir is often
      // outside the workspace (read-only under the file sandbox) or missing the
      // dir the run will search. Resolve the target first, then refuse with a fix
      // instead of surfacing wmake's "Permission denied" two minutes later.
      let libbin = ''
      if (args.libbin !== undefined) {
        if (typeof args.libbin !== 'string' || !isAbsolute(args.libbin)) return { ok: false, error: 'libbin must be an absolute directory', libbin: args.libbin }
        libbin = args.libbin
      }
      const env = foamEnv({ env: args.env, libPaths: args.libPaths, build: true })
      if (!env.ok) return { ok: false, error: env.error, hint: env.hint }
      if (libbin && env.userLibbin && resolve(libbin) !== resolve(env.userLibbin)) {
        return { ok: false, error: 'libbin and env.FOAM_USER_LIBBIN name different install targets; pass one of them' }
      }
      if (!libbin && env.userLibbin) libbin = env.userLibbin
      const installTarget = make.isLib ? (libbin || await effectiveUserLibbin(bash, p)) : ''
      if (make.isLib) {
        if (!installTarget) return { ok: false, error: 'cannot determine FOAM_USER_LIBBIN for this distribution; pass libbin explicitly' }
        const w = writableTarget(installTarget)
        if (!w.ok) {
          return {
            ok: false,
            error: `the library install target is not writable: ${installTarget}`,
            libbin: installTarget,
            writableAncestor: w.existing,
            hint: 'Build into the workspace and point the run at it: pass `libbin: <workspace>/<case>/lib` (or env.FOAM_USER_LIBBIN there), then give the run the same directory through `libPaths` or env.LD_LIBRARY_PATH.',
          }
        }
      }
      const t0 = Date.now()
      if (args.clean) await runFoam(['wclean'], { bashrc: bash, dir: p, signal: exec && exec.signal, timeoutMs: 300000, env: args.env, libPaths: args.libPaths, build: true })
      const r = await runFoam(buildArgv, { bashrc: bash, dir: p, signal: exec && exec.signal, timeoutMs: 600000, env: args.env, libPaths: args.libPaths, build: true })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return {
        ok: r.ok, modulePath: p, target: make.target, isLib: make.isLib, exitCode: r.code, durationMs: Date.now() - t0,
        ...(make.isLib ? { libbin: installTarget } : {}),
        ...(env.libPaths ? { libPaths: env.libPaths } : {}),
        firstError: r.ok ? null : firstError(log), logTail: log.slice(-4000),
      }
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
      const buildArgv = make.isLib ? ['wmake', 'libso'] : ['wmake']
      const r = await runFoam(buildArgv, { bashrc: bash, dir: p, signal: exec && exec.signal, timeoutMs: 600000 })
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
      const r = await runFoam([solver, '-help'], { bashrc: bash, dir: process.cwd(), timeoutMs: 90000 })
      const log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
      return { ok: r.ok, solver, exitCode: r.code, logTail: log.slice(-2000) }
    },
  },
  ]
}
