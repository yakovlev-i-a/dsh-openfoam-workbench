// Golden cases: small cases with stored reference quantities.
//
// Each case is a recipe: how to get the case, what to run, which quantities to
// compare. The runner (scripts/run-golden.mjs) executes it against one installed
// distribution and diffs the quantities with test/golden/expected/<dist>.json.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const CAVITY_BLOCKMESH = `FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
scale 1;
vertices
(
    (0 0 0) (0.1 0 0) (0.1 0.1 0) (0 0.1 0)
    (0 0 0.01) (0.1 0 0.01) (0.1 0.1 0.01) (0 0.1 0.01)
);
blocks
(
    hex (0 1 2 3 4 5 6 7) (20 20 1) simpleGrading (1 1 1)
);
boundary
(
    movingWall { type wall; faces ((3 7 6 2)); }
    fixedWalls { type wall; faces ((0 4 7 3) (1 5 4 0) (2 6 5 1)); }
    frontAndBack { type empty; faces ((0 3 2 1) (4 5 6 7)); }
);
`

/** A 100 mm box with a 50 mm sphere cut out: the geometry measured in this project. */
const SPHERE_BOX_BLOCKMESH = `FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
geometry
{
    sphere { type sphere; centre (0 0 0); radius 0.025; }
}
scale 1;
vertices
(
    (-0.05 -0.05 -0.05) (0.05 -0.05 -0.05) (0.05 0.05 -0.05) (-0.05 0.05 -0.05)
    (-0.05 -0.05 0.05) (0.05 -0.05 0.05) (0.05 0.05 0.05) (-0.05 0.05 0.05)
);
blocks
(
    hex (0 1 2 3 4 5 6 7) (20 20 20) simpleGrading (1 1 1)
);
boundary
(
    inlet { type patch; faces ((0 4 7 3)); }
    outlet { type patch; faces ((1 2 6 5)); }
    walls { type wall; faces ((0 1 5 4) (3 2 6 7) (0 1 2 3) (4 5 6 7)); }
);
`

const SPHERE_ZONES = `FoamFile { version 2.0; format ascii; class dictionary; object createZonesDict; }
solid { type sphere; zoneType cell; centre (0 0 0); radius 0.025; }
`

export const CASES = {
  // Classic 2D lid-driven cavity: cheap, transient, incompressible.
  cavity: {
    title: 'lid-driven cavity (incompressible)',
    args: ['both'],
    prepare: ({ caseDir }) => {
      mkdirSync(join(caseDir, 'system'), { recursive: true })
      writeFileSync(join(caseDir, 'system/blockMeshDict'), CAVITY_BLOCKMESH)
      // Only a placeholder so blockMesh can start; the scaffold below writes the
      // real controlDict with the time controls of this case.
      writeFileSync(join(caseDir, 'system/controlDict'), [
        'FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }',
        '',
        'application     foamRun;',
        '',
        'startFrom       startTime;',
        'startTime       0;',
        'stopAt          endTime;',
        'endTime         0.3;',
        'deltaT          5e-4;',
        'writeControl    timeStep;',
        'writeInterval   100;',
        '',
      ].join('\n'))
    },
    // The dictionaries come from the case itself, so both distributions run the
    // same physics through their canonical solver.
    scaffold: { family: 'incompressible', algorithm: 'PIMPLE', U: [0, 0, 0], p: 0, nu: 1e-5, endTime: 0.3, deltaT: 5e-4, writeInterval: 100 },
    patches: [['movingWall', 'wall'], ['fixedWalls', 'wall'], ['frontAndBack', 'empty']],
    qoi: ['cells', 'maxNonOrtho', 'p.min', 'p.max', 'U.max', 'finalTime'],
    afterScaffold: ({ caseDir }) => {
      // A cavity is driven by a moving lid: override the generic noSlip wall.
      const u = join(caseDir, '0/U')
      const text = readFileSync(u, 'utf8')
      const replaced = text.replace(
        /(    movingWall\n    \{)[\s\S]*?(\n    \})/,
        '$1\n        type            fixedValue;\n        value           uniform (1 0 0);$2',
      )
      if (!replaced.includes('(1 0 0)')) throw new Error('could not set the moving lid')
      writeFileSync(u, replaced)
    },
  },

  // Compressible transient flow over the tutorial's backward-facing step.
  pitzDaily: {
    title: 'pitzDaily (compressible)',
    args: ['both'],
    tutorial: { org: 'fluid/pitzDaily', com: 'compressible/rhoPimpleFoam/LES/pitzDaily' },
    blockMeshFrom: { org: 'resources/blockMesh/pitzDaily' },
    controlOverride: { endTime: 0.01, writeInterval: 100 },
    // The apt install on this machine ships no tutorials directory
    // (openfoam2606-tutorials is a separate package), and the compressible path on
    // com is covered by sphereBox anyway.
    skip: { com: 'com install has no tutorials directory; compressible is covered by sphereBox' },
    qoi: ['cells', 'maxNonOrtho', 'T.min', 'T.max', 'U.max', 'finalTime'],
  },

  // Compressible gas around the same sphere, on the stored snappy mesh. The QoI are
  // regression values of this transient blocked-duct run, not a validated benchmark.
  sphereBox: {
    title: 'sphere in a box (compressible)',
    args: ['both'],
    meshFixture: 'sphereFlow',
    prepare: ({ caseDir }) => {
      mkdirSync(join(caseDir, 'system'), { recursive: true })
      writeFileSync(join(caseDir, 'system/controlDict'), [
        'FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }',
        '',
        'application     foamRun;',
        '',
        'startFrom       startTime;',
        'startTime       0;',
        'stopAt          endTime;',
        'endTime         0.002;',
        'deltaT          2e-6;',
        'writeControl    runTime;',
        'writeInterval   0.001;',
        '',
      ].join('\n'))
    },
    steps: [],
    compressible: { Uinlet: 10, Tinlet: 300, pInitial: 1e5, endTime: 0.01, deltaT: 1e-5, writeInterval: 0.005 },
    qoi: ['cells', 'maxNonOrtho', 'p.min', 'p.max', 'T.max', 'U.max', 'finalTime'],
  },

  // The project's own CHT case: box minus sphere, solid sphere heated by the gas.
  sphereCht: {
    title: 'sphere in a box (conjugate heat transfer)',
    args: ['both'],
    prepare: ({ caseDir }) => {
      mkdirSync(join(caseDir, 'system'), { recursive: true })
      writeFileSync(join(caseDir, 'system/controlDict'), [
        'FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }',
        '',
        'application     foamMultiRun;',
        '',
        'startFrom       startTime;',
        'startTime       0;',
        'stopAt          endTime;',
        'endTime         0.02;',
        'deltaT          1e-4;',
        'writeControl    runTime;',
        'writeInterval   0.01;',
        '',
      ].join('\n'))
    },
    meshFixture: { org: 'sphereCht', com: 'sphereChtCom' },
    steps: [],
    cht: {
      regions: [{ name: 'fluid', kind: 'fluid' }, { name: 'solid', kind: 'solid' }],
      Uinlet: 5, Tinlet: 500, Tsolid: 300,
      solid: { rho: 1000, Cv: 0.5, kappa: 50 },
      endTime: 0.02, deltaT: 1e-4, writeInterval: 0.01,
    },
    qoi: ['fluid.cells', 'solid.cells', 'solid.T.min', 'solid.T.max', 'fluid.T.max', 'finalTime'],
    // com v2606 on this machine: chtMultiRegionFoam segfaults after the field setup
    // (same class as rhoPimpleFoam), and org's interface patch metadata
    // (mappedWall without sampleMode) is not portable to com; a com run needs its
    // own fixture built by com and a working cht solver.
    // com builds the zone with topoSet + setsToZones (openfoam_create_zone now
    // handles that) but the CHT field layer differs: com injects per-region
    // boundary conditions through `changeDictionary -region` from a shared 0.orig
    // and names the interface condition turbulentTemperatureCoupledBaffleMixed,
    // not coupledTemperature. Until that step exists the case is org-only.
  },
}

/** Find the tutorials root and a case directory inside it. */
export function resolveTutorial(foamRoot, rel) {
  const candidates = [join(foamRoot, 'tutorials'), join(foamRoot, '..', 'tutorials')]
  for (const root of candidates) {
    const dir = join(root, rel)
    if (existsSync(join(dir, 'system', 'controlDict'))) return dir
  }
  return null
}

export function copyTutorial(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) cpSync(join(src, entry), join(dest, entry), { recursive: true })
}
