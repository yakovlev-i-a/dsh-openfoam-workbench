// The ParaView entry file: one convention (`<case-dir-name>.foam`) and a doctor
// finding for everything else a case may have inherited along the way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foamFiles, strayFoamFiles } from '../lib/of-case.js'
import { checkFoamEntry } from '../lib/of-engine.js'

function caseDir(name, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-foamentry-'))
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'system-controlDict-placeholder'), '')
  mkdirSync(join(dir, 'system'), { recursive: true })
  writeFileSync(join(dir, 'system', 'controlDict'), 'application icoFoam;\n')
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content)
  return dir
}

test('foam files: the accepted name is the case directory name', () => {
  const dir = caseDir('ball-packing-CHT', { 'case.foam': '\n', 'ball-packing-CHT.foam': '' })
  assert.deepEqual(foamFiles(dir), ['ball-packing-CHT.foam', 'case.foam'])
  assert.deepEqual(strayFoamFiles(dir), ['case.foam'], 'case.foam is never the entry file')
})

test('a stray case.foam next to the right one is a warning with a delete fix', () => {
  const dir = caseDir('myCase', { 'case.foam': '\n', 'myCase.foam': '' })
  const found = checkFoamEntry(dir)
  const stray = found.find((f) => f.rule === 'stray-foam-file')
  assert.ok(stray, 'the doctor must see the stray')
  assert.equal(stray.severity, 'warn')
  assert.match(stray.title, /`case\.foam`/)
  assert.match(stray.title, /`myCase\.foam`/, 'the fix names the convention')
  assert.match(stray.fix, /^Delete the stray: rm 'case\.foam'$/)
})

test('a case that only has case.foam is told to rename it, not delete it', () => {
  const dir = caseDir('myCase', { 'case.foam': '\n' })
  const stray = checkFoamEntry(dir).find((f) => f.rule === 'stray-foam-file')
  assert.ok(stray)
  assert.match(stray.detail, /openfoam_render/, 'the consequence is spelled out')
  assert.match(stray.fix, /rename it|Rename it/)
  assert.doesNotMatch(stray.fix, /^Delete/)
})

test('a leftover render helper from an older build is reported', () => {
  const dir = caseDir('myCase', { 'myCase.foam': '', '.pv_render.py': 'print(1)\n' })
  const found = checkFoamEntry(dir)
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.equal(found[0].rule, 'stale-render-script')
  assert.match(found[0].detail, /temp directory/)
})

test('a clean case reports nothing', () => {
  assert.deepEqual(checkFoamEntry(caseDir('myCase', { 'myCase.foam': '' })), [])
  assert.deepEqual(checkFoamEntry(caseDir('myCase')), [], 'no entry file yet is not a problem')
})

test('the render script never falls back to a hardcoded entry-file name', async () => {
  const { PV_RENDER_SCRIPT } = await import('../lib/presentation.js')
  // A `case.foam` written by the renderer would be a file the plugin's own finder
  // refuses, so the fallback must derive the name from the case directory.
  assert.doesNotMatch(PV_RENDER_SCRIPT, /'case\.foam'/)
  assert.match(PV_RENDER_SCRIPT, /os\.path\.basename\(os\.path\.normpath\(case\)\) \+ '\.foam'/)
})
