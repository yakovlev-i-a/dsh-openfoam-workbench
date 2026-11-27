#!/usr/bin/env node
// Regenerate the inline SVG mask in client.js from the drawing in the repository.
//
// The browser half injects one stylesheet; the mark inside it is an SVG *mask*
// painted with `currentColor`, so the row can colour it. A mask only reads the
// alpha channel, which means the drawing may be any colour and its own fills and
// strokes never reach the page.
//
//   node scripts/make-icon-mask.mjs            # rewrite the constant in client.js
//   node scripts/make-icon-mask.mjs --check    # exit 1 when client.js is stale
//
// The source keeps its Inkscape scaffolding; this script strips the editor
// metadata and the light guide path that is not part of the glyph, and flattens
// every element to black.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'inline-icon.svg')
const TARGET = join(root, 'client.js')
const CHECK = process.argv.includes('--check')

const svg = readFileSync(SOURCE, 'utf8')
const viewBox = /viewBox="([^"]+)"/u.exec(svg)?.[1]
if (!viewBox) throw new Error(`${SOURCE} has no viewBox`)

const body = svg
  .replace(/<\?xml[^>]*\?>/u, '')
  .replace(/<!--[\s\S]*?-->/gu, '')
  .replace(/<sodipodi:namedview[\s\S]*?<\/sodipodi:namedview>/gu, '')
  .replace(/<metadata[\s\S]*?<\/metadata>/gu, '')
  // The thin light-blue line is a page guide in the editor, not part of the mark.
  .replace(/<path[^>]*stroke:#b2c9d1[^>]*\/>/gu, '')

const parts = []
for (const [, tag, attrs] of body.matchAll(/<(path|circle)\b([^>]*?)\/?>/gu)) {
  if (tag === 'circle') {
    const cx = /cx="([^"]*)"/u.exec(attrs)?.[1]
    const cy = /cy="([^"]*)"/u.exec(attrs)?.[1]
    const r = /\sr="([^"]*)"/u.exec(attrs)?.[1]
    if (cx === undefined || cy === undefined || r === undefined) throw new Error('a <circle> without cx/cy/r')
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000"/>`)
    continue
  }
  const d = /\sd="([^"]*)"/u.exec(attrs)?.[1]
  if (d === undefined) throw new Error('a <path> without d')
  const filled = /fill:\s*#(?:0{3}|0{6})/u.test(attrs) && !/fill:\s*none/u.test(attrs)
  if (filled) {
    parts.push(`<path d="${d}" fill="#000"/>`)
  } else {
    const width = /stroke-width:\s*([\d.]+)/u.exec(attrs)?.[1] ?? '15'
    parts.push(`<path d="${d}" fill="none" stroke="#000" stroke-width="${width}"/>`)
  }
}

const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${parts.join('')}</svg>`
const base64 = Buffer.from(mask, 'utf8').toString('base64')
const constant = `const MARK_URL = 'url("data:image/svg+xml;base64,${base64}")'`

const client = readFileSync(TARGET, 'utf8')
const current = /^(\s*)const MARK_URL = .*$/mu.exec(client)
if (!current) throw new Error(`${TARGET} has no const MARK_URL line`)
if (current[0].trim() === constant) {
  console.log(`icon mask is current (${parts.length} elements, ${mask.length} bytes, ${base64.length} base64 chars)`)
  process.exit(0)
}
if (CHECK) {
  console.error('client.js is stale: run `node scripts/make-icon-mask.mjs`')
  process.exit(1)
}
writeFileSync(TARGET, client.replace(current[0], `${current[1]}${constant}`))
console.log(`rewrote MARK_URL from ${SOURCE}: ${parts.length} elements, ${mask.length} bytes, ${base64.length} base64 chars`)
