// Case scaffold: the dictionaries no other tool writes.
//
// `mesh_plan` writes the mesh dictionaries; `clone_tutorial` copies a whole
// tutorial. A case built from scratch needs controlDict, fvSchemes, fvSolution
// and the initial fields, generated for the mesh the user actually has — the
// tutorial alternative would carry patch names that do not exist here.
//
// v1 covers incompressible laminar flow only, because that is the family this
// generator can validate end to end (blockMesh -> solver -> solve_verify) on
// both distributions. The distribution branch is real:
//   org 14  : application foamRun; + solver incompressibleFluid; + momentumTransport/physicalProperties
//   com 2606: application simpleFoam; + turbulenceProperties/transportProperties   (no foamRun)

const BANNER = (cls, object) => `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     |                                                 |
|   \\\\  /    A nd           |                                                 |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       ${cls};
    object      ${object};
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

`

/** org 14 modular vs com legacy: `vYYMM` means com. */
export function distributionKind(distribution) {
  return /^(v\d|com)/i.test(String(distribution || '')) ? 'com' : 'org'
}

/** Role of a patch from its name and type; drives the boundary conditions. */
export function classifyPatch(name, type = 'patch') {
  const n = String(name || '').toLowerCase()
  const t = String(type || '').toLowerCase()
  if (t === 'empty' || n === 'empty' || /empty/.test(n)) return 'empty'
  if (t.startsWith('symmetry') || /symmetry|symm/.test(n)) return 'symmetry'
  if (t.startsWith('cyclic') || /cyclic|periodic/.test(n)) return 'cyclic'
  if (/inlet|inflow|entry|^in$|^inlet|^left|^front$/.test(n)) return 'inlet'
  if (/outlet|outflow|exit|^out$|^right|^back$/.test(n)) return 'outlet'
  if (t === 'wall' || /wall|bottom|top|side|surface|body|cylinder/.test(n)) return 'wall'
  return 'other'
}

const vec = (v, fallback = [1, 0, 0]) => {
  const a = Array.isArray(v) && v.length === 3 ? v.map(Number) : fallback
  return `(${a.map((x) => (Number.isFinite(x) ? x : 0)).join(' ')})`
}

function uBC(role, U) {
  switch (role) {
    case 'inlet': return `    {\n        type            fixedValue;\n        value           uniform ${U};\n    }`
    case 'outlet': return '    {\n        type            zeroGradient;\n    }'
    case 'wall': return '    {\n        type            noSlip;\n    }'
    case 'empty': return '    {\n        type            empty;\n    }'
    case 'symmetry': return '    {\n        type            symmetry;\n    }'
    case 'cyclic': return '    {\n        type            cyclic;\n    }'
    default: return '    {\n        type            zeroGradient;\n    }'
  }
}

function pBC(role, p) {
  switch (role) {
    case 'inlet': return '    {\n        type            zeroGradient;\n    }'
    case 'outlet': return `    {\n        type            fixedValue;\n        value           uniform ${p};\n    }`
    case 'wall': return '    {\n        type            zeroGradient;\n    }'
    case 'empty': return '    {\n        type            empty;\n    }'
    case 'symmetry': return '    {\n        type            symmetry;\n    }'
    case 'cyclic': return '    {\n        type            cyclic;\n    }'
    default: return '    {\n        type            zeroGradient;\n    }'
  }
}

function fieldsDict(object, fieldClass, patchList) {
  const dims = fieldClass === 'volVectorField' ? '[0 1 -1 0 0 0 0]' : '[0 2 -2 0 0 0 0]'
  return `${BANNER(fieldClass, object)}
dimensions      ${dims};

internalField   uniform ${fieldClass === 'volVectorField' ? '(0 0 0)' : '0'};

boundaryField
{
${patchList}
}

// ************************************************************************* //
`
}

/**
 * Build every file a fresh incompressible laminar case needs.
 * Returns { files: {relPath: text}, notes, warnings, patchRoles }.
 */
