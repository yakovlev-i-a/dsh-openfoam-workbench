// Reading field files directly: the path that does not need the post-processing
// utility (which needs buildable physics, a writable case and a serial time dir).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cellCount,
  fieldClass,
  fieldTimes,
  latestFieldTime,
  mergeStats,
  parseInternalField,
  readFieldStats,
  summarise,
} from '../lib/fields.js'
import { viewPresetFor } from '../lib/presentation.js'

const header = (cls, field) => `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};
    object      ${field};
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
`

const fieldFile = (cls, name, internal) => `${header(cls, name)}
dimensions      [0 0 0 0 0 0 0];

${internal}

boundaryField
{
    inlet
    {
        type            zeroGradient;
    }
}
`

function caseWith(fields, { processors = 0, time = '0.5' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ofw-fields-'))
  const roots = processors ? Array.from({ length: processors }, (_, i) => join(dir, `processor${i}`)) : [dir]
  for (const [i, root] of roots.entries()) {
    mkdirSync(join(root, 'constant', 'polyMesh'), { recursive: true })
    mkdirSync(join(root, time), { recursive: true })
    // 4 cells per processor, so the merged cell count is checkable.
    writeFileSync(
      join(root, 'constant', 'polyMesh', 'owner'),
      `FoamFile { version 2.0; format ascii; class labelList; note "nPoints: 8 nCells: 4 nFaces: 10 nInternalFaces: 2"; }
`,
    )
    for (const [field, text] of Object.entries(fields)) {
      const rendered = typeof text === 'function' ? text(i) : text
      writeFileSync(join(root, time, field), rendered)
    }
  }
  return dir
}

test('fieldClass reads the component count from the class', () => {
  assert.equal(fieldClass(header('volScalarField', 'p')).component, 1)
  assert.equal(fieldClass(header('volVectorField', 'U')).component, 3)
  assert.equal(fieldClass(header('volSymmTensorField', 'R')).component, 6)
  assert.equal(fieldClass(header('volTensorField', 'gradU')).component, 9)
})

test('parseInternalField handles every spelling OpenFOAM writes', () => {
  const uniformScalar = parseInternalField(header('volScalarField', 'p') + 'internalField uniform 0;\n')
  assert.deepEqual([uniformScalar.kind, uniformScalar.count, uniformScalar.values], ['uniform', 1, [0]])

  const uniformVector = parseInternalField(header('volVectorField', 'U') + 'internalField uniform (1 0 0);\n')
  assert.deepEqual([uniformVector.kind, uniformVector.component, uniformVector.values], ['uniform', 3, [1, 0, 0]])

  const listScalar = parseInternalField(
    header('volScalarField', 'T') + 'internalField nonuniform List<scalar> \n3\n(\n300\n301.5\n-2e-3\n)\n;\n',
  )
  assert.deepEqual([listScalar.kind, listScalar.count, listScalar.values], ['nonuniform', 3, [300, 301.5, -0.002]])

  const inlineVector = parseInternalField(
    header('volVectorField', 'U') + 'internalField nonuniform List<vector> 2((-1 0 0)(2 3 4));\n',
  )
  assert.deepEqual([inlineVector.kind, inlineVector.count, inlineVector.values], ['nonuniform', 2, [-1, 0, 0, 2, 3, 4]])

  const broken = parseInternalField(header('volScalarField', 'T') + 'internalField nonuniform List<scalar> 3(1 2);\n')
  assert.match(broken.error, /has 2 numbers for 3 cells/)
})

test('summarise and mergeStats report scalars, vectors and cell counts', () => {
  const scalar = summarise([1, 5, -2], 1)
  assert.deepEqual([scalar.min, scalar.max, scalar.cells], [-2, 5, 3])

  const vector = summarise([3, 4, 0, 1, 0, 0], 3)
  assert.equal(vector.cells, 2)
  assert.equal(vector.magnitudes.max, 5)
  assert.equal(vector.magnitudes.min, 1)
  assert.deepEqual(vector.components[0], { min: 1, max: 3 })

  const merged = mergeStats(summarise([1, 2], 1), summarise([-4, 8], 1))
  assert.deepEqual([merged.min, merged.max, merged.cells], [-4, 8, 4])
})

test('a decomposed case is merged across processors, uniform fields included', () => {
  const dir = caseWith(
    {
      // processor 0 holds a uniform value for four cells, processor 1 a list
      T: (i) => fieldFile('volScalarField', 'T', i === 0 ? 'internalField uniform 300;' : 'internalField nonuniform List<scalar> 4(310 320 330 340);'),
    },
    { processors: 2 },
  )
  try {
    assert.deepEqual(fieldTimes(dir, { field: 'T', processors: [0, 1] }).map((t) => t.time), ['0.5'])
    assert.equal(latestFieldTime(dir, { field: 'T', processors: [0, 1] }), '0.5')
    assert.equal(cellCount(dir, { processor: 0 }), 4)
    const stats = readFieldStats(dir, { field: 'T', processors: [0, 1] })
    assert.equal(stats.ok, true)
    assert.equal(stats.stats.cells, 8, 'a uniform field still stands for all four cells of its mesh')
    assert.deepEqual([stats.stats.min, stats.stats.max], [300, 340])
    assert.equal(stats.source, '2 processor*/0.5/T')
    assert.equal(stats.kind, 'nonuniform')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readFieldStats reports a missing time and a binary field distinctly', () => {
  const dir = caseWith({ T: fieldFile('volScalarField', 'T', 'internalField uniform 300;') })
  try {
    const missing = readFieldStats(dir, { field: 'k' })
    assert.equal(missing.ok, false)
    assert.equal(missing.missing, true)
    assert.match(missing.error, /no written time carries k/)
    writeFileSync(join(dir, '0.5', 'T'), Buffer.from([0, 1, 2, 3]))
    const binary = readFieldStats(dir, { field: 'T' })
    assert.equal(binary.ok, false)
    assert.equal(binary.binary, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a partially written decomposition names the processors it could not read', () => {
  const dir = caseWith({ T: fieldFile('volScalarField', 'T', 'internalField uniform 300;') }, { processors: 2 })
  try {
    rmSync(join(dir, 'processor1', '0.5', 'T'))
    const stats = readFieldStats(dir, { field: 'T', processors: [0, 1] })
    assert.equal(stats.ok, true)
    assert.deepEqual(stats.missingProcessors, [1])
    assert.equal(stats.source, '1 processor*/0.5/T')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the render camera picks the orthographic preset only for a plate', () => {
  const mm = (x, y, z) => ({ min: [0, 0, 0], max: [x, y, z] })
  assert.equal(viewPresetFor(mm(0.0028, 0.0582, 0.0002)), 'xy', 'a 2D plate is read along its normal')
  assert.equal(viewPresetFor(mm(0.0028, 0.0002, 0.0582)), 'xz')
  assert.equal(viewPresetFor(mm(0.0002, 0.0582, 0.0028)), 'yz')
  assert.equal(viewPresetFor(mm(0.1, 0.04, 0.01)), 'custom', 'a thick channel stays perspective')
  assert.equal(viewPresetFor(mm(3.5, 3.5, 49)), 'custom', 'a long channel is handled by the existing azimuth rule')
  assert.equal(viewPresetFor(mm(0.0028, 0.0582, 0.0002), { elevation: 90 }), 'custom', 'an explicit angle wins')
  assert.equal(viewPresetFor(mm(1, 1, 1), { view: 'xz' }), 'xz', 'a preset always wins')
  assert.equal(viewPresetFor(mm(1, 1, 1), { view: 'custom' }), 'custom')
  assert.equal(viewPresetFor(null), 'custom', 'unknown geometry keeps the old path')
})
