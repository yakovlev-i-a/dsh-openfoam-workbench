import { textOut } from '../runtime.js'
import { paperExtract, paperFetch, paperSearch, readPaper } from '../paperlib.js'

export default function papersTools({ cfg }) {
  return [
  // --- tool: paper search ---
  {
    name: 'openfoam_paper_search',
    description: 'Search academic papers via Semantic Scholar + arXiv (merged, deduped by title). Returns title/authors/year/venue/citations/DOI/arXiv/PDF. Better than web_search for finding the original paper of an algorithm.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, top_k: { type: 'number' } },
      required: ['query'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    execute: async (args) => paperSearch(cfg, args),
  },
  // --- tool: paper fetch ---
  {
    name: 'openfoam_paper_fetch',
    description: 'Fetch paper details by DOI / ARXIV:<id> / S2 paperId (abstract, tldr, references, OA PDF link). download=true saves the OA PDF to <caseRoots[0]>/downloads/papers/.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, download: { type: 'boolean' }, max_refs: { type: 'number' } },
      required: ['id'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => paperFetch(cfg, args),
  },
  // --- tool: read a paper ---
  {
    name: 'openfoam_read_paper',
    description: 'Read a PDF and split it into sections (abstract/introduction/methods/results/conclusion/references); optional focus returns matching passages.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, focus: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => readPaper(cfg, args),
  },
  // --- tool: extract from a paper ---
  {
    name: 'openfoam_paper_extract',
    description: 'Heuristically extract numbered equations, tables and numeric parameters from a PDF (grounded — nothing invented). With verify:true it also sanity-checks the extracted parameters (finite values, expected units), so a table can be trusted before it reaches a dictionary.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        focus: { type: 'string' },
        verify: { type: 'boolean', description: 'Also validate the extracted parameters: non-empty finite values, and every expected_units key present with a known unit.' },
        expected_units: { type: 'object', description: 'With verify: {parameter: unit} map checked against the extracted parameters.' },
      },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const out = await paperExtract(cfg, args)
      if (args.verify !== true || !out || out.ok === false) return out
      // paperExtract returns params as [{name, value, unit}]; the validator wants
      // a name -> value map, so keep the numeric ones and skip the rest.
      const map = {}
      if (Array.isArray(out.params)) {
        for (const p of out.params) {
          if (!p || !p.name) continue
          const v = Number(p.value)
          if (Number.isFinite(v)) map[p.name] = v
        }
      } else if (out.parameters && typeof out.parameters === 'object') {
        Object.assign(map, out.parameters)
      }
      const params = map
      const expectedUnits = args.expected_units || {}
      const issues = []
      for (const [k, v] of Object.entries(params)) {
        if (v == null || v === '') issues.push({ param: k, issue: 'empty value' })
        else if (typeof v === 'number' && !Number.isFinite(v)) issues.push({ param: k, issue: 'non-finite value' })
      }
      const KNOWN = new Set(['m', 's', 'm/s', 'm2/s', '1/s', 'kg/m3', 'kg/s', 'pa', 'k', 'j/kg', 'w/m2', '-', ''])
      for (const [k, u] of Object.entries(expectedUnits)) {
        if (!(k in params)) issues.push({ param: k, issue: `expected unit ${u}, but the parameter is missing` })
        else if (!KNOWN.has(String(u).toLowerCase())) issues.push({ param: k, issue: `unknown unit ${u}` })
      }
      return { ...out, verify: { pass: issues.length === 0, issues, checked: Object.keys(params).length } }
    },
  },
  ]
}
