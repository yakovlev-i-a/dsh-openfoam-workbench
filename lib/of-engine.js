// dsh-openfoam-doctor engine: an OpenFOAM dictionary parser plus the checks
// that catch the failures which do not announce themselves.
//
// The OpenFOAM dict format is not JSON and not YAML: C-style /* */ and //
// comments, nested braces, bare tokens as values, quoted keys like
// "(U|k|epsilon)", and a banner header of escaped backslashes. A generic
// parser either chokes on the banner or silently drops entries, so this one
// strips comments first, then walks braces while tracking a key stack.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { classifySolver } from './knowledge.js'

// =====================================================================
// Dictionary parsing
// =====================================================================

// Remove block and line comments without touching strings or the banner.
// (The banner contains escaped backslashes, so a naive strip would eat it.)
function stripComments(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      out += ' '
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      out += '\n'
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Parse an OpenFOAM dictionary into a nested plain object.
 * Values stay strings (OpenFOAM values are tokens, not JSON scalars); lists
 * become arrays of strings; sub-dictionaries become objects.
 */
export function parseDict(text) {
  const src = stripComments(text)
  const root = {}
  // stack of {obj, key} where key is the dictionary a `{` opened under
  const stack = [{ obj: root, key: null }]
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '{') {
      // open a sub-dict under the last seen key of the current object
      const top = stack.at(-1)
      const lastKey = top.key
      if (lastKey === null) {
        // the FoamFile header block: capture nothing, push a scratch object
        stack.push({ obj: {}, key: null })
        i++
        continue
      }
      const child = {}
      top.obj[lastKey] = child
      stack.push({ obj: child, key: null })
      i++
      continue
    }
    if (c === '}') {
      if (stack.length > 1) stack.pop()
      i++
      continue
    }
    if (c === ';') {
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    // read a token: quoted key, or bare run up to whitespace/;{}
    let token = ''
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          token += src[j + 1]
          j += 2
          continue
        }
        token += src[j]
        j++
      }
      i = j + 1
    } else {
      let j = i
      while (j < src.length && !/[\s;{}]/.test(src[j])) {
        token += src[j]
        j++
      }
      i = j
    }
    if (token === '') continue
    // after a token, either `key value`, or `key {`
    const after = src.slice(i)
    const braceAfter = /^\s*\{/.test(after)
    const semiAfter = /^\s*;/.test(after)
    if (braceAfter || semiAfter) {
      // this token is a key whose value is a dict (or an empty entry)
      stack.at(-1).key = token
      if (semiAfter) {
        // `key;` with no value — record as empty so the key exists
        stack.at(-1).obj[token] = ''
        stack.at(-1).key = null
        i = after.indexOf(';') + 1 + i
      }
      continue
    }
    // A preprocessor directive takes the rest of the line and nothing else.
    // Letting the normal token loop run on swallowed the following entry: on
    // OF11's movingCone/0/p the movingWall patch and its BC vanished into the
    // include's value (452 tutorial files carry an #include at the top of a
    // sub-dict).
    if (token.startsWith('#')) {
      let j = i
      while (j < src.length && src[j] !== '\n') j++
      stack.at(-1).obj[token] = src.slice(i, j).trim()
      stack.at(-1).key = null
      i = j
      continue
    }
    // read the value token(s) up to the statement end
    let value = ''
    let j = i
    while (j < src.length) {
      // skip whitespace
      while (j < src.length && /\s/.test(src[j])) j++
      if (j >= src.length || src[j] === ';') break
      if (src[j] === '{') break // value list handled below
      // A `}` while a value is pending means the dict closed early. Breaking
      // (rather than falling into the token reader, which cannot consume it and
      // therefore never advances j) is what kept parseDict spinning forever on
      // `foo\n}` — a hang that blocks the event loop, so no timeout can fire.
      if (src[j] === '}') break
      let v = ''
      if (src[j] === '$') {
        // ${deltaT} / $FOAM_CASE: one token, or the `{` opens a bogus dict level
        let k = j + 1
        if (src[k] === '{') {
          k++
          while (k < src.length && src[k] !== '}') k++
          k++
        } else {
          while (k < src.length && /[A-Za-z0-9_]/.test(src[k])) k++
        }
        v = src.slice(j, k)
        j = k
        value = value === '' ? v : `${value} ${v}`
        continue
      }
      if (src[j] === '"') {
        let k = j + 1
        while (k < src.length && src[k] !== '"') {
          if (src[k] === '\\' && k + 1 < src.length) {
            v += src[k + 1]
            k += 2
            continue
          }
          v += src[k]
          k++
        }
        j = k + 1
      } else {
        let k = j
        while (k < src.length && !/[\s;{}]/.test(src[k])) {
          v += src[k]
          k++
        }
        // never stall: an unconsumable character must still move j forward
        if (k === j) {
          v += src[j]
          k++
        }
        j = k
      }
      value = value === '' ? v : `${value} ${v}`
    }
    const top = stack.at(-1)
    // a `( ... )` list: collect until the closing paren
    if (value.startsWith('(') && !value.endsWith(')')) {
      let raw = value
      while (j < src.length && !raw.trimEnd().endsWith(')')) {
        raw += src[j]
        j++
      }
      value = raw.trim()
      // consume the trailing ;
      while (j < src.length && src[j] !== ';') j++
    }
    top.obj[token] = value.trim()
    top.key = null
    i = j
  }
  return root
}

// =====================================================================
// Case layout discovery
// =====================================================================
export const CASE_FILES = {
  control: 'system/controlDict',
  schemes: 'system/fvSchemes',
  solution: 'system/fvSolution',
  blockMesh: 'system/blockMeshDict',
  snappyMesh: 'system/snappyHexMeshDict',
  decompose: 'system/decomposeParDict',
  surfaceFeatures: 'system/surfaceFeatureExtractDict',
}

