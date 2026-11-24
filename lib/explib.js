import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureExpDir, experienceDirOf, resolveCase } from './runtime.js'
import { loadErrorPatterns } from './knowledge.js'

export function loadExperience(cfg) {
  const d = experienceDirOf(cfg)
  let names = []
  try { names = readdirSync(d) } catch { return [] }
  const cards = []
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('_')) continue
    try {
      const c = JSON.parse(readFileSync(join(d, n), 'utf8'))
      if (c && c.id) cards.push(c)
    } catch {}
  }
  return cards
}

export function contentHash(card) {
  return createHash('sha1')
    .update(JSON.stringify({ t: String(card.title || '').toLowerCase().trim(), r: (card.recipe || []).map((x) => String(x).toLowerCase().trim()), k: card.key_params || {}, p: (card.pitfalls || []).map((x) => String(x).toLowerCase().trim()) }))
    .digest('hex')
    .slice(0, 16)
}

export function saveExperience(cfg, input) {
  const d = ensureExpDir(cfg)
  const card = {
    id: '',
    title: String(input.title || 'Untitled'),
    domain: String(input.domain || 'general'),
    triggers: Array.isArray(input.triggers) ? input.triggers.map(String) : [],
    solver: String(input.solver || ''),
    physics: String(input.physics || ''),
    recipe: Array.isArray(input.recipe) ? input.recipe.map(String) : [],
    key_params: input.key_params && typeof input.key_params === 'object' ? input.key_params : {},
    verify_seq: Array.isArray(input.verify_seq) ? input.verify_seq.map(String) : [],
    pitfalls: Array.isArray(input.pitfalls) ? input.pitfalls.map(String) : [],
    provenance: input.provenance && typeof input.provenance === 'object' ? input.provenance : {},
  }
  card.content_hash = contentHash(card)
  const all = loadExperience(cfg)
  const ex = all.find((c) => c.content_hash === card.content_hash)
  if (ex) {
    ex.stats = ex.stats || { hits: 0 }
    ex.stats.hits = (ex.stats.hits || 0) + 1
    ex.stats.updated = Date.now()
    writeFileSync(join(d, ex.id + '.json'), JSON.stringify(ex, null, 2))
    return { ok: true, id: ex.id, deduped: true }
  }
  const slug = (card.solver || card.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'card'
  card.id = `${card.domain}-${slug}-${card.content_hash.slice(0, 6)}`
  card.stats = { created: Date.now(), updated: Date.now(), hits: 0 }
  writeFileSync(join(d, card.id + '.json'), JSON.stringify(card, null, 2))
  return { ok: true, id: card.id, deduped: false }
}

export function recallExperience(cfg, query, topK = 3) {
  const text = String(query || '').toLowerCase()
  if (!text.trim()) return { ok: true, count: 0, cards: [] }
  const scored = []
  for (const card of loadExperience(cfg)) {
    let score = 0
    for (const t of card.triggers || []) {
      const trig = String(t).toLowerCase().trim()
      if (trig.length >= 3 && text.includes(trig)) score += 1 + Math.min(trig.length / 12, 2)
    }
    const solver = String(card.solver || '').toLowerCase()
    if (solver.length >= 4 && text.includes(solver.split(/[\s(]/)[0])) score += 1.5
    score += Math.min((card.stats && card.stats.hits ? card.stats.hits : 0) * 0.05, 0.5)
    if (score > 0) scored.push({ card, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return { ok: true, count: Math.min(scored.length, topK), cards: scored.slice(0, Math.max(1, topK)).map((x) => x.card) }
}

export function forgetExperience(cfg, id) {
  const d = experienceDirOf(cfg)
  const p = join(d, String(id) + '.json')
  if (!existsSync(p)) return { ok: false, error: 'no such experience: ' + id }
  try { rmSync(p) } catch (e) { return { ok: false, error: String(e.message || e) } }
  return { ok: true, id }
}

export function exportExperience(cfg, outPath) {
  const d = ensureExpDir(cfg)
  const file = outPath ? resolveCase(cfg, outPath) : join(d, 'experience-bundle.json')
  const cards = loadExperience(cfg)
  const payload = { format: 'openfoam-workbench-experience', version: 1, exported_at: Date.now(), cards, error_patterns: loadErrorPatterns(cfg) }
  writeFileSync(file, JSON.stringify(payload, null, 2))
  return { ok: true, count: cards.length, path: file }
}

export function importExperience(cfg, inPath) {
  const file = resolveCase(cfg, inPath)
  if (!existsSync(file)) return { ok: false, error: 'bundle not found: ' + file }
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return { ok: false, error: 'bad JSON: ' + e.message } }
  let imported = 0
  for (const c of data.cards || []) {
    const r = saveExperience(cfg, c)
    if (r.ok && !r.deduped) imported++
  }
  for (const e of data.error_patterns || []) addErrorPattern(cfg, e)
  return { ok: true, imported, path: file }
}

export function addErrorPattern(cfg, input) {
  const d = ensureExpDir(cfg)
  const pattern = String(input.pattern || '').trim()
  if (!pattern) return { ok: false, error: 'pattern is empty' }
  try { new RegExp(pattern, input.flags || 'i') } catch (e) { return { ok: false, error: 'invalid regex: ' + e.message } }
  const arr = loadErrorPatterns(cfg)
  const cat = String(input.category || 'Learned error')
  const ex = arr.find((e) => e.pattern === pattern && e.category === cat)
  if (ex) {
    ex.hits = (ex.hits || 0) + 1
    writeFileSync(join(d, '_error_patterns.json'), JSON.stringify(arr, null, 2))
    return { ok: true, deduped: true, total: arr.length }
  }
  arr.push({ pattern, flags: input.flags || 'i', category: cat, causes: input.causes || [], steps: input.steps || [], hits: 0, ts: Date.now() })
  writeFileSync(join(d, '_error_patterns.json'), JSON.stringify(arr, null, 2))
  return { ok: true, deduped: false, total: arr.length }
}

export function appendSft(cfg, sample) {
  const d = ensureExpDir(cfg)
  const file = join(d, '_sft.jsonl')
  appendFileSync(file, JSON.stringify(sample) + '\n')
  let total = 0
  try { total = readFileSync(file, 'utf8').split('\n').filter(Boolean).length } catch {}
  return { ok: true, path: file, total }
}

// --- pvpython render helper ---
