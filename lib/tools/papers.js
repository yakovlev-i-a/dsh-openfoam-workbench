import { textOut } from '../runtime.js'
import { paperExtract, paperFetch, paperSearch, readDocument, readPaper } from '../paperlib.js'

export default function papersTools({ cfg }) {
  return [
  // --- tool: paper parameter verify ---
  {
    name: 'openfoam_paper_param_verify',
    description: 'Sanity-check extracted paper parameters: non-empty finite values, and (when expected_units is given) that every expected parameter is present and its unit is a known dimension.',
    parameters: {
      type: 'object',
      properties: { params: { type: 'object' }, expected_units: { type: 'object' } },
      required: ['params'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const params = args.params || {}
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
      return { ok: true, pass: issues.length === 0, issues }
    },
  },
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
    description: 'Heuristically extract numbered equations, tables and numeric parameters from a PDF (grounded — nothing invented).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, focus: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => paperExtract(cfg, args),
  },
  // --- tool: read a document ---
  {
    name: 'openfoam_read_document',
    description: 'Read a local document: PDF (text via pdftotext/pymupdf) or plain text formats (txt/md/csv/log/dat/json/yaml).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    execute: async (args) => readDocument(cfg, args),
  },
  ]
}
