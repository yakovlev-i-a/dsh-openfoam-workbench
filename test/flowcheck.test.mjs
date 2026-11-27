import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  analyseFlow,
  boundaryFieldBody,
  emptyAxisFromMesh,
  parsePhiBoundary,
  patchAreas,
  patchSum,
  polygonArea,
  readPatchFlux,
} from '../lib/flowcheck.js'
import { checkCase, parseBoundaryPatches } from '../lib/of-engine.js'

const PHI_INLINE = `FoamFile
{
    version     2.0;
    format      ascii;
    class       surfaceScalarField;
    object      phi;
}

dimensions      [0 3 -1 0 0 0 0];

internalField   nonuniform List<scalar>
3
(
1
2
3
);

boundaryField
{
    inlet
    {
        type            calculated;
        value           nonuniform List<scalar> 2(-1e-05 -2e-05);
    }
    outlet
    {
        type            calculated;
        value           uniform 0;
    }
    walls
    {
        type            calculated;
        value           uniform 0;
    }
    procBoundary0to1
    {
        type            processor;
        value           nonuniform List<scalar> 1(5);
    }
}
`

const PHI_MULTILINE = PHI_INLINE.replace(
  `        value           nonuniform List<scalar> 2(-1e-05 -2e-05);`,
  `        value           nonuniform List<scalar> 
2
(
-1e-05
-2e-05
);`,
)

test('boundaryFieldBody extracts the block and ignores the rest', () => {
  const body = boundaryFieldBody(PHI_INLINE)
  assert.ok(body.includes('inlet'))
  assert.ok(!body.includes('internalField'))
  assert.equal(boundaryFieldBody('no boundary here'), null)
})

test('parsePhiBoundary reads both list layouts and uniform values', () => {
  for (const text of [PHI_INLINE, PHI_MULTILINE]) {
    const patches = parsePhiBoundary(text)
    assert.equal(patches.size, 4)
    assert.equal(patches.get('inlet').kind, 'nonuniform')
    assert.deepEqual(patches.get('inlet').numbers, [-1e-5, -2e-5])
    assert.equal(patches.get('outlet').kind, 'uniform')
    assert.equal(patches.get('outlet').uniform, 0)
    assert.equal(patches.get('procBoundary0to1').type, 'processor')
  }
})

test('patchSum multiplies a uniform value by the face count', () => {
  const patches = parsePhiBoundary(PHI_INLINE)
  assert.ok(Math.abs(patchSum(patches.get('inlet'), 2) + 3e-5) < 1e-18)
  assert.equal(patchSum(patches.get('outlet'), 20), 0)
  assert.equal(patchSum(null, 4), 0)
})

test('polygonArea of a unit square is 1', () => {
  const points = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ]
  assert.equal(polygonArea(points, [0, 1, 2, 3]), 1)
})

function syntheticCase() {
  const dir = mkdtempSync(join(tmpdir(), 'ofw-flow-'))
  mkdirSync(join(dir, 'constant', 'polyMesh'), { recursive: true })
  mkdirSync(join(dir, '0'), { recursive: true })
  mkdirSync(join(dir, '0.5'), { recursive: true })
  writeFileSync(
    join(dir, 'constant', 'polyMesh', 'boundary'),
    `FoamFile { version 2.0; format ascii; class polyBoundaryMesh; object boundary; }
4
(
    inlet
    {
        type            patch;
        nFaces          1;
        startFace       0;
    }
    outlet
    {
        type            patch;
        nFaces          1;
        startFace       1;
    }
    walls
    {
        type            wall;
        nFaces          1;
        startFace       2;
    }
    frontAndBack
    {
        type            empty;
        nFaces          1;
        startFace       3;
    }
)
`,
  )
  // One unit square per patch, all in the z=0 plane: area 1 each.
  writeFileSync(
    join(dir, 'constant', 'polyMesh', 'points'),
    `FoamFile { version 2.0; format ascii; class vectorField; object points; }
4
(
(0 0 0)
(1 0 0)
(1 1 0)
(0 1 0)
)
`,
  )
  writeFileSync(
    join(dir, 'constant', 'polyMesh', 'faces'),
    `FoamFile { version 2.0; format ascii; class faceList; object faces; }
4
(
4(0 1 2 3)
4(0 1 2 3)
4(0 1 2 3)
4(0 1 2 3)
)
`,
  )
  writeFileSync(
    join(dir, '0', 'U'),
    `FoamFile { version 2.0; format ascii; class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform (0 0 1.75);
    }
    outlet
    {
        type            zeroGradient;
    }
    walls
    {
        type            noSlip;
    }
    frontAndBack
    {
        type            empty;
    }
}
`,
  )
  writeFileSync(
    join(dir, '0.5', 'phi'),
    PHI_INLINE.replace('2(-1e-05 -2e-05)', '2(-0.0025 -0.0025)'),
  )
  return dir
}

