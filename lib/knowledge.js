import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { experienceDirOf, run } from './runtime.js'

const ERROR_PATTERNS = [
  { re: /floating point exception|FOAM FATAL ERROR.*FPE|signal\s+FPE/i, category: 'NaN/Inf numerical divergence (FPE)', causes: ['CFL too large -> reduce dt or use adaptive deltaT', 'inconsistent BCs cause a division by zero at t=0', '0/ was not setFields-ed, alpha/T are still default', 'a property is zero (e.g. mu=0, sigma=0)'], steps: ['openfoam_solver_status to find the first nan/Inf step', 'openfoam_residual_series to see which field diverges first', 'openfoam_case_probe_facts to confirm properties', 'openfoam_inspect_case to check dimensions/internalField'] },
  { re: /Cannot find file.*system\/(controlDict|fvSchemes|fvSolution|blockMeshDict)/i, category: 'missing system/ dictionary', causes: ['the case is incomplete', 'the cwd is not the case directory'], steps: ['openfoam_inspect_case to verify system/', 'check the cwd'] },
  { re: /keyword (\w+) is undefined in dictionary/i, category: 'missing or misspelled dictionary keyword', causes: ['template and solver versions do not match', 'a required entry is missing', 'the keyword was renamed in this OpenFOAM version'], steps: ['openfoam_find_tutorial for a template of the same solver', 'openfoam_read_dict for the accepted keys'] },
  { re: /unknown patch type|Unknown patchField type|unknown boundary condition/i, category: 'BC / patch type not registered', causes: ['BC name misspelled', 'the required lib is not linked in controlDict.libs', 'the solver does not support that BC'], steps: ['openfoam_find_source for the correct spelling', 'add libs ("...") in controlDict', 'openfoam_case_probe_facts for the BCs the solver supports'] },
  { re: /dimensions of .* are not (correct|consistent|dimensionally)/i, category: 'inconsistent dimensions', causes: ['wrong dimensions in 0/ (k = [0 2 -2 0 0 0 0])', 'the BC value has wrong units', '0/ out of sync with 0.orig/'], steps: ['read the dimensions line of the failing field', 'openfoam_algo_extract_contract for the paper units', 're-copy from 0.orig'] },
  { re: /Maximum number of iterations exceeded.*GAMG|smoothSolver.*did not converge|PCG.*did not converge/i, category: 'linear solver did not converge', causes: ['poor mesh quality, maxNonOrtho > 70', 'tolerance/relTol too strict', 'wrong smoother'], steps: ['openfoam_mesh_verify for maxNonOrtho/skewness', 'tune fvSolution: loosen tolerance / GaussSeidel / DIC'] },
  { re: /Inconsistent\s+addressing|negative volume|negative determinant|skewness exceeds/i, category: 'bad mesh cells', causes: ['snappyHexMesh carved out a region', 'thin sliver cells', 'the STL normals are inverted'], steps: ['openfoam_mesh_verify', 'openfoam_mesh_stl_check', 'raise minVol / reduce first_layer_thickness'] },
  { re: /Cannot find cellSet|Cannot find cellZone/i, category: 'setFields region selector matched nothing', causes: ['the boxToCell bbox extends beyond the mesh', 'cellSet/cellZone name misspelled', 'setSet/topoSet was not run'], steps: ['shrink the setFieldsDict bbox to the mesh extent', 'run topoSet/setFields'] },
  { re: /Maximum number of nonlinear iterations|Continuity error/i, category: 'continuity / p-U coupling imbalance', causes: ['not enough PIMPLE nOuterCorrectors', 'inlet/outlet do not conserve mass', 'wrong atmosphere BC type'], steps: ['raise nOuterCorrectors to 3-5', 'openfoam_case_probe_facts to check patch pairing'] },
  { re: /undefined reference to|error: .*was not declared|fatal error: .*\.H: No such file/i, category: 'C++ compile error', causes: ['header path missing from EXE_INC', 'library missing from LIB_LIBS', 'an inherited virtual function is not implemented'], steps: ['openfoam_dry_compile to catch the first error', 'read Make/options for -I and -l', 'openfoam_find_source for a reference'] },
  { re: /signal\s+(11|SIGSEGV)|segmentation fault/i, category: 'SegFault', causes: ['out-of-bounds container access', 'inconsistent parallel decomposition', 'an unregistered scheme name'], steps: ['rerun serially', 'validate every scheme name in fvSchemes'] },
  { re: /not in patches|patches do not match|patches don't match/i, category: 'patch name mismatch', causes: ['patch names in 0/ != polyMesh/boundary', '0/ was not updated after blockMesh regenerated the mesh'], steps: ['openfoam_inspect_case to list actual patches', 'align boundaryField in every 0/ field'] },
  { re: /Time step continuity errors.*sum local = [\d.eE+-]+, global = [\d.eE+-]+, cumulative/i, category: 'mass conservation drift', causes: ['inlet/outlet fluxes are unbalanced', 'wrong p BC type'], steps: ['openfoam_case_probe_facts for inlet/outlet pairing', 'openfoam_inspect_case for boundaryField of 0/p'] },
  { re: /No such file or directory/i, category: 'file not found', causes: ['wrong path', 'the previous step never produced it'], steps: ['verify the parent directory', 'check the previous step exit code'] },
  { re: /Floating point exception.*nan|Foam::error::printStack|FOAM aborting/i, category: 'OpenFOAM aborted deliberately', causes: ['the solver stopped after seeing nan', 'patch pairing error'], steps: ['read the 50 log lines before the abort', 'diagnose the previous error block'] },
]

export function loadErrorPatterns(cfg) {
  try {
    const a = JSON.parse(readFileSync(join(experienceDirOf(cfg), '_error_patterns.json'), 'utf8'))
    return Array.isArray(a) ? a : []
  } catch {
    return []
  }
}

export function diagnoseError(cfg, text) {
  const s = String(text || '')
  if (!s.trim()) return { ok: false, error: 'text is empty' }
  const learned = loadErrorPatterns(cfg).map((e) => {
    let re
    try { re = new RegExp(e.pattern, e.flags || 'i') } catch { re = /$a^/ }
    return { re, category: (e.category || 'Learned') + ' (learned)', causes: e.causes || [], steps: e.steps || [] }
  })
  const hits = []
  for (const p of ERROR_PATTERNS.concat(learned)) {
    const m = s.match(p.re)
    if (m) hits.push({ category: p.category, matched_snippet: m[0].slice(0, 120), causes: p.causes, next_steps: p.steps })
  }
  if (!hits.length) {
    return { ok: true, matched: false, hint: `No known pattern matched (${ERROR_PATTERNS.length} built-in + ${learned.length} learned). Paste the log tail and, after fixing it, register the pattern with openfoam_learn_error_pattern.` }
  }
  return { ok: true, matched: true, count: hits.length, hits }
}

export const SOLVER_MAP = {
  // OF14 modules (foamRun "solver" values)
  incompressibleFluid: ['incompressible single-phase', false, 1],
  isothermalFluid: ['isothermal compressible single-phase', true, 1],
  multicomponentFluid: ['compressible multicomponent/combustion', true, 1],
  shockFluid: ['compressible (shock capturing)', true, 1],
  XiFluid: ['premixed combustion (Xi)', true, 1],
  incompressibleVoF: ['VOF two-phase (incompressible)', false, 2],
  compressibleVoF: ['VOF two-phase (compressible)', true, 2],
  incompressibleMultiphaseVoF: ['VOF multiphase (incompressible)', false, 2],
  compressibleMultiphaseVoF: ['VOF multiphase (compressible)', true, 2],
  multiphaseEuler: ['Euler-Euler multiphase', null, 2],
  incompressibleDriftFlux: ['drift-flux two-phase (incompressible)', false, 2],
  incompressibleDenseParticleFluid: ['Euler-Lagrange dense particles', false, 1],
  solid: ['solid mechanics', null, 1],
  solidDisplacement: ['solid displacement', null, 1],
  film: ['thin film', null, 1],
  isothermalFilm: ['thin film (isothermal)', null, 1],
  movingMesh: ['mesh motion', null, 1],
  fluid: ['generic fluid', null, 1],
  // application entry points (applications/solvers)
  chemFoam: ['chemical kinetics (0-D reactor)', true, 1],
  potentialFoam: ['potential flow', false, 1],
  boundaryFoam: ['boundary-layer profile', false, 1],
  foamRun: ['generic modular solver runner', null, null],
  foamMultiRun: ['generic multi-region runner', null, null],
  basicFluidSolver: ['base fluid solver module', null, null],
  twoPhaseSolver: ['two-phase base', null, 2],
  // legacy solvers
  icoFoam: ['incompressible single-phase', false, 1],
  simpleFoam: ['incompressible single-phase', false, 1],
  pisoFoam: ['incompressible single-phase', false, 1],
  pimpleFoam: ['incompressible single-phase', false, 1],
  laplacianFoam: ['scalar transport (incompressible)', false, 1],
  porousSimpleFoam: ['incompressible porous', false, 1],
  rhoPorousSimpleFoam: ['compressible porous', true, 1],
  shallowWaterFoam: ['shallow water', false, 1],
  adjointShapeOptimisationFoam: ['incompressible adjoint', false, 1],
  PDRFoam: ['premixed combustion (PDR)', true, 1],
  mhdFoam: ['magnetohydrodynamics', false, 1],
  electrostaticFoam: ['electrostatics', false, 1],
  magneticFoam: ['magnetostatics', false, 1],
  dsmcFoam: ['DSMC (rarefied gas)', true, 1],
  mdFoam: ['molecular dynamics', null, 1],
  mdEquilibrationFoam: ['molecular dynamics (equilibration)', null, 1],
  financialFoam: ['financial (not CFD)', null, 1],
}

export function classifySolver(name) {
  const sm = SOLVER_MAP[name]
  if (sm) return { governing: sm[0], compressible: sm[1], phases: sm[2] }
  if (/^rho/.test(name)) return { governing: 'compressible single-phase', compressible: true, phases: 1 }
  if (/VoF/i.test(name) || /^inter/.test(name)) return { governing: 'VOF two-phase', compressible: null, phases: 2 }
  if (/(twoPhaseEuler|multiphaseEuler)/.test(name)) return { governing: 'Euler-Euler multiphase', compressible: null, phases: 2 }
  if (/buoyant/.test(name)) return { governing: 'buoyant (T-coupled)', compressible: null, phases: 1 }
  if (/reacting|combustion|Xi/i.test(name)) return { governing: 'reacting/combustion', compressible: true, phases: 1 }
  return { governing: null, compressible: null, phases: null }
}
