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
  ]
}
