import { textOut } from '../runtime.js'
import { addErrorPattern, appendSft, exportExperience, forgetExperience, importExperience, loadExperience, recallExperience, saveExperience } from '../explib.js'

export default function experienceTools({ cfg }) {
  return [
  // --- tool: experience save ---
  {
    name: 'openfoam_experience_save',
    description: 'Distil a verified practice into a reusable experience card (deduped by content hash). Save only after a verifier passed.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        domain: { type: 'string' },
        triggers: { type: 'array', items: { type: 'string' } },
        solver: { type: 'string' },
        physics: { type: 'string' },
        recipe: { type: 'array', items: { type: 'string' } },
        key_params: { type: 'object' },
        verify_seq: { type: 'array', items: { type: 'string' } },
        pitfalls: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => saveExperience(cfg, args),
  },
  // --- tool: experience recall ---
  {
    name: 'openfoam_experience_recall',
    description: 'Recall the most relevant experience cards for a task by trigger/solver keyword scoring. Call at the start of a non-trivial task.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => recallExperience(cfg, args.query, Math.min(Number(args.top_k) || 3, 10)),
  },
  // --- tool: experience list ---
  {
    name: 'openfoam_experience_list',
    description: 'List the experience cards (id, domain, title, triggers, hits).',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async () => {
      const cards = loadExperience(cfg).map((c) => ({ id: c.id, domain: c.domain, title: c.title, triggers: c.triggers, hits: c.stats && c.stats.hits }))
      return { ok: true, count: cards.length, cards }
    },
  },
  // --- tool: experience forget ---
  {
    name: 'openfoam_experience_forget',
    description: 'Delete one experience card by id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => forgetExperience(cfg, args.id),
  },
  // --- tool: experience export ---
  {
    name: 'openfoam_experience_export',
    description: 'Pack the experience library (cards + learned error patterns) into one JSON bundle for sharing or migration.',
    parameters: {
      type: 'object',
      properties: { out_path: { type: 'string' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => exportExperience(cfg, args.out_path),
  },
  // --- tool: experience import ---
  {
    name: 'openfoam_experience_import',
    description: 'Import experience cards and error patterns from a bundle JSON (deduped).',
    parameters: {
      type: 'object',
      properties: { in_path: { type: 'string' } },
      required: ['in_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute: async (args) => importExperience(cfg, args.in_path),
  },
  // --- tool: learn error pattern ---
  {
    name: 'openfoam_learn_error_pattern',
    description: 'Register a new error pattern (regex + category + causes + steps) so openfoam_diagnose_error matches it next time.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        flags: { type: 'string' },
        category: { type: 'string' },
        causes: { type: 'array', items: { type: 'string' } },
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['pattern', 'category'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => addErrorPattern(cfg, args),
  },
  // --- tool: experience export SFT ---
  {
    name: 'openfoam_experience_export_sft',
    description: 'Append a verified sample (jsonl) to the SFT corpus for future local fine-tuning.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        domain: { type: 'string' },
        sample: { type: 'object', description: 'Opaque JSON sample to store.' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: async (args) => appendSft(cfg, { ts: Date.now(), label: args.label || '', domain: args.domain || 'general', sample: args.sample || null }),
  },
  // --- tool: experience eval compare ---
  {
    name: 'openfoam_experience_eval_compare',
    description: 'Compare two evaluation records (A/B) and report the difference in pass rate / error-iteration count.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'object' },
        b: { type: 'object' },
      },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const a = args.a || {}
      const b = args.b || {}
      const rate = (r) => (r && typeof r.verifyPassRate === 'number' ? r.verifyPassRate : null)
      const iters = (r) => (r && typeof r.errorIters === 'number' ? r.errorIters : null)
      const ra = rate(a), rb = rate(b), ia = iters(a), ib = iters(b)
      let verdict = 'insufficient data'
      if (ra != null && rb != null) {
        if (rb > ra) verdict = 'B (with skill) wins on pass rate'
        else if (rb < ra) verdict = 'A (baseline) wins on pass rate'
        else verdict = 'tie on pass rate'
      }
      return { ok: true, a: { label: a.label || 'A', verifyPassRate: ra, errorIters: ia }, b: { label: b.label || 'B', verifyPassRate: rb, errorIters: ib }, verdict }
    },
  },
  ]
}
