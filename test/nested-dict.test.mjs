// `PIMPLE/maxDeltaT` — the entry that switches LTS on lives inside a block, and a
// line editor that only sees the top level cannot reach it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import {
  entryValueAtPath, findSubDictBlock, keysAtPath, removeEntryAtPath, replaceEntryAtPath, splitEntryPath,
} from '../lib/tools/case.js'

const FV_SOLUTION = [
  'FoamFile',
  '{',
  '    version     2.0;',
  '}',
  'solvers',
  '{',
  '    p { solver GAMG; }',
  '}',
  'PIMPLE',
  '{',
  '    nOuterCorrectors 3;',
  '    maxCo 0.5;',
  '}',
].join('\n') + '\n'

function mount(root) {
  const tools = {}
  apply({
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register(t) { tools[t.name] = t } },
    on() {},
    get() { return undefined },
  }, { caseRoots: [root] })
  return tools
}

function makeCase() {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-nested-'))
  const dir = join(root, 'caseA')
  mkdirSync(join(dir, 'system'), { recursive: true })
  writeFileSync(join(dir, 'system/fvSolution'), FV_SOLUTION)
  writeFileSync(join(dir, 'system/controlDict'), 'application foamRun;\nendTime 1;\n')
  return { root, dir }
}

test('splitEntryPath accepts one, two and three keywords and nothing else', () => {
  assert.deepEqual(splitEntryPath('deltaT'), { ok: true, path: ['deltaT'] })
  assert.deepEqual(splitEntryPath('PIMPLE/maxDeltaT'), { ok: true, path: ['PIMPLE', 'maxDeltaT'] })
  assert.deepEqual(splitEntryPath(' a / b '), { ok: true, path: ['a', 'b'] })
  assert.equal(splitEntryPath('').ok, false)
  assert.equal(splitEntryPath('PIMPLE/{').ok, false)
  assert.equal(splitEntryPath('a#b').ok, false)
  assert.equal(splitEntryPath('a/b/c/d').ok, false)
})

test('a nested key is read and rewritten in place, every other line untouched', () => {
  assert.equal(entryValueAtPath(FV_SOLUTION, ['PIMPLE', 'maxCo']), '0.5')
  assert.equal(entryValueAtPath(FV_SOLUTION, ['nope']), null)
  const r = replaceEntryAtPath(FV_SOLUTION, ['PIMPLE', 'maxCo'], '1', false)
  assert.equal(r.ok, true)
  assert.equal(entryValueAtPath(r.text, ['PIMPLE', 'maxCo']), '1')
  assert.equal(r.text.split('\n').length, FV_SOLUTION.split('\n').length)
  assert.match(r.text, /solvers\n\{\n {4}p \{ solver GAMG; \}\n\}/)
})

test('an appended nested key inherits the block indentation', () => {
  const r = replaceEntryAtPath(FV_SOLUTION, ['PIMPLE', 'maxDeltaT'], '0.05', true)
  assert.equal(r.ok, true)
  assert.match(r.text, /\n {4}maxDeltaT 0\.05;\n\}/)
  assert.equal(entryValueAtPath(r.text, ['PIMPLE', 'maxDeltaT']), '0.05')
  // A missing key is not created without append.
  assert.equal(replaceEntryAtPath(FV_SOLUTION, ['PIMPLE', 'alphaTemp'], '1', false).reason, 'not-found')
  assert.equal(replaceEntryAtPath(FV_SOLUTION, ['SIMPLE', 'maxCo'], '1', true).reason, 'no-subdictionary')
})

test('keysAtPath sees the block level, so the structure guard works there', () => {
  // keysAtPath answers for the level the *path* addresses: `PIMPLE/maxCo` -> the
  // keys of the PIMPLE block.
  assert.deepEqual(keysAtPath(FV_SOLUTION, ['PIMPLE', 'maxCo']).sort(), ['maxCo', 'nOuterCorrectors'])
  assert.equal(keysAtPath(FV_SOLUTION, ['nope', 'x']).length, 0)
  const removed = removeEntryAtPath(FV_SOLUTION, ['PIMPLE', 'maxCo'])
  assert.equal(removed.ok, true)
  assert.equal(entryValueAtPath(removed.text, ['PIMPLE', 'maxCo']), null)
  assert.deepEqual(keysAtPath(removed.text, ['PIMPLE', 'maxCo']), ['nOuterCorrectors'])
})

test('a one-line block still resolves', () => {
  const oneLine = 'PIMPLE { maxCo 0.5; }\n'
  const r = replaceEntryAtPath(oneLine, ['PIMPLE', 'maxDeltaT'], '0.2', true)
  assert.equal(r.ok, true)
  assert.equal(r.text.trim(), 'PIMPLE { maxCo 0.5; maxDeltaT 0.2; }')
})

test('findSubDictBlock finds a brace on its own line', () => {
  const lines = FV_SOLUTION.split('\n')
  const blk = findSubDictBlock(lines, 0, lines.length, 'PIMPLE')
  assert.equal(blk.single, false)
  assert.equal(lines[blk.open].trim(), 'nOuterCorrectors 3;')
})

test('dict_set writes PIMPLE/maxDeltaT, refuses a missing block, and undoes it', async () => {
  const { root, dir } = makeCase()
  try {
    const tools = mount(root)
    const preview = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'fvSolution', entry: 'PIMPLE/maxDeltaT', value: '0.05', append: true })
    assert.equal(preview.applied, false)
    assert.equal(preview.impact, 'high')
    const applied = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'fvSolution', entry: 'PIMPLE/maxDeltaT', value: '0.05', append: true, apply: true })
    assert.equal(applied.applied, true)
    assert.match(readFileSync(join(dir, 'system/fvSolution'), 'utf8'), / {4}maxDeltaT 0\.05;/)
    const bad = await tools.openfoam_dict_set.execute({ casePath: dir, file: 'fvSolution', entry: 'SIMPLE/maxCo', value: '1', apply: true })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /no sub-dictionary SIMPLE/)
    const undo = await tools.openfoam_dict_undo.execute({ casePath: dir, changeId: applied.changeId })
    assert.equal(undo.applied, true)
    assert.equal(undo.removed, true)
    assert.doesNotMatch(readFileSync(join(dir, 'system/fvSolution'), 'utf8'), /maxDeltaT/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
