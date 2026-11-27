// The writing side of 0/: rewriting a per-cell list into one uniform value, and
// building setFieldsDict. These tests never need OpenFOAM installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPlan, boundaryPatchNames, boxOverlapsMesh, checkValueForClass, listSummary, listValues, normaliseZone, setFieldsDictText, splitFieldFile, templatePlan, zeroFields } from '../lib/fieldwrite.js'

const FIELD = (cls, internal, patches) => `/*--------------------------------*- C++ -*----------------------------------*\\
FoamFile
{
    format      ascii;
    class       ${cls};
    location    "0";
    object      field;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

dimensions      [0 0 0 1 0 0 0];

internalField   ${internal};

boundaryField
{
${patches
  .map(
    (p) => `    ${p}
    {
        type            ${p === 'wall' ? 'zeroGradient' : 'fixedValue'};
        value           uniform 0;
    }`,
  )
  .join('\n')}
}

// ************************************************************************* //
`

const BOUNDARY = (names) => `FoamFile { format ascii; class polyBoundaryMesh; object boundary; }
${names.length}(${names
  .map(
    (n, i) => `
    ${n}
    {
        type            patch;
        nFaces          ${10 + i};
        startFace       ${100 * i};
    }`,
  )
  .join('')}
)
`

function caseDir(root, { fields = {}, patches = ['inlet', 'outlet', 'wall'], region = '' }) {
  const dir = mkdtempSync(join(root, 'ofw-case-'))
  mkdirSync(join(dir, '0', region), { recursive: true })
  mkdirSync(join(dir, 'constant', region, 'polyMesh'), { recursive: true })
  writeFileSync(join(dir, 'constant', region, 'polyMesh', 'boundary'), BOUNDARY(patches))
  for (const [name, text] of Object.entries(fields)) writeFileSync(join(dir, '0', region, name), text)
  return dir
}

test('listValues reads the values, not the element count', () => {
  assert.deepEqual(listValues('internalField   nonuniform List<scalar> \n3\n(\n1\n2\n)\n;'), [1, 2])
  assert.deepEqual(listValues('nonuniform List<scalar> 3(0.5 -1e-05 300)'), [0.5, -1e-05, 300])
  assert.deepEqual(listValues('nonuniform List<vector> 2((1 0 0)(0 2 0))'), [1, 0, 0, 0, 2, 0])
})

test('listSummary reports count, range and the most frequent entry', () => {
  const s = listSummary('nonuniform List<scalar> 4(300 300 300 450)')
  assert.equal(s.count, 4)
  assert.equal(s.min, 300)
  assert.equal(s.max, 450)
  assert.equal(s.mode, 300)
  assert.equal(s.modeShare, 0.75)
  assert.equal(listSummary('uniform 0'), null)
})

test('splitFieldFile keeps the header and the boundaryField, and names the patches', () => {
  const text = FIELD('volScalarField', 'nonuniform List<scalar> \n2(300 300) \n', ['inlet', 'wall'])
  const parts = splitFieldFile(text)
  assert.ok(parts.head.includes('dimensions'))
  assert.ok(parts.internalStatement.startsWith('internalField'))
  assert.ok(parts.boundary.startsWith('boundaryField'))
  assert.deepEqual(boundaryPatchNames(text), ['inlet', 'wall'])
  assert.match(splitFieldFile('no internal field here').error, /no internalField/)
})

test('checkValueForClass counts components', () => {
  assert.equal(checkValueForClass('volScalarField', '300').ok, true)
  assert.equal(checkValueForClass('volScalarField', '(1 0 0)').ok, false)
  assert.equal(checkValueForClass('volVectorField', '(0 1.75 0)').ok, true)
  assert.match(checkValueForClass('volVectorField', '1').error, /takes 3 components/)
  assert.equal(checkValueForClass('volSymmTensorField', '(1 0 0 1 0 1)').ok, true)
  assert.equal(checkValueForClass('volSymmTensorField', '(1 0 0)').ok, false)
})

test('zeroFields ignores backups and non-field files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ofw-zero-'))
  const dir = caseDir(root, { fields: { T: FIELD('volScalarField', 'uniform 300', ['wall']), 'T.bak': FIELD('volScalarField', 'uniform 1', ['wall']) } })
  writeFileSync(join(dir, '0', 'notes.txt'), 'not a field')
  const names = zeroFields(dir).map((f) => f.name)
  assert.deepEqual(names, ['T'])
})

