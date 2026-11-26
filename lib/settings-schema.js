// DSH Settings schema for this plugin.
//
// DSH projects a plugin's Config into the Settings page only when the module
// exports a *native* schemastery schema (Symbol.for('schemastery') === true).
// The library ships inside the DSH installation and is a dependency of the Host
// itself, so it is resolved from there at runtime instead of being vendored —
// the plugin keeps zero npm dependencies and degrades gracefully (no Settings
// form, config still honoured) when the library cannot be found.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/** Locate @deepseek-ai/schemastery: local install first, then the Host install. */
export function resolveSchemastery() {
  try {
    return require.resolve('@deepseek-ai/schemastery')
  } catch {}
  const execDir = dirname(process.execPath)
  const bases = [
    dirname(String(process.argv[1] || '')),
    process.cwd(),
    join(execDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
    join(execDir, '..', 'lib', 'node_modules'),
  ]
  for (const base of bases) {
    if (!base) continue
    let dir = resolve(base)
    for (let depth = 0; depth < 8; depth += 1) {
      const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'schemastery')
      if (existsSync(join(pkgDir, 'package.json'))) return pkgDir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

function loadSchemastery() {
  const found = resolveSchemastery()
  if (!found) return null
  try {
    const mod = require(found)
    return mod && typeof mod.object === 'function' ? mod : mod?.default ?? null
  } catch {
    return null
  }
}

/**
 * The plugin Config shown in Settings. Every key mirrors runtime DEFAULTS so an
 * existing profile patch validates unchanged; descriptions are the field labels.
 */
export function buildConfigSchema() {
  const z = loadSchemastery()
  if (!z) return undefined
  const dict = (description) => z.dict(z.string()).default({}).description(description)
  return z.object({
    foamRoot: z.string().default('').description('Legacy single OpenFOAM root (prefer foamRoots).'),
    openfoamBash: z.string().default('').description('Legacy single bashrc path (prefer foamRoots).'),
    foamRoots: dict('OpenFOAM installations: { org: /opt/openfoam14, com: /usr/lib/openfoam/openfoam2606 }. Empty = discover automatically.'),
    foamBashs: dict('bashrc override per distribution key; normally derived from foamRoots.'),
    defaultDistribution: z.string().default('').description('Which distribution a tool uses when called without distribution=. Empty = org when present.'),
    paraviewExe: z.string().default('').description('ParaView executable for -help checks. Empty = discover.'),
    paraviewPython: z.string().default('').description('pvpython for off-screen renders. Empty = discover in /opt and PATH.'),
    pythonPath: z.string().default('').description('Python 3 interpreter for the PDF-text fallback. Empty = discover.'),
    caseRoots: z.array(z.string()).default([]).description('Directories that resolve relative case paths. Empty = the working directory.'),
    extraCommands: z.array(z.string()).default([]).description('Extra whitelisted OpenFOAM commands for openfoam_run.'),
    corePath: z.string().default('').description('Alternative CORE.md. Empty = the bundled one.'),
    logTailBytes: z.number().min(0).default(4 * 1024 * 1024).description('How much of a solver log the verifiers read (bytes). 0 = whole file.'),
    escalationAuthority: z.string().default('auto').description(
      'Who issues an escalation token when a direct write is unavoidable: auto = the plugin issues it from the verified evidence (recorded in openfoam_usage_report), ask = the DSH approval answerer decides'
    ),
    enforceToolRouting: z.string().default('warn').description(
      'Watch tools/pre-execute for direct edits of case dictionaries: off = ignore, warn = allow and record the bypass, deny = refuse and point at the plugin tool, strict = refuse unless a live openfoam_escalate token covers the target'
    ),
    writeMode: z.string().default('impact').description('How dictionary writes are applied: impact (output keys apply, physics keys preview), apply (always write) or preview (never write without apply:true).'),
    runsDir: z.string().default('').description('Where run records and logs go. Empty = <case>/.openfoam-runs (next to the case).'),
    scaleAskAbove: z.number().min(0).default(0.1).description('Geometry-scale gate in metres: ask the human when the bounding box is larger. 0 = off.'),
    language: z.string().default('').description('Reply language: empty = OS locale, or a code/name such as ru, en, Russian.'),
  })
}

export const Config = buildConfigSchema()
