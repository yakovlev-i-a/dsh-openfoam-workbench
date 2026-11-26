// Tool-routing guard.
//
// The write policy only covers this plugin's tools. An agent that also has
// generic shell/file tools can change a case around them, so the plugin watches
// `tools/pre-execute` and reports (or refuses, depending on the configuration)
// direct edits of case dictionaries.
//
// Text matching on shell commands is evadable on purpose (printf, python -c,
// variable indirection): the guard is a strong deterrent plus a signal, not a
// proof. The real boundary stays the DSH sandbox and the approval answerer.
import { basename } from 'node:path'

/** Case-relative dictionaries the plugin owns. */
const CASE_DIRS = /(^|\/)(system|constant|0|0\.orig|0_orig)\//
const DICT_FILE = /\.(dict|Dict|properties|Properties|Transport|Schemes|Solution|Dict)$|^(controlDict|fvSchemes|fvSolution|blockMeshDict|snappyHexMeshDict|decomposeParDict|createZonesDict|topoSetDict|regionProperties|regionSolvers|transportProperties|turbulenceProperties|momentumTransport|thermophysicalProperties|thermophysicalTransport|physicalProperties|g|pRef|initialConditions|postProcessDict)$/
const WRITE_HINTS = /(>>?|\bsed\s+-i|\bperl\s+-[a-z]*i\b|\btee\b|\bcp\b|\bmv\b|\btruncate\b|\binstall\b|\bdd\b|open\([^)]*['"]w|foamDictionary\b[^\n]*-set|writeFileSync|>\/)/

const TOOL_FOR = [
  [/(^|\/)(system|constant)\//, 'openfoam_read_dict / openfoam_dict_set'],
  [/(^|\/)0(\/|$)/, 'openfoam_dict_set'],
]

function looksLikeCaseDictionary(path) {
  const p = String(path || '').replace(/\\/g, '/')
  if (!p) return false
  if (CASE_DIRS.test(p)) return true
  return DICT_FILE.test(basename(p))
}

function redirectFor(path) {
  for (const [re, tool] of TOOL_FOR) if (re.test(String(path || '').replace(/\\/g, '/'))) return tool
  return 'openfoam_dict_set'
}

/**
 * Decide whether one tool call bypasses the plugin's write path.
 * Returns { hit, toolName, target, reason, redirect } or { hit: false }.
 */
export function classifyToolCall(toolName, args = {}) {
  const name = String(toolName || '')
  // file tools: a direct write to a case dictionary
  if (name === 'write' || name === 'edit' || name === 'apply_patch' || name === 'multi_edit') {
    const path = args.file_path || args.filePath || args.path || ''
    if (looksLikeCaseDictionary(path)) {
      return {
        hit: true,
        toolName: name,
        target: String(path),
        reason: `${name} writes ${path} directly`,
        redirect: redirectFor(path),
      }
    }
    return { hit: false }
  }
  // shell: a command that writes into a case dictionary
  if (name === 'bash' || name === 'bash_sandbox' || name === 'shell') {
    const cmd = String(args.command || args.cmd || '')
    if (!cmd) return { hit: false }
    const hasWrite = WRITE_HINTS.test(cmd)
    const touchesCase = /(^|[\s'"=])(\.{0,2}\/)?([\w.\-/]*\/)?(system|constant|0|0\.orig)\//.test(cmd) || DICT_FILE.test(cmd)
    if (hasWrite && touchesCase) {
      const m = /([\w.\-/]*\/)?(system|constant|0|0\.orig)\/[\w.\-]+/.exec(cmd)
      const target = m ? m[0] : cmd.slice(0, 80)
      return {
        hit: true,
        toolName: name,
        target,
        reason: `bash writes ${target}`,
        redirect: redirectFor(target),
      }
    }
  }
  return { hit: false }
}

const events = []

/** Recorded bypass attempts (warn and deny alike). */
export function routingReport() {
  return {
    count: events.length,
    events: events.slice(-20),
  }
}

export function resetRoutingReport() {
  events.length = 0
}

/**
 * Evaluate one call against the configured mode.
 *   off  → allow silently
 *   warn → allow, record the event (visible in openfoam_usage_report)
 *   deny → refuse with a message that names the plugin tool
 */
export function evaluateToolCall({ toolName, args, mode = 'warn', consume = null, now = () => new Date().toISOString() }) {
  if (mode === 'off') return { decision: 'allow', hit: false }
  const hit = classifyToolCall(toolName, args)
  if (!hit.hit) return { decision: 'allow', hit: false }

  // strict: a covered write needs a live escalation token for this target
  if (mode === 'strict') {
    const token = typeof consume === 'function' ? consume(hit.target) : null
    if (token && token.ok) {
      events.push({ at: now(), tool: hit.toolName, target: hit.target, decision: 'escalated', escalation: token.id })
      return { decision: 'allow', hit: true, escalation: token.id }
    }
    events.push({ at: now(), tool: hit.toolName, target: hit.target, decision: 'deny' })
    return {
      decision: 'deny',
      hit: true,
      reason: `${hit.reason}; use ${hit.redirect} instead. If no tool can express it, call openfoam_escalate({ target: "${hit.target}", operation: "…", toolsTried: ["<tool that failed>"], why: "…" }) first — it is audited and grants one write`,
      redirect: hit.redirect,
    }
  }

  events.push({ at: now(), tool: hit.toolName, target: hit.target, decision: mode })
  if (mode === 'deny') {
    return {
      decision: 'deny',
      hit: true,
      reason: `${hit.reason}; use ${hit.redirect} instead so the change is classified, journaled and reversible (openfoam_dict_undo)`,
    }
  }
  return { decision: 'warn', hit: true, reason: hit.reason, redirect: hit.redirect }
}
