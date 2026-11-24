import { textOut } from '../runtime.js'

export default function metaTools({ registry }) {
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
      const report = registry.report()
      if (args && args.reset) registry.reset()
      return { ok: true, ...report }
    },
  },
  ]
}
