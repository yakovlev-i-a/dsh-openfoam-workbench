// Multi-region (conjugate heat transfer) scaffold.
//
// The single-region scaffold writes one set of dictionaries; a CHT case needs a
// coherent set per region plus the glue that tells the solver which module runs
// where. Conventions follow the capabilities: org 14 uses `regionSolvers` +
// `foamMultiRun`, com v2606 uses `chtMultiRegionFoam` + `constant/regionProperties`.
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

const isInterface = (name, region) => new RegExp('^(.*_to_' + region + '|' + region + '_to_.*)$').test(String(name))

/** Interface temperature condition: org names it coupledTemperature, com wants the
 * compressible coupled baffle condition with the neighbour field and a kappa source. */
function interfaceT(caps, kind, value) {
  if (caps.modular) {
    return `        type            coupledTemperature;\n        value           uniform ${value};`
  }
  const kappaMethod = kind === 'fluid' ? 'fluidThermo' : 'solidThermo'
  return `        type            compressible::turbulentTemperatureCoupledBaffleMixed;\n        Tnbr            T;\n        kappaMethod     ${kappaMethod};\n        sampleMode      nearestPatchFace;\n        value           uniform ${value};`
}

/** Classify every patch of one region: interface, inlet, outlet, wall, other. */
function rolesOf(patches, region) {
  return patches.map((p) => {
    const interfacePatch = isInterface(p.name, region)
    return {
      ...p,
      interface: interfacePatch,
      role: interfacePatch ? 'interface' : classifyPatch(p.name, p.type),
    }
  })
}

function fluidFields({ caps, roles, Uinlet, Tinlet, pInitial }) {
  const block = (name, body) => `    ${name}\n    {\n${body}\n    }`
  const perPatch = (fn) => roles.map((r) => block(r.name, fn(r))).join('\n\n')
  const U = perPatch((r) => {
    // com's flowRateInletVelocity needs a flow rate, not a mean velocity: use a
    // plain fixed value there so the recipe stays mechanism-agnostic.
    if (r.role === 'inlet') return caps.modular
      ? `        type            flowRateInletVelocity;\n        meanVelocity    constant ${Uinlet};\n        value           uniform (${Uinlet} 0 0);`
      : `        type            fixedValue;\n        value           uniform (${Uinlet} 0 0);`
    if (r.role === 'outlet') return '        type            pressureInletOutletVelocity;\n        value           uniform (0 0 0);'
    if (r.role === 'interface') return '        type            noSlip;'
    return '        type            noSlip;'
  })
  const p = perPatch((r) => (r.role === 'interface' || r.role === 'inlet'
    ? `        type            calculated;\n        value           uniform ${pInitial};`
    : `        type            zeroGradient;`))
  const pRgh = perPatch((r) => (r.role === 'outlet'
    ? `        type            fixedValue;\n        value           uniform ${pInitial};`
    : `        type            fixedFluxPressure;\n        value           uniform ${pInitial};`))
  const T = perPatch((r) => {
    if (r.role === 'interface') return interfaceT(caps, 'fluid', Tinlet)
    if (r.role === 'inlet') return `        type            fixedValue;\n        value           uniform ${Tinlet};`
    if (r.role === 'outlet') return `        type            inletOutlet;\n        inletValue      uniform ${Tinlet};\n        value           uniform ${Tinlet};`
    return '        type            zeroGradient;'
  })
  return { U, p, pRgh, T }
}

