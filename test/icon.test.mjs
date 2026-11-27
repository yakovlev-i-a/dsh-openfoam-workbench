// The row mark is an SVG mask generated from inline-icon.svg. The drawing is a
// file the maintainer edits by hand, so the test fails when the embedded copy
// drifts: run `node scripts/make-icon-mask.mjs` instead of editing client.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the embedded mask is regenerated from inline-icon.svg', () => {
  execFileSync(process.execPath, [join(root, 'scripts/make-icon-mask.mjs'), '--check'], { cwd: root, stdio: 'pipe' })
})

test('the mark carries no colour of its own', () => {
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const match = /const MARK_URL = 'url\("data:image\/svg\+xml;base64,([^"]+)"\)'/u.exec(client)
  assert.ok(match, 'client.js must embed the mask')
  const svg = Buffer.from(match[1], 'base64').toString('utf8')
  // A mask is read through its alpha channel: black is the only colour allowed,
  // and a hex colour anywhere else would mean the drawing leaked into the row.
  const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/gu)].map((m) => m[1])
  assert.ok(colours.length > 0, 'the mask must draw something')
  for (const colour of colours) {
    assert.ok(colour === '#000' || colour === 'none', `unexpected colour in the mask: ${colour}`)
  }
  assert.doesNotMatch(client, /#3b518c|#9db4e0/u, 'the row keeps the DSH palette, not a second accent')
})
