// Tool registration layer.
//
// Every tool goes through one choke point, so the whole plugin has exactly one
// place that decides what a model-visible result looks like and how calls are
// counted. DSH itself validates arguments before execute(), enforces timeoutMs
// (dsh-tool-call-timeout-policy), snapshots the result as lossless JSON and then
// renders it with output.render — this module makes sure we never trip those
// checks and keeps the per-tool declarations honest.
//
// Notes from dsh-tools that shaped this file:
//   * `presentCall` is host-local: the Web client derives cards from the call
//     arguments itself, so the plugin does not emit presentation metadata.
//   * only an exact `isConcurrencySafe(args) === true` is scheduled in parallel;
//     an absent classifier is exclusive (fail-closed), but declaring it makes the
//     intent explicit.
import { textOut } from './runtime.js'

/** Every tool result is an object with a boolean `ok`; those are the only fields DSH relies on. */
const RESULT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
}

const NAME_RE = /^openfoam_[a-z0-9_]+$/

/**
 * Rebuild a value as plain JSON: drop `undefined` (JSON.stringify does the same,
 * but DSH's lossless snapshot rejects it), keep nulls, reject what JSON cannot
 * carry (functions, symbols, bigint, non-finite numbers).
 */
export function toLosslessJson(value, path = 'result') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: non-finite number cannot be a tool result`)
    return value
  }
  // JSON.stringify turns a hole/undefined array item into null; keep that contract.
  if (Array.isArray(value)) return value.map((v, i) => (v === undefined ? null : toLosslessJson(v, `${path}[${i}]`)))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k] = toLosslessJson(v, `${path}.${k}`)
    }
    return out
  }
  throw new TypeError(`${path}: ${typeof value} cannot be a tool result`)
}

function validateDefinition(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('[openfoam-workbench] tool definition must be an object')
  if (!NAME_RE.test(String(tool.name || ''))) throw new Error(`[openfoam-workbench] bad tool name: ${tool.name}`)
  if (typeof tool.description !== 'string' || !tool.description.trim()) throw new Error(`[openfoam-workbench] ${tool.name}: description is required`)
  if (!tool.parameters || typeof tool.parameters !== 'object') throw new Error(`[openfoam-workbench] ${tool.name}: parameters schema is required`)
  if (typeof tool.execute !== 'function') throw new Error(`[openfoam-workbench] ${tool.name}: execute() is required`)
}

export function makeRegistry(ctx, { RENDERS = {} } = {}) {
  const usage = []
  const registered = new Map()

  function register(tool) {
    validateDefinition(tool)
    if (registered.has(tool.name)) throw new Error(`[openfoam-workbench] duplicate tool: ${tool.name}`)

    const output = { ...(tool.output || {}) }
    if (RENDERS[tool.name]) output.render = RENDERS[tool.name]
    if (typeof output.render !== 'function') output.render = (_args, value) => textOut(value)
    // A tool that needs a human decision says so explicitly: the question is
    // rendered before the payload, so the model cannot miss it.
    const baseRender = output.render
    output.render = (args, value) => {
      const blocks = baseRender(args, value)
      const q = value && value.needs_input
      if (!q) return blocks
      const label = (o) => (o && typeof o === 'object' ? `${o.id ?? '?'}: ${o.label ?? ''}` : `${o}`)
      const ask = typeof q.ask === 'string' ? q.ask : typeof q.question === 'string' ? q.question : ''
      if (!ask) return blocks
      const head = q.kind ? `[${q.kind}] ` : ''
      const options = Array.isArray(q.options) && q.options.length ? '\noptions: ' + q.options.map(label).join('; ') : ''
      return [{ type: 'text', text: 'QUESTION — ask the user with ask_user_question before proceeding, in the language the user writes in:\n' + head + ask + options }, ...blocks]
    }
    // Keep the tool's own fields (e.g. a stricter schema) but always require `ok`.
    output.schema = { ...RESULT_SCHEMA, ...(output.schema || {}) }
    tool.output = output

    // Declare the scheduling intent: only read-only tools say `true`.
    if (typeof tool.isConcurrencySafe !== 'function') tool.isConcurrencySafe = () => false

    const execute = tool.execute
    tool.execute = async (args, exec) => {
      const rec = { name: tool.name, at: Date.now(), ok: null }
      usage.push(rec)
      if (usage.length > 1000) usage.shift()
      try {
        const value = toLosslessJson(await execute(args, exec))
        rec.ok = value.ok !== false
        return value
      } catch (e) {
        rec.ok = false
        rec.error = String((e && e.message) || e)
        throw e
      }
    }

    registered.set(tool.name, tool)
    ctx.tools.register(tool)
  }

  function report() {
    const counts = new Map()
    const failures = new Map()
    for (const r of usage) {
      counts.set(r.name, (counts.get(r.name) || 0) + 1)
      if (r.ok === false) failures.set(r.name, (failures.get(r.name) || 0) + 1)
    }
    const called = [...counts.keys()].sort().map((name) => ({ name, count: counts.get(name), failed: failures.get(name) || 0 }))
    const unused = [...registered.keys()].filter((n) => !counts.has(n)).sort()
    return {
      calls: usage.length,
      called,
      unused,
      lastCall: usage.length ? new Date(usage[usage.length - 1].at).toISOString() : null,
    }
  }

  return {
    register,
    report,
    reset: () => { usage.length = 0 },
    registered,
    usage,
  }
}
