import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { readText, resolveCase, run } from './runtime.js'

export async function pdfText(cfg, file) {
  const bin = cfg.pdftotext || 'pdftotext'
  const r = await run(bin, ['-layout', file, '-'], { timeoutMs: 120000 })
  if (r.ok && r.stdout.trim()) return { ok: true, text: r.stdout, tool: 'pdftotext' }
  const py = cfg.pythonPath || 'python3'
  const script = 'import sys, fitz\nd = fitz.open(sys.argv[1])\nprint("\\n".join(p.get_text() for p in d))'
  const r2 = await run(py, ['-c', script, file], { timeoutMs: 120000 })
  if (r2.ok && r2.stdout.trim()) return { ok: true, text: r2.stdout, tool: 'pymupdf' }
  return { ok: false, error: 'PDF text extraction failed', log: ((r.stderr || '') + (r2.stderr || '')).slice(-1000) }
}

export function splitSections(text) {
  const out = { body: [] }
  let cur = 'body'
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    let key = null
    if (/^\d+\.?\s+[A-Z][^\n]{0,80}$/.test(t) && t.length < 90) {
      key = slug(t)
    } else if (/^(Abstract|References)\b/i.test(t) && t.length < 60) {
      key = t.toLowerCase().split(/\s/)[0]
    }
    if (key) cur = key
    if (!out[cur]) out[cur] = []
    out[cur].push(line)
  }
  const res = {}
  for (const [k, v] of Object.entries(out)) res[k] = v.join('\n').trim().slice(0, 20000)
  return res
}

