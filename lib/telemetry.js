export const USAGE = []

export const REGISTERED = new Set()

export function makeRegister(ctx, presentation) {
  const { RENDERS, PRESENT } = presentation
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
  // Usage telemetry: which openfoam_* tools this process actually called.
  // It is the only honest way to see whether the agent fell back to bash.
  REGISTERED.add(tool.name)
  const origExecute = tool.execute
  tool.execute = async (args, exec) => {
    const rec = { name: tool.name, at: Date.now(), ok: null }
    USAGE.push(rec)
    if (USAGE.length > 1000) USAGE.shift()
    try {
      const out = await origExecute(args, exec)
      rec.ok = !(out && out.ok === false)
      return out
    } catch (e) {
      rec.ok = false
      rec.error = String((e && e.message) || e)
      throw e
    }
  }
  ctx.tools.register(tool)
}
  return reg
}