export function scaffoldFiles({
  distribution = 'org',
  patches = [],
  algorithm = 'SIMPLE',
  U = [1, 0, 0],
  p = 0,
  nu = 1e-5,
  endTime,
  deltaT,
  writeInterval,
} = {}) {
  const kind = distributionKind(distribution)
  const transient = String(algorithm).toUpperCase() === 'PIMPLE'
  const roles = patches.map((patch) => ({ ...patch, role: classifyPatch(patch.name, patch.type) }))
  const warnings = []
  const notes = []
  const hasOutlet = roles.some((r) => r.role === 'outlet')
  const hasInlet = roles.some((r) => r.role === 'inlet')
  if (!hasOutlet) warnings.push('no outlet patch: pressure needs a reference cell (pRefCell 0 / pRefValue 0 added to fvSolution)')
  if (!hasInlet) warnings.push('no inlet patch: velocity has no fixed value yet — set the real inflow in 0/U')
  const unknown = roles.filter((r) => r.role === 'other')
  if (unknown.length) warnings.push(`${unknown.length} patch(es) of unknown role use zeroGradient: ${unknown.map((r) => r.name).join(', ')}`)
  const hasEmpty = roles.some((r) => r.role === 'empty')
  if (hasEmpty) notes.push('empty patches found: the case is treated as 2D')

  const app = kind === 'org' ? 'foamRun' : 'simpleFoam'
  const solverLine = kind === 'org' ? 'solver          incompressibleFluid;\n' : ''
  const endT = Number(endTime) || (transient ? 1 : 500)
  const dT = Number(deltaT) || (transient ? 0.001 : 1)
  const writeEvery = Number(writeInterval) || (transient ? 20 : 100)

  const controlDict = `${BANNER('dictionary', 'controlDict')}application     ${app};

${solverLine}startFrom       startTime;

startTime       0;

stopAt          endTime;

endTime         ${endT};

deltaT          ${dT};

writeControl    timeStep;

writeInterval   ${writeEvery};

purgeWrite      0;

writeFormat     ascii;

writePrecision  6;

writeCompression off;

timeFormat      general;

timePrecision   6;

runTimeModifiable true;

// ************************************************************************* //
`

  const fvSchemes = `${BANNER('dictionary', 'fvSchemes')}ddtSchemes
{
    default         ${transient ? 'Euler' : 'steadyState'};
}

gradSchemes
{
    default         Gauss linear;
}

divSchemes
{
    default         none;
    div(phi,U)      bounded Gauss linearUpwind grad(U);
    div((nuEff*dev2(T(grad(U))))) Gauss linear;
}

laplacianSchemes
{
    default         Gauss linear corrected;
}

interpolationSchemes
{
    default         linear;
}

snGradSchemes
{
    default         corrected;
}

wallDist
{
    method          meshWave;
}

fluxRequired
{
    default         no;
    p;
}

// ************************************************************************* //
`

  const solverBlocks = transient
    ? `solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-08;
        relTol          0;
    }

    pFinal
    {
        $p;
        relTol          0;
    }

    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-09;
        relTol          0;
    }

    UFinal
    {
        $U;
        relTol          0;
    }
}

PIMPLE
{
    nOuterCorrectors 2;
    nCorrectors     2;
    nNonOrthogonalCorrectors 1;
}

relaxationFactors
{
    fields
    {
        p               1;
    }
    equations
    {
        U               1;
    }
}
`
    : `solvers
{
    p
    {
        solver          GAMG;
        smoother        GaussSeidel;
        tolerance       1e-07;
        relTol          0.1;
    }

    U
    {
        solver          smoothSolver;
        smoother        symGaussSeidel;
        tolerance       1e-08;
        relTol          0.1;
    }
}

SIMPLE
{
    nNonOrthogonalCorrectors 1;
    residualControl
    {
        p               1e-04;
        U               1e-05;
    }
${hasOutlet ? '' : '    pRefCell        0;\n    pRefValue       0;\n'}
}

relaxationFactors
{
    fields
    {
        p               0.3;
    }
    equations
    {
        U               0.7;
    }
}
`
  const fvSolution = `${BANNER('dictionary', 'fvSolution')}${solverBlocks}// ************************************************************************* //
`

  const constFiles = kind === 'org'
    ? {
        'constant/physicalProperties': `${BANNER('dictionary', 'physicalProperties')}viscosityModel  constant;

nu              ${nu} [0 2 -1 0 0 0 0];

// ************************************************************************* //
`,
        'constant/momentumTransport': `${BANNER('dictionary', 'momentumTransport')}simulationType  laminar;

// ************************************************************************* //
`,
      }
    : {
        'constant/transportProperties': `${BANNER('dictionary', 'transportProperties')}transportModel  Newtonian;

nu              [0 2 -1 0 0 0 0] ${nu};

// ************************************************************************* //
`,
        'constant/turbulenceProperties': `${BANNER('dictionary', 'turbulenceProperties')}simulationType  laminar;

// ************************************************************************* //
`,
      }

  const patchText = (fn) => roles.map((r) => `    ${r.name}\n${fn(r.role)}`).join('\n\n')
  const files = {
    'system/controlDict': controlDict,
    'system/fvSchemes': fvSchemes,
    'system/fvSolution': fvSolution,
    ...constFiles,
    '0/U': fieldsDict('U', 'volVectorField', patchText((role) => uBC(role, vec(U)))),
    '0/p': fieldsDict('p', 'volScalarField', patchText((role) => pBC(role, Number(p) || 0))),
  }

  return { files, notes, warnings, patchRoles: roles, application: app, kind, transient }
}