const safeRead = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** `system/fvSchemes` -> `system/<region>/fvSchemes` when that file exists. */
function regionPath(caseDir, rel, region) {
  if (!region) return rel
  const parts = String(rel).split('/')
  if ((parts[0] === 'system' || parts[0] === 'constant') && parts.length >= 2) {
    const alt = [parts[0], region, ...parts.slice(1)].join('/')
    if (existsSync(join(caseDir, alt))) return alt
  }
  return rel
}

export function readCaseDict(caseDir, rel, region = '') {
  const text = safeRead(join(caseDir, regionPath(caseDir, rel, region)))
  return text === null ? null : parseDict(text)
}

/** Numeric-looking tokens: "3000" -> 3000, "1e-07" -> 1e-7, else NaN. */
export function num(value) {
  if (value === undefined || value === null) return NaN
  const s = String(value).trim()
  if (s === '') return NaN
  const m = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.exec(s)
  return m ? Number(s) : NaN
}

/** Time directories that are not the expected start (stray run state). */
export function strayTimeDirs(caseDir) {
  if (!existsSync(caseDir)) return []
  const out = []
  for (const e of readdirSyncSafe(caseDir)) {
    if (!/^\d+(\.\d+)?$/.test(e)) continue
    // a time dir that holds field data rather than being the uniform start
    if (e === '0' || e === 'uniform') continue
    const p = join(caseDir, e)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch {
      continue
    }
    out.push(e)
  }
  return out.sort((a, b) => Number(a) - Number(b))
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Which field files exist under 0/ (or the first time dir). */
export function fieldFiles(caseDir, region = '') {
  const zeroCandidates = region
    ? ['0', '0.orig', '0_orig'].map((n) => join(caseDir, n, region))
    : ['0', '0.orig', '0_orig'].map((n) => join(caseDir, n))
  const zero = zeroCandidates.find((p) => existsSync(p))
  const dir = zero ?? caseDir
  // h/alphat/pcorr are what a compressible or transient case actually carries;
  // omitting them made `checkBoundaryFields` skip those cases silently.
  return readdirSyncSafe(dir).filter((f) => /^(U|k|epsilon|p|p_rgh|T|nut|nuTilda|omega|phi|h|alphat|pcorr)$/.test(f))
}

// =====================================================================
// Checks. Each returns findings: {rule, severity, title, detail, fix}
// =====================================================================

const F = (rule, severity, title, detail, fix) => ({ rule, severity, title, detail, fix })

// Patch-field types the workbench is confident about. Anything else is reported
// as advice: the solver prints its own valid list, which is the authority.
const KNOWN_BC_TYPES = new Set([
  'fixedValue', 'fixedGradient', 'zeroGradient', 'calculated', 'mixed', 'uniformFixedValue',
  'noSlip', 'slip', 'partialSlip', 'symmetry', 'symmetryPlane', 'empty', 'wedge', 'cyclic', 'cyclicSlip',
  'inletOutlet', 'outletInlet', 'inletOutletTotalTemperature', 'pressureInletOutletVelocity',
  'pressureInletOutletParSlipVelocity', 'totalPressure', 'fixedFluxPressure', 'fixedMean',
  'waveTransmissive', 'advective', 'freestream', 'freestreamVelocity', 'freestreamPressure',
  'turbulentInlet', 'turbulentIntensityKineticEnergyInlet', 'turbulentMixingLengthDissipationRateInlet',
  'turbulentMixingLengthFrequencyInlet', 'turbulentKineticEnergy', 'turbulentOmega',
  'kqRWallFunction', 'kLowReWallFunction', 'epsilonWallFunction', 'omegaWallFunction',
  'nutkWallFunction', 'nutUWallFunction', 'nutLowReWallFunction', 'nutUSpaldingWallFunction',
  'v2WallFunction', 'fWallFunction',  // alphat wall functions exist only prefixed (compressible::)

  'prghPressure', 'prghTotalPressure', 'fixedInternalValue', 'extrapolatedCalculated',
  'codedFixedValue', 'codedMixed', 'timeVaryingMappedFixedValue', 'mapped', 'mappedValue',
  'interfaceCompression', 'flowRateInletVelocity', 'flowRateOutletVelocity', 'uniformInletOutlet',
])

export function checkControlDict(caseDir, region = '') {
  const d = readCaseDict(caseDir, CASE_FILES.control)
  const out = []
  if (d === null) return [F('missing-file', 'error', 'system/controlDict not found', 'A case without controlDict cannot run.', 'Restore it from a working case or the tutorial.')]
  const schemes = readCaseDict(caseDir, CASE_FILES.schemes, region)
  const ddt = schemes?.ddtSchemes?.default ?? ''
  const isSteady = /steadyState/.test(ddt)
  const writeControl = String(d.writeControl ?? '')
  const writeInterval = String(d.writeInterval ?? '')
  const endTime = num(d.endTime)
  const deltaT = num(d.deltaT)
  const startTime = num(d.startTime)
  const stopAt = String(d.stopAt ?? '')
  const purgeWrite = num(d.purgeWrite)

  // 1. steadyState + timeStep writeInterval: writes are per iteration, so a
  //    steady case silently produces a huge number of time dirs.
  if (isSteady && writeControl === 'timeStep' && num(writeInterval) > 0 && endTime / num(writeInterval) > 20) {
    out.push(
      F(
        'steady-write-flood',
        'warn',
        `steady case writes ${Math.round(endTime / num(writeInterval))} time directories`,
        `ddtSchemes is steadyState but writeControl is timeStep with writeInterval ${writeInterval} over endTime ${endTime}. Every write becomes a time directory, so disk grows by that factor and foamToVTK/converting takes just as long.`,
        'For a steady run prefer writeControl runTime/writeInterval, or a much larger writeInterval (e.g. 500).',
      ),
    )
  }

  // 2. writeInterval not a multiple of the step: skipped writes look like lost data.
  if (writeControl === 'timeStep' && num(writeInterval) > 0 && Number.isFinite(deltaT) && deltaT > 0) {
    const perWrite = num(writeInterval)
    if (!Number.isInteger(perWrite)) {
      out.push(
        F(
          'write-interval-fractional',
          'error',
          `writeInterval ${writeInterval} is not an integer step count`,
          'writeControl timeStep interprets writeInterval as a number of time steps, so a fractional value is silently truncated and writes land where you do not expect.',
          'Use an integer number of steps.',
        ),
      )
    }
  }

  // 3. purgeWrite 0 with a long run: unbounded disk growth.
  if (purgeWrite === 0 && Number.isFinite(endTime) && endTime > 0 && num(writeInterval) > 0 && endTime / num(writeInterval) > 10) {
    out.push(
      F(
        'no-purge',
        'warn',
        'purgeWrite is 0 on a run that writes many times',
        'Nothing is ever deleted, so a long parameter sweep fills the disk. purgeWrite 2 keeps only the last two.',
        'Set purgeWrite 2 (or more) once you no longer need every step.',
      ),
    )
  }

  // 4. startTime/stopAt mismatch: restarting from the wrong time is silent.
  if (stopAt === 'endTime' && Number.isFinite(startTime) && Number.isFinite(endTime) && startTime > endTime) {
    out.push(F('start-after-end', 'error', `startTime ${startTime} is after endTime ${endTime}`, 'The solver exits immediately with nothing written.', 'Fix the times.'))
  }

  // 4b. writeInterval longer than the run: a time-based writeControl that is
  //     never reached writes nothing at all, and OpenFOAM says nothing — the run
  //     looks successful and there is no time directory to post-process.
  if (/^(adjustable)?[Rr]unTime$/.test(writeControl) && Number.isFinite(endTime) && Number.isFinite(startTime)) {
    const span = endTime - startTime
    const every = num(writeInterval)
    if (Number.isFinite(every) && every > 0 && span > 0 && every > span) {
      out.push(
        F(
          'write-never-fires',
          'warn',
          `writeControl ${writeControl} with writeInterval ${writeInterval} over a ${span} s run never writes`,
          'The first write is due at startTime + writeInterval, which is past endTime, so the run finishes with no time directory and nothing to post-process. purgeWrite and foamToVTK then act on an empty case.',
          `Set writeInterval below ${span} (e.g. ${Math.max(1, Math.round(span / 10))}).`,
        ),
      )
    }
  }

  // 5. functions referencing probeLocations on a case with no field files.
  const funcs = d.functions && typeof d.functions === 'object' ? Object.keys(d.functions) : []
  if (funcs.includes('probes')) {
    const fields = fieldFiles(caseDir)
    if (fields.length === 0) {
      out.push(
        F(
          'probes-no-fields',
          'warn',
          'controlDict defines a probes functionObject but 0/ has no field files',
          'probes reads the fields named in its `fields` entry; without them it writes empty or fails at the first write step.',
          'Ensure 0/ contains U, k, epsilon, p (or adjust the probes `fields` list).',
        ),
      )
    }
  }
  return out
}

export function checkFvSchemes(caseDir, region = '') {
  const d = readCaseDict(caseDir, CASE_FILES.schemes, region)
  const out = []
  if (d === null) return [F('missing-file', 'error', `system/${region ? region + '/' : ''}fvSchemes not found`, 'The solver cannot start without numerical schemes.', 'Copy one from a tutorial and adapt it.')]
  if (!d.ddtSchemes?.default) {
    out.push(F('no-ddt', 'error', 'fvSchemes has no ddtSchemes default', 'The solver aborts with "no ddtSchemes" on the first iteration.', 'Add ddtSchemes { default steadyState; } for steady, or Euler for transient.'))
  }
  if (!d.gradSchemes?.default) {
    out.push(F('no-grad', 'error', 'fvSchemes has no gradSchemes default', 'Gradients are required by every convection term.', 'Add gradSchemes { default Gauss linear; }.'))
  }
  const div = d.divSchemes && typeof d.divSchemes === 'object' ? d.divSchemes : {}
  for (const [term, scheme] of Object.entries(div)) {
    const s = String(scheme)
    // limitedLinear k blends toward upwind with psi = clamp(2r/k, 0, 1)
    // (finiteVolume/.../limitedLinear/limitedLinear.H). k -> 0 gives psi -> 1,
    // i.e. plain linear with no limiting; k = 1 is the conservative default and
    // larger k limits harder. Warn only when the limiter is effectively off.
    const lim = /limitedLinear\s+(\S+)/.exec(s)
    const factor = lim ? num(lim[1]) : NaN
    if (Number.isFinite(factor) && factor < 0.1) {
      out.push(
        F(
          'limiter-wide-open',
          'warn',
          `${term} uses limitedLinear ${lim[1]}: the limiter is effectively off`,
          'In this scheme psi = clamp(2r/k, 0, 1), so k -> 0 approaches pure linear convection: the limiter stops blending toward upwind and scalar transport (k, epsilon, h, T) can overshoot near steep gradients, producing negative values that break the turbulence model. OpenFOAM accepts 0 < k <= 1; k = 1 is the strongest limiter of this family.',
          'Use limitedLinear 1 (the strongest allowed value) for transported scalars, or limitedLinearV 1 for velocity.',
        ),
      )
    }
    // unbounded linear advection of a transport scalar
    if (/Gauss linear;/.test(s) && /div\(phi,(k|epsilon|h|T)\)/.test(term)) {
      out.push(
        F(
          'unbounded-scalar-advection',
          'warn',
          `${term} uses unbounded Gauss linear`,
          'Transport scalars advected with plain Gauss linear overshoot near steep gradients, which for k/epsilon means negative values that then break the turbulence model.',
          'Prefer bounded Gauss linearUpwind grad(<field>) or a limited scheme.',
        ),
      )
    }
    if (/dev2\(T\(grad\(U\)\)\)/.test(term) && !/bounded/.test(s)) {
      // info, not warn: every stock OpenFOAM 11 tutorial ships the unbounded
      // form, so warning on it flagged the reference cases themselves. The
      // advice is still worth showing once, on skewed meshes.
      out.push(
        F(
          'unbounded-viscous',
          'info',
          `${term} is not bounded`,
          'The viscous term without `bounded` can overshoot on skewed cells, showing up as velocity spikes at the wall. OpenFOAM\'s own tutorials use the unbounded form, so this is advice, not a defect.',
          'On a skewed mesh, use bounded Gauss linear.',
        ),
      )
    }
  }
  // Compressible solvers assemble an energy flux; with sensible internal energy
  // (org `fluid` + hePsiThermo) they also need the pressure-work term. A missing
  // one kills the first time step with "Cannot find scheme for div(phi,(p|rho))".
  const control = readCaseDict(caseDir, CASE_FILES.control, '')
  const solverName = String(control?.solver ?? control?.application ?? '')
  const solverClass = classifySolver(solverName)
  const compressible = solverClass.compressible === true || /^(fluid|isothermalFluid|multicomponentFluid|shockFluid|XiFluid)$/i.test(solverName)
  if (compressible) {
    const terms = Object.keys(div)
    const hasE = terms.some((t) => /div\(phi,e\)/.test(t))
    const hasH = terms.some((t) => /div\(phi,h\)/.test(t))
    const hasP = terms.some((t) => /div\(phi,\(p\|rho\)\)|div\(phid,\s*p\)/.test(t))
    if (!hasE && !hasH) {
      out.push(F('no-energy-flux-scheme', 'error', 'compressible solver without an energy-flux scheme (div(phi,e) or div(phi,h))', 'The energy equation cannot be assembled, so the solver aborts before the first step.', 'Add div(phi,e) for sensible internal energy (org) or div(phi,h) for enthalpy (com).'))
    } else if (hasE && !hasP) {
      out.push(F('no-pressure-work-scheme', 'warn', 'div(phi,e) is set but there is no div(phi,(p|rho))', 'With sensible internal energy the solver adds a pressure-work flux; without a scheme for it the first time step aborts with "Cannot find scheme for div(phi,(p|rho))".', 'Add div(phi,(p|rho)) Gauss upwind; (or use div(phi,h) with enthalpy).'))
    }
  }
  if (!d.laplacianSchemes?.default) {
    out.push(F('no-laplacian', 'error', 'fvSchemes has no laplacianSchemes default', 'Diffusion terms cannot be assembled.', 'Add laplacianSchemes { default Gauss linear corrected; }.'))
  }
  return out
}

export function checkFvSolution(caseDir, region = '') {
  const d = readCaseDict(caseDir, CASE_FILES.solution, region)
  const out = []
  if (d === null) return [F('missing-file', 'error', `system/${region ? region + '/' : ''}fvSolution not found`, 'The solver cannot start without linear solvers.', 'Copy one from a tutorial and adapt it.')]
  const blockMesh = readCaseDict(caseDir, CASE_FILES.blockMesh, region)
  // A transient case runs PIMPLE/PISO; the SIMPLE block may still exist with 0.
  // Take the correctors from the algorithm the ddt scheme implies.
  const regionSchemes = readCaseDict(caseDir, CASE_FILES.schemes, region)
  const transient = !/steadyState/.test(String(regionSchemes?.ddtSchemes?.default ?? ''))
  const algorithm = transient ? (d.PIMPLE ?? d.PISO ?? d.SIMPLE) : (d.SIMPLE ?? d.PIMPLE)
  const nNonOrtho = num(algorithm?.nNonOrthogonalCorrectors)
  const mesh = readCaseDict(caseDir, CASE_FILES.snappyMesh, region)
  // non-orthogonality comes from the mesh; snappy with high castellatin, or
  // a hand-built multi-block mesh, both raise it. `blocks ( … );` parses as a
  // STRING, and Object.keys on a string returns its indices — the old test was
  // really "the text is longer than 8 chars", so it fired on a single
  // orthogonal hex.
  const blockText = typeof blockMesh?.blocks === 'string' ? blockMesh.blocks : ''
  const blockCount = blockText ? (blockText.match(/\b(?:hex|tet|wedge|prism|splitHex|poly)\b/g) || []).length : Object.keys(blockMesh?.blocks || {}).length
  const skewLikely = Boolean(mesh?.castellatedMesh)
  if (nNonOrtho === 0 && skewLikely) {
    out.push(
      F(
        'no-nonortho-correctors',
        'warn',
        'nNonOrthogonalCorrectors is 0 on a mesh that is likely non-orthogonal',
        'On skewed cells the face-interpolation correction is what keeps the diffusion term second-order; skipping it makes SIMPLE stall at a residual plateau that looks like convergence trouble but is discretisation error.',
        'Set nNonOrthogonalCorrectors 1 (2 for strongly skewed meshes).',
      ),
    )
  }
  const solvers = d.solvers && typeof d.solvers === 'object' ? d.solvers : {}
  for (const [field, s] of Object.entries(solvers)) {
    if (!s || typeof s !== 'object') continue
    const tol = num(s.tolerance)
    const relTol = num(s.relTol)
    if (Number.isFinite(tol) && tol > 1e-3) {
      out.push(
        F(
          'loose-tolerance',
          'warn',
          `solver for ${field} has tolerance ${s.tolerance}`,
          'A loose linear tolerance leaves algebraic error in every iteration, which for pressure in SIMPLE shows up as a residual that will not drop further no matter how many iterations you run.',
          'Tighten to 1e-07 (pressure) / 1e-08 (transport fields).',
        ),
      )
    }
    if (Number.isFinite(relTol) && relTol > 0.2) {
      out.push(
        F(
          'loose-reltol',
          'warn',
          `solver for ${field} has relTol ${s.relTol}`,
          'A large relative tolerance stops the linear solve early. Steady sweeps tolerate it; transient runs do not, because the error accumulates in time.',
          'Use relTol 0 (absolute) or 0.01-0.05.',
        ),
      )
    }
  }
  // PIMPLE/pimple consistency: only transient runs need outer correctors; the
  // steady chtMultiRegionSimpleFoam tutorials use PIMPLE without them on purpose.
  if (d.PIMPLE && !d.PIMPLE.nOuterCorrectors) {
    const regionSchemes = readCaseDict(caseDir, CASE_FILES.schemes, region)
    const transient = !/steadyState/.test(String(regionSchemes?.ddtSchemes?.default ?? ''))
    if (transient) {
      out.push(F('pimple-no-outer', 'info', 'PIMPLE has no nOuterCorrectors', 'On a transient PIMPLE run the outer correctors are what re-solve pressure after the turbulence update; with one pass the run behaves like PISO with a large Courant limit and diverges instead of complaining.', 'Set nOuterCorrectors 2-3 for transient runs.'))
    }
  }
  return out
}

export function checkBlockMeshDict(caseDir, region = '') {
  const d = readCaseDict(caseDir, CASE_FILES.blockMesh, region)
  const out = []
  if (d === null) return out // many cases use snappy or an imported mesh only
  const scale = num(d.scale)
  if (Number.isFinite(scale) && scale !== 1) {
    out.push(
      F(
        'non-unit-scale',
        'info',
        `blockMeshDict scale is ${d.scale}`,
        'Every coordinate is multiplied by it, so a scale of 0.001 means your "metres" are millimetres. If you imported geometry in another unit and forgot, velocities and areas are wrong by the square of it.',
        'Keep scale 1 and convert geometry explicitly.',
      ),
    )
  }
  // Blocks share vertices, so "hexCount * 8 vs vertexCount" is not a valid check
  // (5 hex blocks legitimately list 24 shared vertices). Only the trivial
  // structural facts are worth reporting, as advice rather than an error.
  const vertices = String(d.vertices ?? '')
  const vertexCount = (vertices.match(/\(\s*[-+\d.eE]+\s+[-+\d.eE]+\s+[-+\d.eE]+\s*\)/g) || []).length
  if (vertexCount > 0 && vertexCount % 8 !== 0) {
    out.push(
      F(
        'vertex-count',
        'info',
        `blockMeshDict lists ${vertexCount} vertices, not a multiple of 8`,
        'Blocks share vertices, so this is usually fine; it only matters when a block references a label beyond the vertices list, which blockMesh reports with its own error.',
        'No action; trust blockMesh to report a truly missing vertex.',
      ),
    )
  }
  return out
}

/** Stray time directories left by a previous run inside the case. */
export function checkStrayTimes(caseDir) {
  const stray = strayTimeDirs(caseDir)
  if (stray.length === 0) return []
  // `startFrom latestTime` is a deliberate resume: those directories are the
  // restart point, not litter, so warning here is wrong.
  const startFrom = String(readCaseDict(caseDir, CASE_FILES.control)?.startFrom ?? '')
  if (/latestTime/.test(startFrom)) return []
  return [
    F(
      'stray-time-dirs',
      'warn',
      `case carries ${stray.length} time directories from an earlier run (${stray.slice(0, 6).join(', ')}${stray.length > 6 ? '…' : ''})`,
      'foamRun picks startFrom startTime/lt;startTime from controlDict, but a case littered with time dirs makes it easy to restart from the wrong one, and foamToVTK converts every directory it finds — turning a 30 s post-process into minutes.',
      'Keep the sweep results elsewhere (or archive them) and leave only 0/ and uniform/ in the working case.',
    ),
  ]
}

/** Boundary-condition sanity for the common fields. */
export function checkBoundaryFields(caseDir, region = '') {
  const out = []
  const zero = [join(caseDir, '0'), join(caseDir, '0.orig'), join(caseDir, '0_orig')]
    .map((dir) => (region ? join(dir, region) : dir))
    .find((p) => existsSync(p))
  if (!zero || !existsSync(zero)) return out
  for (const field of fieldFiles(caseDir, region)) {
    const text = safeRead(join(zero, field))
    if (text === null) continue
    const d = parseDict(text)
    const bf = d.boundaryField && typeof d.boundaryField === 'object' ? d.boundaryField : {}
    const patches = Object.keys(bf)
    if (patches.length === 0) {
      out.push(F('no-boundary-field', 'error', `0/${field} declares no boundaryField`, 'The solver cannot map the initial field onto the mesh.', 'Add a boundaryField block with one entry per patch.'))
      continue
    }
    const emptyPatches = []
    for (const patch of patches) {
      const entry = bf[patch]
      const type = entry && typeof entry === 'object' ? String(entry.type ?? '') : ''
      if (field === 'p' && /fixedValue/.test(type)) {
        // An outlet fixing pressure is the standard way to set the pressure
        // level in a duct; only a *wall* doing it is the mistake, because it
        // pins the reference where the flow cannot adjust.
        const wallish = /wall|solid|building|geometry/i.test(patch)
        if (wallish) {
          out.push(
            F(
              'p-fixed-value',
              'warn',
              `0/p sets wall patch ${patch} to fixedValue`,
              'Pressure level in an incompressible closed domain is floating; fixing it at a wall pins the reference and shifts every reported pressure by a constant.',
              'Use zeroGradient on walls and fix the level at the outlet only.',
            ),
          )
        }
      }
      if (type && !type.includes('::') && !KNOWN_BC_TYPES.has(type)) {
        out.push(
          F(
            'unknown-bc-type',
            'warn',
            `0/${field}: patch ${patch} uses an unknown type "${type}"`,
            'The solver builds the boundary field from this word; an unknown or mis-spelled type aborts the run with "Unknown patchField type" and prints the valid list. Compressible variants are prefixed, e.g. compressible::alphatWallFunction.',
            'Compare with the valid list the solver prints, or use openfoam_find_source to check the type name.',
          ),
        )
      }
      if (field === 'U' && /empty/.test(type)) emptyPatches.push(patch)
    }
    if (field === 'U' && emptyPatches.length) {
      out.push(F('u-empty-patch', 'info', `0/U has empty patch(es): ${emptyPatches.join(', ')}`, 'Empty patches mean the case is 2D (or quasi-1D) — not a defect, but blockMesh must create the same empty patches and the flow is not 3D.', 'No action if a 2D/quasi-1D setup is intended.'))
    }
    // internalField must exist
    if (d.internalField === undefined) {
      out.push(F('no-internal-field', 'error', `0/${field} has no internalField`, 'The field cannot be initialised.', 'Add internalField uniform <value>;.'))
    }
  }
  return out
}

/**
 * Rules that need the case's own physics settings to be judged. Each one is a
 * case OpenFOAM accepts and then fails on for a reason it never names.
 */
export function checkPhysics(caseDir, region = '') {
  const out = []
  const zero = [join(caseDir, '0'), join(caseDir, '0.orig'), join(caseDir, '0_orig')]
    .map((dir) => (region ? join(dir, region) : dir))
    .find((p) => existsSync(p))
  if (!zero || !existsSync(zero)) return out
  const fields = fieldFiles(caseDir, region)
  const turbulence =
    readCaseDict(caseDir, 'constant/momentumTransport', region) ?? readCaseDict(caseDir, 'constant/turbulenceProperties', region)
  const simulationType = String(turbulence?.simulationType ?? '')
  const isLaminar = /^laminar$/i.test(simulationType)

  // 1. A wall function on a laminar case: OpenFOAM reads the patch type, not the
  //    model, so it applies a wall function that has no eddy viscosity to work
  //    with and the run either divides by zero or silently behaves as zeroGradient.
  if (isLaminar) {
    const WALL_FUNCTION = /(kqRWallFunction|epsilonWallFunction|omegaWallFunction|nutkWallFunction|nutUSpaldingWallFunction|nutLowReWallFunction|nutkAtmRoughWallFunction|alphatWallFunction)/
    for (const field of fields) {
      const text = safeRead(join(zero, field))
      if (text === null) continue
      const bf = parseDict(text)?.boundaryField
      if (!bf || typeof bf !== 'object') continue
      for (const patch of Object.keys(bf)) {
        const type = String(bf[patch]?.type ?? '')
        if (WALL_FUNCTION.test(type)) {
          out.push(
            F(
              'wall-function-on-laminar',
              'error',
              `0/${field} uses ${type} on ${patch} but the case is laminar`,
              'A wall function needs a turbulence model to produce a wall value; with simulationType laminar OpenFOAM has no nut field, so the boundary is either rejected or quietly treated as zeroGradient.',
              'Either switch to a RAS/LES model or change that patch to zeroGradient.',
            ),
          )
        }
      }
    }
  }

  // 2. Buoyancy without gravity: p_rgh means the solver subtracts rho*g*h, so a
  //    missing or dimensionally wrong constant/g gives a run with no buoyancy and
  //    no warning.
  if (fields.includes('p_rgh')) {
    const g = readCaseDict(caseDir, 'constant/g', region)
    if (g === null) {
      out.push(
        F(
          'buoyant-without-g',
          'error',
          '0/p_rgh exists but constant/g is missing',
          'The buoyant solvers build the hydrostatic part from constant/g; without it there is no body force, so the case runs and produces a purely isothermal-looking field.',
          'Add constant/g with `value (0 -9.81 0);` and `dimensions [0 1 -2 0 0 0 0];`.',
        ),
      )
    } else {
      const dims = Array.isArray(g.dimensions) ? g.dimensions.map(String) : String(g.dimensions ?? '').replace(/[[\]]/g, '').trim().split(/\s+/)
      // OpenFOAM.com accepts named dimension sets (`dimensions [acceleration];`)
      const named = dims.length === 1 && /^[A-Za-z_]\w*$/.test(dims[0])
      const ok = named || dims.join(' ') === '0 1 -2 0 0 0 0'
      if (!ok) {
        out.push(
          F(
            'buoyant-g-dimensions',
            'error',
            `constant/g dimensions are [${dims.join(' ')}], expected [0 1 -2 0 0 0 0]`,
            'The buoyant solvers dimension-check g against rho*g*h; a wrong dimension list aborts the run at the first pressure correction, far from this file.',
            'Set `dimensions [0 1 -2 0 0 0 0];`.',
          ),
        )
      }
    }
  }

  // 3. Closed domain with no pressure reference: every p patch is zeroGradient,
  //    so the pressure level is undefined and the linear solver diverges on the
  //    first correction with a matrix that is singular but not obviously so.
  if (fields.includes('p') && !fields.includes('p_rgh')) {
    const text = safeRead(join(zero, 'p'))
    const bf = text === null ? null : parseDict(text)?.boundaryField
    const patches = bf && typeof bf === 'object' ? Object.keys(bf) : []
    // Any of these fixes the pressure level or propagates it from a known
// reference, so the domain is not closed:
const PRESSURE_BC = /fixedValue|totalPressure|waveTransmissive|fixedFluxPressure|prghPressure|advective|supersonicFreestream|pinnedValue/
const hasFixed = patches.some((patch) => PRESSURE_BC.test(String(bf[patch]?.type ?? '')))
    const solution = readCaseDict(caseDir, CASE_FILES.solution, region)
    const hasRef = solution?.pRefCell !== undefined || solution?.pRefPoint !== undefined || solution?.pRefValue !== undefined
    if (patches.length > 0 && !hasFixed && !hasRef) {
      out.push(
        F(
          'closed-domain-no-pref',
          'error',
          'pressure has no fixedValue patch and fvSolution sets no pRefCell',
          `Every patch in 0/p is ${[...new Set(patches.map((patch) => String(bf[patch]?.type ?? '?')))].join('/')}, so the pressure level floats. The p matrix is singular and the first solve either diverges or returns a field offset by an arbitrary constant.`,
          'Set pRefCell 0, pRefValue 0 in fvSolution (or give one outlet a fixedValue).',
        ),
      )
    }
  }

  return out
}

export function checkCase(caseDir, { regions = [] } = {}) {
  // Time controls and stray time directories are case-global; the rest is
  // per region when the case has regions (system/<r>/..., 0/<r>/..., constant/<r>/...).
  const out = [...checkControlDict(caseDir), ...checkStrayTimes(caseDir)]
  if (!regions.length) {
    out.push(...checkFvSchemes(caseDir), ...checkFvSolution(caseDir), ...checkBlockMeshDict(caseDir),
      ...checkBoundaryFields(caseDir), ...checkPhysics(caseDir))
    return out
  }
  for (const region of regions) {
    const tagged = [
      ...checkFvSchemes(caseDir, region),
      ...checkFvSolution(caseDir, region),
      ...checkBlockMeshDict(caseDir, region),
      ...checkBoundaryFields(caseDir, region),
      ...checkPhysics(caseDir, region),
    ].map((f) => ({ ...f, region }))
    out.push(...tagged)
  }
  return out
}

// =====================================================================
// log parsing
// =====================================================================

/**
 * checkMesh output -> the metrics that decide whether a mesh is usable.
 * OpenFOAM prints them as `Name: value` lines inside the report.
 */
/** First meaningful line of a FOAM error block (for results, not for logs). */
export function firstFatalLine(text) {
  const src = String(text || '')
  const fatal = /FOAM FATAL (?:IO )?ERROR:\s*([\s\S]{0,600}?)(?:\n\s*From function|\n\s*file:|$)/.exec(src)
  if (fatal) {
    const body = fatal[1].split('\n').map((l) => l.trim()).filter(Boolean)
    return (body[0] ? 'FOAM FATAL ERROR: ' + body[0] : 'FOAM FATAL ERROR').slice(0, 300)
  }
  const line = src.split('\n').map((l) => l.trim()).find((l) => /error|failed|not found/i.test(l))
  return line ? line.slice(0, 300) : ''
}

export function parseCheckMesh(text) {
  const out = {}
  const grab = (label, re) => {
    const m = re.exec(text)
    if (m) out[label] = m[1]
  }
  grab('cells', /^\s*cells:\s*(\d+)/m)
  grab('faces', /^\s*faces:\s*(\d+)/m)
  grab('points', /^\s*points:\s*(\d+)/m)
  grab('boundary patches', /^\s*boundary patches:\s*(\d+)/m)
  grab('max aspect ratio', /[Mm]ax aspect ratio\s*[:=]\s*([\d.eE+-]+)/)
  grab('max non-orthogonality', /Mesh non-orthogonality Max:\s*([\d.]+)/)
  // OpenFOAM prefixes out-of-range metrics with ***, e.g.
  //   ***Max skewness = 22.2796, 734 highly skew faces detected
  grab('max skewness', /\**\s*Max skewness\s*=\s*([\d.eE+-]+)/)
  grab('min volume', /Min volume\s*=\s*([\d.eE+-]+?)\.(?=\s)/)
  grab('max volume', /Max volume\s*=\s*([\d.eE+-]+?)\.(?=\s)/)
  const failedChecks = /Failed (\d+) mesh checks\./.exec(text)
  out.failedChecks = failedChecks ? Number(failedChecks[1]) : 0
  // The authoritative verdict is what checkMesh itself says, not our thresholds:
  // a snappy mesh with a few concave cells is a failed check, while a mesh with
  // 37.9 deg non-orthogonality is "Mesh OK." for OpenFOAM.
  out.meshOk = /^\s*Mesh OK\.\s*$/m.test(text)
  const failed = out.failedChecks > 0 || /^\s*Failed \d+ mesh checks\./m.test(text) || /FAILED/.test(text)
  out.failed = failed
  const bad = []
  if (out['max aspect ratio'] && Number(out['max aspect ratio']) > 1000) bad.push(`aspect ratio ${out['max aspect ratio']} (want < 1000)`)
  if (out['max non-orthogonality'] && Number(out['max non-orthogonality']) > 70) bad.push(`non-orthogonality ${out['max non-orthogonality']}° (want < 70°)`)
  if (out['max skewness'] && Number(out['max skewness']) > 4) bad.push(`skewness ${out['max skewness']} (want < 4)`)
  // The real reasons behind "Failed N mesh checks." are the threshold lines
  // (e.g. "faces with face pyramid volume < 2e-11 : 10001"); surface them so a
  // failure never comes back with an empty problems list.
  for (const m of text.matchAll(/^\s*([^\n:]{3,}?)\s*:\s*(\d+)\s*$/gm)) {
    const label = m[1].trim()
    const count = Number(m[2])
    if (count > 0 && /[<>]/.test(label)) bad.push(`${label}: ${count}`)
  }
  // the count of offending faces, when OpenFOAM reports one
  const skewCount = /(\d+)\s+highly skew faces/.exec(text)
  if (skewCount) out.skewFaces = skewCount[1]
  out.problems = [...new Set(bad)].slice(0, 8)
  return out
}

// polyMesh/boundary text -> [{name, type, nFaces, startFace}] (shared by the case tools)
export function parseBoundaryPatches(text) {
  const patches = []
  const re = /(\w+)\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(String(text)))) {
    const name = m[1]
    const block = m[2]
    const type = (block.match(/type\s+(\w+)\s*;/) || [])[1] || null
    if (!type) continue
    const nFaces = (block.match(/nFaces\s+(\d+)\s*;/) || [])[1] || null
    const startFace = (block.match(/startFace\s+(\d+)\s*;/) || [])[1] || null
    patches.push({ name, type, nFaces: nFaces ? Number(nFaces) : null, startFace: startFace ? Number(startFace) : null })
  }
  return patches
}

