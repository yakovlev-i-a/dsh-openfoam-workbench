// Zero-configuration environment discovery.
//
// A bundle installed from the marketplace cannot ship the author's absolute
// paths, so the plugin finds the local OpenFOAM installs and ParaView itself:
// known parent directories are scanned for `<dir>/etc/bashrc`, and ParaView is
// looked up in /opt and on PATH. Explicit configuration always wins.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

/** Parent directories that commonly hold OpenFOAM installations. */
const DEFAULT_PARENTS = [
  '/opt',
  '/usr/lib',
  '/usr/lib/openfoam',
  '/usr/local',
  join(homedir(), 'OpenFOAM'),
  join(homedir(), '.OpenFOAM'),
]

function candidateDirs(parent) {
  const out = []
  try {
    for (const e of readdirSync(parent, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const dir = join(parent, e.name)
      if (existsSync(join(dir, 'etc', 'bashrc'))) out.push(dir)
    }
  } catch {}
  return out
}

/**
 * Flavour and version hint from the directory name alone (the version itself is
 * read from the sourced environment by openfoam_version_info later).
 *   openfoam14            -> org, 14
 *   OpenFOAM-14           -> org, 14
 *   openfoam2606          -> com, v2606
 *   OpenFOAM-v2606        -> com, v2606
 */
export function classifyInstall(dir) {
  const name = basename(dir)
  const base = name.replace(/^openfoam[-_]?/i, '')
  // OpenFOAM.com versions are vYYMM (v2606); org versions are small integers (14).
  let m = /^v(\d{2}\.?\d{2})/i.exec(base)
  if (m) return { kind: 'com', version: 'v' + m[1].replace('.', '') }
  m = /^(\d{4})/.exec(base)
  if (m) return { kind: 'com', version: 'v' + m[1] }
  m = /^(\d{1,2})/.exec(base)
  if (m) return { kind: 'org', version: m[1] }
  return { kind: 'org', version: null }
}

/**
 * OpenFOAM installations found on this machine.
 * Returns { foamRoots: { <key>: <dir> }, defaultDistribution, found: [...] }.
 * Keys follow the distribution (org/com); a second install of the same flavour
 * gets a numeric suffix (org2, com2).
 */
export function discoverFoamRoots(extraParents = []) {
  const envRoot = String(process.env.WM_PROJECT_DIR || '').trim()
  const parents = [...new Set([...extraParents.filter(Boolean), ...DEFAULT_PARENTS])]
  const dirs = new Set()
  if (envRoot && existsSync(join(envRoot, 'etc', 'bashrc'))) dirs.add(envRoot)
  for (const parent of parents) for (const dir of candidateDirs(parent)) dirs.add(dir)
  const foamRoots = {}
  const found = []
  const home = homedir()
  const ordered = [...dirs].sort((a, b) => {
    const ha = a.startsWith(home) ? 1 : 0
    const hb = b.startsWith(home) ? 1 : 0
    return ha - hb || a.localeCompare(b)
  })
  for (const dir of ordered) {
    const { kind, version } = classifyInstall(dir)
    let key = kind
    let n = 2
    while (foamRoots[key]) key = kind + n++
    foamRoots[key] = dir
    found.push({ key, dir, kind, version })
  }
  const keys = Object.keys(foamRoots)
  const defaultDistribution = foamRoots.org ? 'org' : keys[0] || ''
  return { foamRoots, defaultDistribution, found }
}

function executableOnPath(name, pathEnv) {
  for (const dir of String(pathEnv || '').split(':')) {
    if (!dir) continue
    try {
      if (existsSync(join(dir, name)) && statSync(join(dir, name)).isFile()) return join(dir, name)
    } catch {}
  }
  return ''
}

/** ParaView for headless renders: /opt/paraview*, then PATH. */
export function discoverParaview(extraParents = [], pathEnv = process.env.PATH, options = {}) {
  const parents = options.parents ?? [...new Set([...extraParents.filter(Boolean), '/opt', '/usr/local'])]
  for (const parent of parents) {
    let entries = []
    try { entries = readdirSync(parent, { withFileTypes: true }) } catch { continue }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || !/paraview/i.test(e.name)) continue
      const bin = join(parent, e.name, 'bin')
      const python = join(bin, 'pvpython')
      if (existsSync(python)) return { paraviewExe: join(bin, 'paraview'), paraviewPython: python }
    }
  }
  const pvpython = executableOnPath('pvpython', pathEnv)
  if (!pvpython) return { paraviewExe: '', paraviewPython: '' }
  return { paraviewExe: executableOnPath('paraview', pathEnv) || '', paraviewPython: pvpython }
}

/** python3 for the PDF-text fallback (pdftotext is optional). */
export function discoverPython(pathEnv = process.env.PATH) {
  return executableOnPath('python3', pathEnv) || executableOnPath('python', pathEnv) || ''
}

/**
 * Resolve the language the agent should answer in.
 * Priority: explicit config > OS locale (LC_ALL/LC_MESSAGES/LANG) > English.
 * An explicit value may be a code ('ru') or a name ('Russian') and is used as given.
 */
export function resolveLanguage(cfg = {}, env = process.env) {
  const names = {
    ru: 'Russian', en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
    pt: 'Portuguese', pl: 'Polish', uk: 'Ukrainian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', tr: 'Turkish',
  }
  const explicit = String(cfg.language || '').trim()
  if (explicit) return names[explicit.toLowerCase()] || explicit
  const raw = String(env.LC_ALL || env.LC_MESSAGES || env.LANG || '').trim()
  const code = raw.split(/[.@]/)[0].split('_')[0].toLowerCase()
  return names[code] || 'English'
}
