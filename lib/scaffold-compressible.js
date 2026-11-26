// Compressible single-region scaffold.
//
// The family decides both the solver entry and the thermo/field layout:
//   org 14  : application foamRun; solver fluid; hePsiThermo + internal energy,
//             physicalProperties/momentumTransport/thermophysicalTransport, p + p_rgh
//   com 2606: application rhoPimpleFoam; heRhoThermo + enthalpy,
//             thermophysicalProperties/turbulenceProperties, p only
import { classifyPatch } from './scaffold.js'

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

/** Dictionaries and fields for a compressible single-region case. */
export function scaffoldCompressible({
  caps,
  patches = [],
  Uinlet = 50,
  Tinlet = 300,
  pInitial = 1e5,
  endTime = 0.006,
  deltaT = 1e-5,
  writeInterval = 100,
} = {}) {
  const modular = Boolean(caps.modular)
  const roles = patches.map((p) => ({ ...p, role: classifyPatch(p.name, p.type) }))
  const warnings = []
  if (!roles.some((r) => r.role === 'outlet')) warnings.push('no outlet patch: pressure has nowhere to leave')
  if (!roles.some((r) => r.role === 'inlet')) warnings.push('no inlet patch: velocity/temperature have no fixed value')

  const files = {}
  const boundary = (entries) => `boundaryField\n{\n${entries.join('\n\n')}\n\n    #includeEtc "caseDicts/setConstraintTypes"\n}\n`
  const perPatch = (fn) => roles.map((r) => `    ${r.name}\n    {\n${fn(r)}\n    }`)

  const U = boundary(perPatch((r) => {
    if (r.role === 'inlet') return `        type            fixedValue;\n        value           uniform (${Uinlet} 0 0);`
    if (r.role === 'outlet') return '        type            pressureInletOutletVelocity;\n        value           uniform (0 0 0);'
    return '        type            noSlip;'
  }))
  const p = boundary(perPatch((r) => {
    return r.role === 'outlet'
      ? `        type            waveTransmissive;\n        field           p;\n        gamma           1.4;\n        fieldInf        ${pInitial};\n        lInf            0.1;\n        value           uniform ${pInitial};`
      : '        type            zeroGradient;'
  }))
  const T = boundary(perPatch((r) => (r.role === 'inlet'
    ? `        type            fixedValue;\n        value           uniform ${Tinlet};`
    : '        type            zeroGradient;')))

  // The gas starts at rest and the inlet drives the flow; a uniform Uinlet inside
  // the domain instantly would create an unphysical pressure wave.
  files['0/U'] = BANNER('volVectorField', 'U') + `\ndimensions      [0 1 -1 0 0 0 0];\n\ninternalField   uniform (0 0 0);\n\n` + U
  files['0/p'] = BANNER('volScalarField', 'p') + `\ndimensions      [1 -1 -2 0 0 0 0];\n\ninternalField   uniform ${pInitial};\n\n` + p
  files['0/T'] = BANNER('volScalarField', 'T') + `\ndimensions      [0 0 0 1 0 0 0];\n\ninternalField   uniform ${Tinlet};\n\n` + T


  const thermo = modular
    ? `thermoType
{
    type            hePsiThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState perfectGas;
    specie          specie;
    energy          sensibleInternalEnergy;
}

mixture
{
    specie { molWeight 28.9; }
    thermodynamics { Cp 1005; hf 0; }
    transport { mu 1.8e-05; Pr 0.7; }
}
`
    : `thermoType
{
    type            heRhoThermo;
    mixture         pureMixture;
    transport       const;
    thermo          hConst;
    equationOfState perfectGas;
    specie          specie;
    energy          sensibleEnthalpy;
}

mixture
{
    specie { molWeight 28.9; }
    thermodynamics { Cp 1005; Hf 0; }
    transport { mu 1.8e-05; Pr 0.7; }
}
`
  const thermoName = modular ? 'physicalProperties' : 'thermophysicalProperties'
  files[`constant/${thermoName}`] = BANNER('dictionary', thermoName) + '\n' + thermo
  if (modular) {
    files['constant/momentumTransport'] = BANNER('dictionary', 'momentumTransport') + '\nsimulationType  laminar;\n'
    files['constant/thermophysicalTransport'] = BANNER('dictionary', 'thermophysicalTransport') + '\nlaminar\n{\n    model           unityLewisFourier;\n}\n'
  } else {
    files['constant/turbulenceProperties'] = BANNER('dictionary', 'turbulenceProperties') + '\nsimulationType  laminar;\n'
  }
  files['constant/g'] = BANNER('dictionary', 'g') + '\ndimensions      [0 1 -2 0 0 0 0];\nvalue           (0 0 0);\n'
  if (modular) {
    files['constant/pRef'] = BANNER('dictionary', 'pRef') + `\ndimensions      [1 -1 -2 0 0 0 0];\nvalue           ${pInitial};\n`
  }

  files['system/controlDict'] = BANNER('dictionary', 'controlDict') + `
application     ${modular ? 'foamRun' : 'rhoPimpleFoam'};
${modular ? 'solver          fluid;\n' : ''}
startFrom       startTime;
startTime       0;
stopAt          endTime;
endTime         ${endTime};
deltaT          ${deltaT};
writeControl    runTime;
writeInterval   ${writeInterval};
purgeWrite      0;
writeFormat     ascii;
writePrecision  8;
writeCompression off;
timeFormat      general;
timePrecision   6;
runTimeModifiable true;
`
  files['system/fvSchemes'] = BANNER('dictionary', 'fvSchemes') + `
ddtSchemes { default Euler; }
gradSchemes { default Gauss linear; }
divSchemes
{
    default         none;
    div(phi,U)      Gauss linearUpwind grad(U);
${modular
  ? `    div(phi,e)      Gauss upwind;
    div(phi,K)      Gauss upwind;
    div(phi,Ekp)    Gauss upwind;
    div(phi,(p|rho)) Gauss upwind;`
  : `    div(phi,h)      Gauss upwind;
    div(phi,K)      Gauss upwind;
    div(phid,p)     Gauss upwind;`}
    div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
}
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
`
  files['system/fvSolution'] = BANNER('dictionary', 'fvSolution') + `
solvers
{
    p { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
    pFinal { $p; relTol 0; }
    "(rho|U|${modular ? 'e' : 'h'})" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0.1; }
    "(rho|U|${modular ? 'e' : 'h'})Final" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0; }
}
PIMPLE { nCorrectors 2; nNonOrthogonalCorrectors 1; nOuterCorrectors 1; }
relaxationFactors { equations { ".*" 1; } }
`
  return { files, warnings, notes: [modular ? 'org: foamRun + fluid module (internal energy)' : 'com: rhoPimpleFoam (enthalpy thermo)'], roles }
}
