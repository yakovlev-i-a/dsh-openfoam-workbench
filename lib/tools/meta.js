import { textOut } from '../runtime.js'
import { resetRoutingReport, routingReport } from '../routing-guard.js'
import { createEscalation, escalationsReport, resetEscalations } from '../escalations.js'

export default function metaTools({ cfg, registry, getApproval }) {
  return [
  // --- tool: escalate past the strict write policy (audited) ---
  {
    name: 'openfoam_escalate',
    description: 'Ask for one audited exception to the strict write policy: a single-use token that lets a direct write (bash/write/edit) to one case dictionary through. The request must carry evidence — the plugin tools named in toolsTried must have been called and failed within the last 15 minutes — so the exception is checkable. With escalationAuthority="ask" the human approves it through the DSH approval seam; with "auto" the token is issued directly (recorded in openfoam_usage_report).',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Case-relative path that needs the direct write, e.g. system/controlDict' },
        operation: { type: 'string', description: 'What the direct write does, e.g. replace-multiline-block' },
        toolsTried: { type: 'array', items: { type: 'string' }, description: 'Plugin tools that were tried and failed (must appear in the call history)' },
        why: { type: 'string', description: 'Why no plugin tool can express the change' },
        ttlMinutes: { type: 'number', description: 'Token lifetime in minutes (max 10, default 10)' },
      },
      required: ['target', 'toolsTried', 'why'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const authority = String(cfg.escalationAuthority || 'auto')
      const toolsTried = (Array.isArray(args.toolsTried) ? args.toolsTried : []).map(String).filter(Boolean)
      if (!toolsTried.length) {
        return { ok: false, error: 'toolsTried must name at least one plugin tool that was tried', hint: 'the escalation is verified against the call history: call the tool first, then escalate with its name' }
      }
      if (authority === 'ask') {
        const service = typeof getApproval === 'function' ? getApproval() : undefined
        if (!service || typeof service.request !== 'function') {
          return { ok: false, error: 'escalationAuthority="ask" needs the DSH approval service; it is not mounted (fail-closed)' }
        }
        let outcome = 'unavailable'
        try {
          outcome = await service.request({
            agent: exec && exec.agent,
            toolName: 'openfoam_escalate',
            ...(exec && exec.callId ? { callId: exec.callId } : {}),
            reason: `direct write to ${args.target} (${args.operation || 'edit'}): ${args.why}`,
          })
        } catch {
          outcome = 'unavailable'
        }
        if (outcome !== 'allowed-once') {
          return { ok: false, error: `escalation refused by the approval answerer: ${outcome}` }
        }
      }
      const token = createEscalation({
        target: args.target,
        operation: args.operation,
        why: args.why,
        toolsTried,
        authority,
        registry,
        agent: exec && exec.agent ? exec.agent.id : null,
        ttlMs: Number(args.ttlMinutes) > 0 ? Number(args.ttlMinutes) * 60_000 : undefined,
      })
      if (!token.ok) return token
      return {
        ok: true,
        escalationId: token.id,
        target: token.target,
        operation: token.operation,
        authority: token.authority,
        expiresInMs: token.ttlMs,
        evidence: token.evidence,
        next: ['perform exactly one direct write to that target', 'add the change to the case journal or re-run openfoam_check afterwards'],
      }
    },
  },

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
      const routing = routingReport()
      const escalations = escalationsReport()
      if (args && args.reset) { registry.reset(); resetRoutingReport(); resetEscalations() }
      return { ok: true, ...report, routing, escalations }
    },
  },
  ]
}