test('readPatchFlux sums over processor directories and skips processor patches', () => {
  const dir = syntheticCase()
  try {
    const patches = [
      { name: 'inlet', type: 'patch', nFaces: 2 },
      { name: 'outlet', type: 'patch', nFaces: 2 },
    ]
    const serial = readPatchFlux(dir, { time: '0.5', patches })
    assert.equal(serial.error, null)
    assert.ok(Math.abs(serial.fluxes.get('inlet') + 0.005) < 1e-12)
    assert.equal(serial.fluxes.get('outlet'), 0)
    assert.equal(serial.fluxes.has('procBoundary0to1'), false)

    for (const i of [0, 1]) {
      const pdir = join(dir, `processor${i}`)
      mkdirSync(join(pdir, '0.5'), { recursive: true })
      writeFileSync(join(pdir, '0.5', 'phi'), PHI_INLINE.replace('2(-1e-05 -2e-05)', '2(-0.0025 -0.0025)'))
    }
    const parallel = readPatchFlux(dir, { time: '0.5', patches, processors: [0, 1] })
    assert.equal(parallel.processors, 2)
    assert.ok(Math.abs(parallel.fluxes.get('inlet') + 0.01) < 1e-12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readPatchFlux reports a missing or binary phi instead of guessing', () => {
  const dir = syntheticCase()
  try {
    const patches = [{ name: 'inlet', type: 'patch', nFaces: 2 }]
    assert.match(readPatchFlux(dir, { time: '9', patches }).error, /no readable ascii phi/)
    writeFileSync(join(dir, '0.5', 'phi'), 'FoamFile\n{\nformat binary;\n}\n\u0000\u0001')
    assert.match(readPatchFlux(dir, { time: '0.5', patches }).error, /no readable ascii phi/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patchAreas reads the polyMesh and returns null without geometry', () => {
  const dir = syntheticCase()
  try {
    const patches = [
      { name: 'inlet', type: 'patch', nFaces: 1, startFace: 0 },
      { name: 'walls', type: 'wall', nFaces: 1, startFace: 2 },
    ]
    const areas = patchAreas(dir, patches)
    assert.ok(Math.abs(areas.get('inlet') - 1) < 1e-12)
    assert.ok(Math.abs(areas.get('walls') - 1) < 1e-12)
    rmSync(join(dir, 'constant', 'polyMesh', 'points'), { force: true })
    assert.equal(patchAreas(dir, patches), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('analyseFlow: an inlet along the empty axis is a blocking finding', () => {
  const verdict = analyseFlow({
    patches: [
      { patch: 'inlet', flux: 0, area: 1 },
      { patch: 'outlet', flux: 0, area: 1 },
    ],
    uBoundary: { inlet: { type: 'fixedValue', value: [0, 0, 1.75] }, outlet: { type: 'zeroGradient' } },
    meshTypes: { inlet: 'patch', outlet: 'patch' },
    flatAxis: 2,
    incompressible: true,
  })
  const rules = verdict.findings.map((f) => f.rule)
  assert.ok(rules.includes('inlet-without-flux'))
  assert.ok(rules.includes('no-flow-through-boundaries'))
  const inlet = verdict.findings.find((f) => f.rule === 'inlet-without-flux')
  assert.equal(inlet.severity, 'error')
  assert.match(inlet.detail, /one cell thick/)
  assert.match(inlet.fix, /U = \(0 1\.75 0\)/)
})

test('analyseFlow: a wall-only case is information, not a failure', () => {
  const verdict = analyseFlow({
    patches: [{ patch: 'movingWall', flux: 0, area: 1 }],
    uBoundary: { movingWall: { type: 'fixedValue', value: [1, 0, 0] } },
    meshTypes: { movingWall: 'wall' },
  })
  assert.equal(verdict.findings.length, 1)
  assert.equal(verdict.findings[0].rule, 'no-flow-boundaries')
  assert.equal(verdict.findings[0].severity, 'info')
})

test('analyseFlow: the imbalance band is tighter for incompressible flow', () => {
  const base = {
    patches: [
      { patch: 'inlet', flux: -1, area: 1 },
      { patch: 'outlet', flux: 0.98, area: 1 },
    ],
    uBoundary: { inlet: { type: 'fixedValue', value: [1, 0, 0] }, outlet: { type: 'zeroGradient' } },
    meshTypes: { inlet: 'patch', outlet: 'patch' },
  }
  const incompressible = analyseFlow({ ...base, incompressible: true })
  assert.ok(incompressible.findings.some((f) => f.rule === 'mass-imbalance'))
  const compressible = analyseFlow({ ...base, incompressible: false })
  assert.equal(compressible.findings.some((f) => f.rule === 'mass-imbalance'), false)
  const worse = analyseFlow({
    ...base,
    patches: [
      { patch: 'inlet', flux: -1, area: 1 },
      { patch: 'outlet', flux: 0.5, area: 1 },
    ],
    incompressible: false,
  })
  assert.ok(worse.findings.some((f) => f.rule === 'mass-imbalance'))
})

function flatMeshCase(uInlet) {
  const dir = mkdtempSync(join(tmpdir(), 'ofw-flat-'))
  mkdirSync(join(dir, 'constant', 'polyMesh'), { recursive: true })
  mkdirSync(join(dir, 'system'), { recursive: true })
  mkdirSync(join(dir, '0'), { recursive: true })
  writeFileSync(
    join(dir, 'constant', 'polyMesh', 'boundary'),
    `FoamFile { version 2.0; format ascii; class polyBoundaryMesh; object boundary; }
3
(
    inlet
    {
        type            patch;
        nFaces          1;
        startFace       0;
    }
    outlet
    {
        type            patch;
        nFaces          1;
        startFace       1;
    }
    frontAndBack
    {
        type            empty;
        nFaces          2;
        startFace       3;
    }
)
`,
  )
  writeFileSync(
    join(dir, 'constant', 'polyMesh', 'points'),
    `FoamFile { version 2.0; format ascii; class vectorField; object points; }
8
(
(0 0 0)
(1 0 0)
(1 1 0)
(0 1 0)
(0 0 0.01)
(1 0 0.01)
(1 1 0.01)
(0 1 0.01)
)
`,
  )
  // Face 0 is internal; inlet and outlet are the x-normal faces of the plate,
  // the two empty faces are the z-normal ones — `frontAndBack` holds both.
  writeFileSync(
    join(dir, 'constant', 'polyMesh', 'faces'),
    `FoamFile { version 2.0; format ascii; class faceList; object faces; }
6
(
4(0 4 7 3)
4(1 2 6 5)
4(0 1 5 4)
4(0 3 2 1)
4(4 5 6 7)
4(3 7 6 2)
)
`,
  )
  writeFileSync(
    join(dir, 'system', 'blockMeshDict'),
    `FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
convertToMeters 1;
vertices ( (0 0 0) (1 0 0) (1 1 0) (0 1 0) (0 0 0.01) (1 0 0.01) (1 1 0.01) (0 1 0.01) );
blocks ();
edges ();
boundary ();
`,
  )
  writeFileSync(
    join(dir, '0', 'U'),
    `FoamFile { version 2.0; format ascii; class volVectorField; object U; }
dimensions [0 1 -1 0 0 0 0];
internalField uniform (0 0 0);
boundaryField
{
    inlet
    {
        type            fixedValue;
        value           uniform ${uInlet};
    }
    outlet
    {
        type            zeroGradient;
    }
    frontAndBack
    {
        type            empty;
    }
}
`,
  )
  return dir
}

test('emptyAxisFromMesh takes the axis the empty patch faces are normal to', () => {
  const dir = flatMeshCase('(0 0 1.75)')
  try {
    const patches = parseBoundaryPatches(readFileSync(join(dir, 'constant', 'polyMesh', 'boundary'), 'utf8'))
    assert.equal(emptyAxisFromMesh(dir, patches), 2)
    rmSync(join(dir, 'constant', 'polyMesh', 'faces'), { force: true })
    assert.equal(emptyAxisFromMesh(dir, patches), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the doctor raises vector-along-empty-axis before the solver runs', () => {
  const zone = flatMeshCase('(0 0 1.75)')
  const good = flatMeshCase('(1.75 0 0)')
  try {
    const bad = checkCase(zone).filter((f) => f.rule === 'vector-along-empty-axis')
    assert.equal(bad.length, 1)
    assert.equal(bad[0].severity, 'error')
    assert.match(bad[0].title, /U has a z-component but the mesh is 2D in xy/)
    assert.match(bad[0].fix, /openfoam_flow_check/)
    const ok = checkCase(good).filter((f) => f.rule === 'vector-along-empty-axis')
    assert.equal(ok.length, 0)
  } finally {
    rmSync(zone, { recursive: true, force: true })
    rmSync(good, { recursive: true, force: true })
  }
})