/** Per-region dictionaries and the glue files for a CHT case. */
export function scaffoldCht({
  caps,
  regions,
  Uinlet = 5,
  Tinlet = 500,
  Tsolid = 300,
  pInitial = 1e5,
  solid = { rho: 1000, Cv: 0.5, kappa: 50 },
  endTime = 0.02,
  deltaT = 1e-4,
  writeInterval = 0.01,
} = {}) {
  const warnings = []
  const notes = []
  const files = {}
  const fluid = regions.filter((r) => r.kind === 'fluid')
  const solidRegions = regions.filter((r) => r.kind === 'solid')
  if (!fluid.length || !solidRegions.length) {
    return { ok: false, error: 'a CHT case needs at least one fluid region and one solid region' }
  }
  const modular = Boolean(caps.modular)

  for (const region of regions) {
    const roles = rolesOf(region.patches, region.name)
    const interfaces = roles.filter((r) => r.interface)
    if (!interfaces.length) warnings.push(`region ${region.name} has no <region>_to_<other> interface patch`)
    const hasOutlet = roles.some((r) => r.role === 'outlet')
    if (region.kind === 'fluid' && !hasOutlet) warnings.push(`fluid region ${region.name} has no outlet patch`)

    if (region.kind === 'fluid') {
      const f = fluidFields({ caps, roles, Uinlet, Tinlet, pInitial })
      const body = (text) => BANNER('volScalarField', 'T') // placeholder, replaced below
      const boundary = (inner) => `boundaryField\n{\n${inner}\n\n    #includeEtc "caseDicts/setConstraintTypes"\n}\n`
      files[`0/${region.name}/U`] = BANNER('volVectorField', 'U') + `\ndimensions      [0 1 -1 0 0 0 0];\n\ninternalField   uniform (0 0 0);\n\n` + boundary(f.U)
      files[`0/${region.name}/p`] = BANNER('volScalarField', 'p') + `\ndimensions      [1 -1 -2 0 0 0 0];\n\ninternalField   uniform ${pInitial};\n\n` + boundary(f.p)
      files[`0/${region.name}/p_rgh`] = BANNER('volScalarField', 'p_rgh') + `\ndimensions      [1 -1 -2 0 0 0 0];\n\ninternalField   uniform ${pInitial};\n\n` + boundary(f.pRgh)
      files[`0/${region.name}/T`] = BANNER('volScalarField', 'T') + `\ndimensions      [0 0 0 1 0 0 0];\n\ninternalField   uniform ${Tinlet};\n\n` + boundary(f.T)
      const fluidThermo = caps.modular ? 'physicalProperties' : 'thermophysicalProperties'
      // org modular solves internal energy (hePsiThermo); com's chtMultiRegionFoam
      // reads a rho-thermo with enthalpy (heRhoThermo + sensibleEnthalpy).
      const thermoType = caps.modular
        ? 'hePsiThermo;\n    mixture         pureMixture;\n    transport       const;\n    thermo          hConst;\n    equationOfState perfectGas;\n    specie          specie;\n    energy          sensibleInternalEnergy;'
        : 'heRhoThermo;\n    mixture         pureMixture;\n    transport       const;\n    thermo          hConst;\n    equationOfState perfectGas;\n    specie          specie;\n    energy          sensibleEnthalpy;'
      files[`constant/${region.name}/${fluidThermo}`] = BANNER('dictionary', fluidThermo) + `
thermoType
{
    type            ${thermoType}
}

mixture
{
    specie { molWeight 28.9; }
    thermodynamics { Cp 1005; ${caps.modular ? 'hf' : 'Hf'} 0; }
    transport { mu 1.8e-05; Pr 0.7; }
}
`
      if (caps.modular) {
        files[`constant/${region.name}/momentumTransport`] = BANNER('dictionary', 'momentumTransport') + '\nsimulationType  laminar;\n'
        files[`constant/${region.name}/thermophysicalTransport`] = BANNER('dictionary', 'thermophysicalTransport') + `
laminar
{
    model           unityLewisFourier;
}
`
      } else {
        files[`constant/${region.name}/turbulenceProperties`] = BANNER('dictionary', 'turbulenceProperties') + '\nsimulationType  laminar;\n'
      }
      files[`constant/${region.name}/pRef`] = BANNER('dictionary', 'pRef') + `\ndimensions      [1 -1 -2 0 0 0 0];\nvalue           ${pInitial};\n`
      files[`constant/${region.name}/g`] = BANNER('dictionary', 'g') + '\ndimensions      [0 1 -2 0 0 0 0];\nvalue           (0 0 0);\n'
      files[`system/${region.name}/fvSchemes`] = BANNER('dictionary', 'fvSchemes') + `
ddtSchemes { default Euler; }
gradSchemes { default Gauss linear; }
divSchemes
{
    default         none;
    div(phi,U)      Gauss linearUpwind grad(U);
${caps.modular
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
      files[`system/${region.name}/fvSolution`] = BANNER('dictionary', 'fvSolution') + `
solvers
{
    p_rgh { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
    p_rghFinal { $p_rgh; relTol 0; }
    "(rho|U|e)" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0.1; }
    "(rho|U|e)Final" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0; }
}
PIMPLE { nCorrectors 2; nNonOrthogonalCorrectors 1; nOuterCorrectors 1; }
relaxationFactors { equations { ".*" 1; } }
`
    } else {
      const inner = roles.map((r) => `    ${r.name}\n    {\n${interfaceT(caps, 'solid', Tsolid)}\n    }`).join('\n\n')
      files[`0/${region.name}/T`] = BANNER('volScalarField', 'T') + `\ndimensions      [0 0 0 1 0 0 0];\n\ninternalField   uniform ${Tsolid};\n\nboundaryField\n{\n${inner}\n}\n`
      const solidThermo = caps.modular ? 'physicalProperties' : 'thermophysicalProperties'
      const solidBody = caps.modular
        ? `thermoType
{
    type            heSolidThermo;
    mixture         pureMixture;
    transport       constIsoSolid;
    thermo          eConst;
    equationOfState rhoConst;
    specie          specie;
    energy          sensibleInternalEnergy;
}

mixture
{
    specie { nMoles 1; molWeight 63.5; }
    transport { kappa ${solid.kappa}; }
    thermodynamics { hf 0; Cv ${solid.Cv}; }
    equationOfState { rho ${solid.rho}; }
}
`
        : `thermoType
{
    type            heSolidThermo;
    mixture         pureMixture;
    transport       constIso;
    thermo          hConst;
    equationOfState rhoConst;
    specie          specie;
    energy          sensibleEnthalpy;
}

mixture
{
    specie { nMoles 1; molWeight 63.5; }
    transport { kappa ${solid.kappa}; }
    thermodynamics { Hf 0; Cp ${solid.Cv}; }
    equationOfState { rho ${solid.rho}; }
}
`
      files[`constant/${region.name}/${solidThermo}`] = BANNER('dictionary', solidThermo) + '\n' + solidBody
      files[`system/${region.name}/fvSchemes`] = BANNER('dictionary', 'fvSchemes') + `
ddtSchemes { default Euler; }
gradSchemes { default Gauss linear; }
divSchemes { default none; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
`
      files[`system/${region.name}/fvSolution`] = BANNER('dictionary', 'fvSolution') + `
solvers
{
    "(h|e)" { solver PCG; preconditioner DIC; tolerance 1e-6; relTol 0.1; }
    "(h|e)Final" { solver PCG; preconditioner DIC; tolerance 1e-6; relTol 0; }
}
PIMPLE { nNonOrthogonalCorrectors 1; nOuterCorrectors 1; }
`
    }
  }

  // Case-level glue: com reads constant/g at the case root.
  files['constant/g'] = BANNER('dictionary', 'g') + '\ndimensions      [0 1 -2 0 0 0 0];\nvalue           (0 0 0);\n'

  // Case-level glue.
  const map = regions.map((r) => `    ${r.name}           ${r.kind === 'fluid' ? 'fluid' : 'solid'};`).join('\n')
  files['system/fvSolution'] = BANNER('dictionary', 'fvSolution') + `
solvers
{
    p_rgh { solver GAMG; smoother GaussSeidel; tolerance 1e-7; relTol 0.01; }
    p_rghFinal { $p_rgh; relTol 0; }
    "(rho|U|e)" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0.1; }
    "(rho|U|e)Final" { solver PBiCGStab; preconditioner DILU; tolerance 1e-7; relTol 0; }
    "(h|e)" { solver PCG; preconditioner DIC; tolerance 1e-6; relTol 0.1; }
    "(h|e)Final" { solver PCG; preconditioner DIC; tolerance 1e-6; relTol 0; }
}
PIMPLE { nCorrectors 2; nNonOrthogonalCorrectors 1; nOuterCorrectors 1; }
relaxationFactors { equations { ".*" 1; } }
`
  if (modular) {
    files['system/regionSolvers'] = BANNER('dictionary', 'regionSolvers') + `\nregionSolvers\n{\n${map}\n}\n`
    files['system/controlDict'] = BANNER('dictionary', 'controlDict') + `
#includeIfPresent "regionSolvers"

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
  } else {
    const list = (kind) => regions.filter((r) => r.kind === kind).map((r) => r.name).join(' ')
    files['constant/regionProperties'] = BANNER('dictionary', 'regionProperties') + `\nregions\n(\n    fluid       (${list('fluid')})\n    solid       (${list('solid')})\n);\n`
    files['system/controlDict'] = BANNER('dictionary', 'controlDict') + `
application     chtMultiRegionFoam;

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
  }
  notes.push(modular
    ? 'org conventions: system/regionSolvers + foamMultiRun'
    : 'com conventions: constant/regionProperties + chtMultiRegionFoam')
  notes.push(`per-region 0/<region>/ fields were written under 0/ (no 0.orig round trip needed)`)
  return { ok: true, files, warnings, notes, regions: regions.map((r) => ({ name: r.name, kind: r.kind, patches: rolesOf(r.patches, r.name).map((x) => ({ name: x.name, role: x.role })) })) }
}
