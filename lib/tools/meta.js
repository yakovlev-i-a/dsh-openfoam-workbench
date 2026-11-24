import { textOut } from '../runtime.js'
import { REGISTERED, USAGE } from '../telemetry.js'

export default function metaTools({ cfg }) {
  return [
  // --- tool: usage report (which openfoam_* tools were actually called) ---
  {
    name: 'openfoam_usage_report',
    description: 'Self-audit: which openfoam_* tools this DSH process called, how often, how they ended, and which registered tools were never used. Use it before answering "I could not do X with the plugin" — an unused tool family usually means the work went through bash.',
    parameters: {
      type: 'object',
      properties: { reset: { type: 'boolean', description: 'Clear the counters after reporting.' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const counts = {}
      const failures = []
      for (const r of USAGE) {
        counts[r.name] = (counts[r.name] || 0) + 1
        if (r.ok === false) failures.push(r)
      }
      const called = Object.keys(counts).sort()
      const unused = [...REGISTERED].filter((n) => !counts[n]).sort()
      const report = {
        ok: true,
        calls: USAGE.length,
        called: called.map((name) => ({ name, count: counts[name], failed: failures.filter((f) => f.name === name).length })),
        unused,
        lastCall: USAGE.length ? new Date(USAGE[USAGE.length - 1].at).toISOString() : null,
      }
      if (args.reset) { USAGE.length = 0 }
      return report
    },
  },
  ]
}