/** A run log -> the things worth telling a human about. */
export function parseRunLog(text) {
  const out = {
    errors: [], warnings: [], residualFloor: null, diverged: false, finished: false,
    iterations: null, times: [], execSeries: [], execSeconds: null, clockSeconds: null,
  }
  const lines = text.split(/\r?\n/)
  // foamMultiRun / parallel runs indent the time line and append a unit:
  // `      Time = 0.071s`, sometimes prefixed by `[0] `. The original
  // /^Time = .../ never matched those, so the residual floor was taken over the
  // whole log and a live run was judged RERUN.
  const TIME_RE = /^\s*(?:\[\d+\]\s*)?Time\s*=\s*([0-9.eE+-]+)s?\s*$/
  const timeIdx = []
  const timeVals = []
  const BANNER_RE = /Enabling floating point exception trapping|sigFpe\s*:\s*Enabling/
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const t = line.trim()
    const tm = TIME_RE.exec(line)
    if (tm) {
      timeIdx.push(i)
      const v = Number(tm[1])
      if (Number.isFinite(v)) timeVals.push(v)
    }
    // `--> FOAM FATAL IO ERROR` is the most common OpenFOAM failure (a missing
    // entry, a malformed dict) and it was excluded by the very guard that was
    // meant to skip the plain FATAL line.
    if (/^--> FOAM FATAL( IO)? ERROR/.test(t)) out.errors.push(t)
    else if (/^--> FOAM FATAL ERROR/.test(t)) out.errors.push(t)
    else if (/ERROR:/.test(line) && !/FOAM FATAL/.test(line)) out.errors.push(t)
    if (/Foam::error::printStack/.test(line)) out.errors.push('stack trace printed (see log head)')
    if (/^--> FOAM Warning/.test(t)) out.warnings.push(t)
    // "bounding box" is printed by every successful mesh run (Overall mesh /
    // domain / Refined mesh bounding box), so matching it called a clean snappy
    // run diverged. Real divergence shows up as the epsilon explosion.
    // The sigFpe banner is printed by every run at startup, not a signal.
    if (!BANNER_RE.test(line) && /bounding epsilon|negative.*determinant|face not found|sigFpe|Foam::sigFpe|bounding .*min: -?[1-9]e\+?\d{2,}/.test(line)) out.diverged = true
    const ex = /ExecutionTime\s*=\s*([0-9.eE+-]+)\s*s/.exec(line)
    if (ex) { out.execSeconds = Number(ex[1]); out.execSeries.push(Number(ex[1])) }
    const cl = /ClockTime\s*=\s*([0-9.eE+-]+)\s*s/.exec(line)
    if (cl) out.clockSeconds = Number(cl[1])
  }
  const final = /^\s*End\s*$/m.test(text)
  out.finished = final
  out.times = [...new Set(timeVals)]
  out.iterations = timeVals.length ? String(timeVals[timeVals.length - 1]) : null
  // residual floor: the WORST initial residual of the last COMPLETE time step,
  // not the last field printed (k often converges to 1e-09 while U is still at
  // 0.5) and not the whole log (which reports the startup transient).
  let start
  let end
  if (final && timeIdx.length) {
    start = timeIdx[timeIdx.length - 1]
    end = lines.length
  } else if (timeIdx.length >= 2) {
    start = timeIdx[timeIdx.length - 2]
    end = timeIdx[timeIdx.length - 1]
  } else {
    start = timeIdx.length ? timeIdx[0] : 0
    end = lines.length
  }
  const tail = lines.slice(start, end)
  const worst = tail
    .map((l) => /Initial residual = ([\d.eE+-]+)/.exec(l)?.[1])
    .filter(Boolean)
    // keep the printed token, not Number()'s decimal expansion: the report
    // should read like the log (5.92713e-05, not 0.0000592713)
    .map((tok) => ({ tok, n: Number(tok) }))
    .filter((p) => Number.isFinite(p.n))
  if (worst.length) out.residualFloor = worst.reduce((a, b) => (b.n > a.n ? b : a)).tok
  return out
}