test('templatePlan turns a per-cell list into needsValue and keeps a uniform field', () => {
  const root = mkdtempSync(join(tmpdir(), 'ofw-plan-'))
  const template = caseDir(root, {
    fields: { T: FIELD('volScalarField', 'nonuniform List<scalar> \n3(300 300 450) \n', ['inlet', 'outlet', 'wall']), p: FIELD('volScalarField', 'uniform 101325', ['inlet', 'outlet', 'wall']) },
  })
  // The new mesh has no `outlet` patch: that boundary entry is stale.
  const target = caseDir(root, { patches: ['inlet', 'wall'] })
  const plan = templatePlan({ caseDir: target, templateDir: template })
  const byName = Object.fromEntries(plan.fields.map((f) => [f.name, f]))
  assert.equal(byName.T.kind, 'list')
  assert.equal(byName.T.needsValue, true)
  assert.equal(byName.T.suggestion.value, 300)
  assert.equal(byName.T.list.count, 3)
  assert.deepEqual(byName.T.stalePatches, ['outlet'])
  assert.equal(byName.p.value, '101325')
  assert.deepEqual(plan.needsValue, ['T'])
  assert.equal(plan.canWrite, false)
  assert.match(plan.hint, /values: \{"T": 300\}/)

  const given = templatePlan({ caseDir: target, templateDir: template, values: { T: '310' } })
  assert.equal(given.canWrite, true)
  assert.equal(given.fields.find((f) => f.name === 'T').value, '310')

  const bad = templatePlan({ caseDir: target, templateDir: template, values: { p: '(1 0 0)' } })
  assert.equal(bad.canWrite, false)
  assert.match(bad.problems[0].error, /scalar, not/)
})

test('applyPlan rewrites only the internalField and keeps a .bak', () => {
  const root = mkdtempSync(join(tmpdir(), 'ofw-apply-'))
  const template = caseDir(root, {
    fields: { T: FIELD('volScalarField', 'nonuniform List<scalar> \n2(300 300) \n', ['inlet', 'wall']) },
  })
  const target = caseDir(root, { fields: { T: FIELD('volScalarField', 'nonuniform List<scalar> \n9(1 1 1 1 1 1 1 1 1) \n', ['inlet', 'wall']) } })
  const plan = templatePlan({ caseDir: target, templateDir: template, values: { T: '300' } })
  const applied = applyPlan(plan, { backup: true })
  assert.equal(applied.ok, true)
  assert.equal(applied.written[0].from, '2-value list')
  assert.equal(applied.written[0].to, '300')
  const text = readFileSync(join(target, '0', 'T'), 'utf8')
  assert.match(text, /internalField {3}uniform 300;/)
  assert.match(text, /boundaryField/)
  assert.match(text, /fixedValue/)
  assert.ok(existsSync(join(target, '0', 'T.bak')))
  // Applying the same plan twice changes nothing the second time.
  const again = applyPlan(plan)
  assert.equal(again.written[0].changed, false)
})

test('normaliseZone infers the type and rejects broken geometry', () => {
  const box = normaliseZone({ name: 'hot', box: { min: [0, 0, 0], max: [1, 2, 3] }, values: { T: 450 } }, 0)
  assert.equal(box.type, 'box')
  assert.equal(box.params.box, '(0 0 0) (1 2 3)')
  assert.deepEqual(box.values, { T: 450 })
  const set = normaliseZone({ set: 'fluidCells', values: { T: 300 } }, 1)
  assert.equal(set.type, 'set')
  assert.equal(set.params.set, 'fluidCells')
  assert.match(normaliseZone({ name: 'bad', box: { min: [0, 0], max: [1, 1, 1] }, values: { T: 1 } }, 2).error, /three numbers/)
  assert.match(normaliseZone({ name: 'bad', values: {} }, 3).error, /no values/)
  assert.match(normaliseZone({ name: 'bad', type: 'blob', params: { x: '1' }, values: { T: 1 } }, 4).error, /unknown zone type/)
  assert.match(normaliseZone({ name: 'bad', type: 'sphere', origin: [0, 0, 0], values: { T: 1 } }, 5).error, /needs origin, radius/)
})

test('setFieldsDictText writes an org-14 dictionary', () => {
  const text = setFieldsDictText({
    defaultValues: { T: 300, U: '(0 0 0)' },
    zones: [normaliseZone({ name: 'hot', box: { min: [0, 0, 0], max: [0.01, 0.01, 0.01] }, values: { T: 450 } }, 0)],
    extrapolatePatches: { 'inlet|outlet': ['T'] },
  })
  assert.match(text, /class\s+dictionary;/)
  assert.match(text, /defaultValues\n\{\n {4}T {12}300;\n {4}U {12}\(0 0 0\);/)
  assert.match(text, /zones\n\{\n {4}hot\n {4}\{/)
  assert.match(text, /type\s+box;/)
  assert.match(text, /box\s+\(0 0 0\) \(0\.01 0\.01 0\.01\);/)
  assert.match(text, /values\n {8}\{\n {12}T {10}450;/)
  assert.match(text, /extrapolatePatches\n\{\n {4}"inlet\|outlet" {3}\(T\);/)
})

test('boxOverlapsMesh flags a box that misses the mesh', () => {
  const bounds = { min: [0, 0, 0], max: [1, 1, 0.001] }
  assert.equal(boxOverlapsMesh({ min: [0.2, 0.2, 0], max: [0.4, 0.4, 0] }, bounds).ok, true)
  const miss = boxOverlapsMesh({ min: [2, 2, 0], max: [3, 3, 0] }, bounds)
  assert.equal(miss.ok, false)
  assert.match(miss.error, /does not overlap the mesh/)
  assert.equal(boxOverlapsMesh({ min: [0, 0, 0], max: [1, 1, 1] }, null).ok, true)
})
