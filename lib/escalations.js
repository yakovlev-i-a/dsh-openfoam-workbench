// Escalation: the audited way out of the strict write policy.
//
// In `strict` mode a direct edit of a case dictionary is refused. When no plugin
// tool can express the change, the agent asks for an explicit, single-use token
// that covers one target for a short time. The request must carry evidence: the
// tools it tried must actually have been called (and failed) recently, so the
// exception is checkable rather than a claim.
import { randomUUID } from 'node:crypto'

export const TTL_MS = 10 * 60 * 1000
export const EVIDENCE_WINDOW_MS = 15 * 60 * 1000

const store = new Map()
const events = []

/** Which of the named tools were really called recently, and which of those failed. */
export function evidenceCheck({ registry, toolsTried = [], windowMs = EVIDENCE_WINDOW_MS, now = Date.now() }) {
  const tried = []
  for (const tool of toolsTried) {
    const calls = registry && typeof registry.history === 'function' ? registry.history({ ms: windowMs, name: tool }) : []
    tried.push({ tool, calls: calls.length, failed: calls.filter((r) => r.ok === false).length })
  }
  return { verified: tried.some((t) => t.failed > 0), windowMs, tried }
}

/**
 * Request one escalation token.
 * Returns { ok: true, id, expiresAt, scope } or { ok: false, error, evidence }.
 */
export function createEscalation({ target, operation, why, toolsTried = [], authority = 'auto', registry, agent = null, ttlMs = TTL_MS, now = Date.now() }) {
  const cleanTarget = String(target || '').trim()
  if (!cleanTarget) return { ok: false, error: 'escalation needs a target path' }
  const evidence = evidenceCheck({ registry, toolsTried, now })
  if (!evidence.verified) {
    return {
      ok: false,
      error: 'escalation not verified: none of the named tools failed recently, so there is no evidence that the plugin tools cannot do this',
      hint: 'call the plugin tool first; if it fails, escalate with that tool in toolsTried (within 15 minutes)',
      evidence,
    }
  }
  const id = 'esc_' + randomUUID().slice(0, 8)
  const token = {
    id,
    target: cleanTarget,
    operation: String(operation || 'direct-write'),
    why: String(why || ''),
    authority,
    agent: agent || null,
    createdAt: now,
    expiresAt: now + Math.min(Math.max(Number(ttlMs) || TTL_MS, 60_000), TTL_MS),
    used: false,
  }
  store.set(id, token)
  events.push({ at: now, kind: 'created', id, target: token.target, operation: token.operation, authority, evidence: evidence.tried })
  return { ok: true, id, target: token.target, operation: token.operation, expiresAt: token.expiresAt, ttlMs: token.expiresAt - now, evidence, authority }
}

/**
 * Take a token for `target` (single use). The hook calls this before it lets a
 * direct write through, so one escalation authorises exactly one write.
 */
export function consumeEscalation({ target, agent = null, now = Date.now() }) {
  const wanted = String(target || '')
  for (const token of store.values()) {
    if (token.used || token.expiresAt <= now) continue
    if (agent && token.agent && token.agent !== agent) continue
    if (token.target !== wanted) continue
    token.used = true
    token.usedAt = now
    events.push({ at: now, kind: 'consumed', id: token.id, target: token.target, operation: token.operation })
    return { ok: true, id: token.id, operation: token.operation }
  }
  return { ok: false }
}

/** Report for openfoam_usage_report. */
export function escalationsReport(now = Date.now()) {
  const all = [...store.values()]
  return {
    count: all.length,
    active: all.filter((t) => !t.used && t.expiresAt > now).map((t) => ({ id: t.id, target: t.target, operation: t.operation, expiresAt: t.expiresAt })),
    used: all.filter((t) => t.used).length,
    expired: all.filter((t) => !t.used && t.expiresAt <= now).length,
    recent: events.slice(-20),
  }
}

export function resetEscalations() {
  store.clear()
  events.length = 0
}