export async function paperSearch(cfg, args) {
  const q = String(args.query || '')
  if (!q) return { ok: false, error: 'empty query' }
  const limit = Math.min(Number(args.top_k) || 10, 50)
  const merge = []
  const errors = []
  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,venue,citationCount,abstract,externalIds,openAccessPdf`
    const r = await fetch(url, { headers: { 'User-Agent': 'openfoam-workbench/0.1' }, signal: AbortSignal.timeout(20000) })
    if (r.ok) {
      const j = await r.json()
      for (const p of j.data || []) {
        merge.push({ source: 's2', title: p.title, authors: (p.authors || []).map((a) => a.name), year: p.year, venue: p.venue, citations: p.citationCount, doi: p.externalIds && p.externalIds.DOI, arxiv: p.externalIds && p.externalIds.ArXiv, abstract: p.abstract, pdf: p.openAccessPdf && p.openAccessPdf.url })
      }
    } else {
      errors.push('semantic-scholar: HTTP ' + r.status)
    }
  } catch (e) {
    errors.push('semantic-scholar: ' + ((e && e.message) || e))
  }
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${limit}`
    const r = await fetch(url, { headers: { 'User-Agent': 'openfoam-workbench/0.1' }, signal: AbortSignal.timeout(25000) })
    if (r.ok) {
      const xml = await r.text()
      if (!/<entry>/.test(xml)) errors.push('arxiv: ' + xml.slice(0, 120))
      for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const e = m[1]
        const title = ((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim().replace(/\s+/g, ' ')
        const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1]
        const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1]
        merge.push({ source: 'arxiv', title, arxiv: id ? id.split('/abs/').pop() : null, year: published ? new Date(published).getFullYear() : null, pdf: id ? id.trim() : null })
      }
    } else {
      errors.push('arxiv: HTTP ' + r.status)
    }
  } catch (e) {
    errors.push('arxiv: ' + ((e && e.message) || e))
  }
  const seen = new Set()
  const out = []
  for (const p of merge) {
    const k = String(p.title || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return { ok: true, count: Math.min(out.length, limit), papers: out.slice(0, limit), errors: errors.length ? errors : null, degraded: errors.length > 0 }
}

export async function paperFetch(cfg, args) {
  const id = String(args.id || '').trim()
  if (!id) return { ok: false, error: 'empty id' }
  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=title,authors,year,venue,abstract,tldr,externalIds,openAccessPdf,references.title,references.year`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'openfoam-workbench/0.1' }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) return { ok: false, error: 'Semantic Scholar returned ' + r.status }
    const p = await r.json()
    const out = { ok: true, title: p.title, authors: (p.authors || []).map((a) => a.name), year: p.year, venue: p.venue, abstract: p.abstract, tldr: p.tldr && p.tldr.text, doi: p.externalIds && p.externalIds.DOI, arxiv: p.externalIds && p.externalIds.ArXiv, pdf: p.openAccessPdf && p.openAccessPdf.url, references: (p.references || []).slice(0, Number(args.max_refs) || 10) }
    if (args.download && p.openAccessPdf && p.openAccessPdf.url) {
      const dir = join((Array.isArray(cfg.caseRoots) && cfg.caseRoots.length ? cfg.caseRoots[0] : process.cwd()), 'downloads/papers')
      mkdirSync(dir, { recursive: true })
      const base = (p.externalIds && p.externalIds.ArXiv ? 'arxiv_' + p.externalIds.ArXiv : String(p.title || 'paper').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60)) + '.pdf'
      const file = join(dir, base)
      try {
        const pr = await fetch(p.openAccessPdf.url, { signal: AbortSignal.timeout(60000) })
        if (pr.ok) { writeFileSync(file, Buffer.from(await pr.arrayBuffer())); out.downloaded = file }
      } catch {}
    }
    return out
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export async function pdfTextBlocks(cfg, file) {
  const py = cfg.pythonPath || 'python3'
  const script = [
    'import sys, fitz',
    'doc = fitz.open(sys.argv[1])',
    'out = []',
    'for page in doc:',
    '    blocks = [b for b in page.get_text("blocks") if b[6] == 0]',
    '    if not blocks:',
    '        continue',
    '    mid = page.rect.width * 0.5',
    '    left = [b for b in blocks if b[2] <= mid + 5]',
    '    right = [b for b in blocks if b[0] >= mid - 5]',
    '    if left and right and len(left) + len(right) >= len(blocks) - 2:',
    '        left.sort(key=lambda b: (b[1], b[0]))',
    '        right.sort(key=lambda b: (b[1], b[0]))',
    '        ordered = left + right',
    '    else:',
    '        ordered = sorted(blocks, key=lambda b: (b[1], b[0]))',
    '    out.append("\\n".join(b[4].strip() for b in ordered))',
    'print("\\n\\n".join(out))',
  ].join('\n')
  const r = await run(py, ['-c', script, file], { timeoutMs: 120000 })
  if (r.ok && r.stdout.trim()) return { ok: true, text: r.stdout, tool: 'pymupdf-blocks' }
  return pdfText(cfg, file)
}

export async function readPaper(cfg, args) {
  const p = resolveCase(cfg, args.path)
  if (!p || !existsSync(p)) return { ok: false, error: 'file not found: ' + p }
  const t = await pdfTextBlocks(cfg, p)
  if (!t.ok) return t
  const sections = splitSections(t.text)
  let focusHits = null
  if (args.focus) {
    const f = String(args.focus).toLowerCase()
    focusHits = t.text.split('\n').filter((line) => line.toLowerCase().includes(f)).slice(0, 20)
  }
  return { ok: true, path: p, tool: t.tool, chars: t.text.length, sections, focusHits }
}

export async function paperExtract(cfg, args) {
  const p = resolveCase(cfg, args.path)
  if (!p || !existsSync(p)) return { ok: false, error: 'file not found: ' + p }
  const t = await pdfText(cfg, p)
  if (!t.ok) return t
  const text = t.text
  const equations = []
  for (const m of text.matchAll(/^\s*([^\n]{3,200})\s*\((\d+)\)\s*$/gm)) {
    equations.push({ eq: m[2], text: m[1].trim() })
    if (equations.length >= 60) break
  }
  const tables = []
  for (const m of text.matchAll(/\bTable\s+(\d+)[^\n]{0,120}/g)) {
    tables.push({ table: m[1], caption: m[0].trim() })
    if (tables.length >= 40) break
  }
  const params = []
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{1,20})\s*=\s*([0-9.+\-eE]+)\s*([A-Za-z/%^0-9]+)?/g)) {
    params.push({ name: m[1], value: m[2], unit: m[3] || '' })
    if (params.length >= 200) break
  }
  return { ok: true, path: p, equations, tables, params }
}

export async function readDocument(cfg, args) {
  const p = resolveCase(cfg, args.path)
  if (!p || !existsSync(p)) return { ok: false, error: 'file not found: ' + p }
  const ext = extname(p).toLowerCase()
  if (ext === '.pdf') return pdfText(cfg, p)
  if (['.txt', '.md', '.csv', '.log', '.dat', '.json', '.yaml', '.yml'].includes(ext)) {
    return { ok: true, text: (readText(p) || '').slice(0, 200000), tool: 'raw' }
  }
  return { ok: false, error: `unsupported format ${ext}; supported: pdf, txt, md, csv, log, dat, json, yaml` }
}
