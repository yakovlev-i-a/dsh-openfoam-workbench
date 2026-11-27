// Flow check: does the case actually move fluid through its boundaries?
//
// A 2D case can run to "End" with clean residuals while nothing flows: an inlet
// velocity pointed along the empty axis carries zero flux, continuity is happy
// because nothing enters, and every scalar field still looks plausible. No
// residual or convergence check can see that — only the boundary flux can.
//
// The flux is `sum(phi)` per patch, read straight out of the written `phi` field
// files. No post-processing utility is run: on a reacting multi-region case
// `foamPostProcess` cannot even construct the physics (`reactionModel`,
// `objectRegistry region0`), and a read-only case cannot take a `postProcessing/`
// directory. A written field file has neither problem.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Velocity boundary conditions that intend to push fluid in, and to let it out.
const INLET_BC = /^(fixedValue|flowRateInletVelocity|surfaceNormalFixedValue|inletVelocity|velocityInlet|turbulentInlet|uniformInletOutlet|mappedFixedValue|cylindricalInletVelocity)$/i
const OUTLET_BC = /^(zeroGradient|inletOutlet|pressureInletOutletVelocity|flowRateOutletVelocity|advective|outletVelocity|waveTransmissive|mappedVelocityOutlet)$/i

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** The `boundaryField { ... }` body of a field file, braces balanced. */
export function boundaryFieldBody(text) {
  const s = String(text || '')
  const at = s.search(/\n\s*boundaryField\s*\n?\s*\{/)
  if (at < 0) return null
  const open = s.indexOf('{', at)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < s.length; i += 1) {
    const c = s[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return s.slice(open + 1, i)
    }
  }
  return null
}

/**
 * Per-patch boundary values of a surface field.
 *
 *     inlet
 *     {
 *         type            calculated;
 *         value           nonuniform List<scalar> 4(-8.75e-05 ...);
 *     }
 *
 * `value` can also be `uniform 0` (one value for every face) or a `List` whose
 * numbers start on the following line. Returns Map name -> {type, kind, numbers,
 * uniform} where `numbers` is only materialised for a nonuniform list.
 */
export function parsePhiBoundary(text) {
  const body = boundaryFieldBody(text)
  const out = new Map()
  if (body == null) return out
  const blockRe = /^ {4}(\w+)\n {4}\{([\s\S]*?)^ {4}\}/gm
  let m
  while ((m = blockRe.exec(body))) {
    const name = m[1]
    const inner = m[2]
    const type = (inner.match(/type\s+(\w+)\s*;/) || [])[1] || null
    const valueMatch = inner.match(/value\s+([\s\S]*?);/)
    const entry = { type, kind: 'none', numbers: null, uniform: null }
    if (valueMatch) {
      const value = valueMatch[1].trim()
      const uni = /^uniform\s+([-+\d.eE]+)$/.exec(value)
      if (uni) {
        entry.kind = 'uniform'
        entry.uniform = Number(uni[1])
      } else {
        const list = /^nonuniform\s+List<scalar>\s*(\d+)\s*\(([\s\S]*)\)$/.exec(value)
        if (list) {
          entry.kind = 'nonuniform'
          entry.numbers = (list[2].match(NUM) || []).map(Number)
        }
      }
    }
    out.set(name, entry)
  }
  return out
}

/** Sum of one patch's boundary values, given how many faces it has. */
export function patchSum(entry, nFaces) {
  if (!entry) return 0
  if (entry.kind === 'uniform') return (entry.uniform || 0) * (Number.isFinite(nFaces) ? nFaces : 1)
  if (entry.kind === 'nonuniform' && entry.numbers) return entry.numbers.reduce((a, b) => a + b, 0)
  return 0
}

/** Latest time directory that actually carries `phi` (serial or decomposed). */
export function latestFluxTime(caseDir, region = '', { processor = null } = {}) {
  const roots = processor == null ? [caseDir] : [join(caseDir, `processor${processor}`)]
  const numeric = (name) => name !== '' && Number.isFinite(Number(name)) && name.trim() !== ''
  const candidates = []
  for (const root of roots) {
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || !numeric(e.name)) continue
      const base = join(root, e.name)
      const phiPath = region ? join(base, region, 'phi') : join(base, 'phi')
      if (existsSync(phiPath)) candidates.push(Number(e.name))
    }
  }
  if (!candidates.length) return null
  return String(candidates.sort((a, b) => a - b)[candidates.length - 1])
}

/** Processor ids present in the case directory (empty when not decomposed). */
export function processorIds(caseDir) {
  let entries = []
  try {
    entries = readdirSync(caseDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && /^processor\d+$/.test(e.name))
    .map((e) => Number(e.name.slice('processor'.length)))
    .sort((a, b) => a - b)
}

// Smallest mesh we still compute patch areas for: faces + points are read whole.
const MAX_MESH_BYTES = 96 * 1024 * 1024

function ascii(text) {
  return text != null && text.indexOf('\u0000') < 0
}

/** `constant/[<region>/]polyMesh/points` and `faces`, as arrays. */
function readMeshGeometry(caseDir, region = '') {
  const base = region ? join(caseDir, 'constant', region, 'polyMesh') : join(caseDir, 'constant', 'polyMesh')
  const pointsPath = join(base, 'points')
  const facesPath = join(base, 'faces')
  let size = 0
  for (const p of [pointsPath, facesPath]) {
    try {
      size += statSync(p).size
    } catch {
      return null
    }
  }
  if (size > MAX_MESH_BYTES) return null
  const pointsText = readText(pointsPath)
  const facesText = readText(facesPath)
  if (!ascii(pointsText) || !ascii(facesText)) return null
  const points = []
  for (const line of pointsText.split('\n')) {
    const m = /^\s*\(([-\d.eE+\s]+)\)\s*$/.exec(line)
    if (!m) continue
    const [x, y, z] = (m[1].match(NUM) || []).map(Number)
    points.push([x, y, z])
  }
  const faces = []
  for (const line of facesText.split('\n')) {
    const m = /^\s*(\d+)\(([\d\s]+)\)\s*$/.exec(line)
    if (!m) continue
    faces.push((m[2].match(/\d+/g) || []).map(Number))
  }
  if (!points.length || !faces.length) return null
  return { points, faces }
}

/**
 * The axis an `empty` patch is normal to: the direction in which the mesh is one
 * cell thick. Read from the patch geometry itself rather than guessed from the
 * bounding box, because a thin 2D channel can be thinner in-plane than across,
 * and `frontAndBack` is one patch holding both sides of the plate.
 */
export function emptyAxisFromMesh(caseDir, patches, region = '', { maxFaces = 20000 } = {}) {
  const geom = readMeshGeometry(caseDir, region)
  if (!geom) return null
  const sums = [0, 0, 0]
  let faces = 0
  for (const p of patches) {
    if (p.type !== 'empty' || !Number.isFinite(p.startFace) || !Number.isFinite(p.nFaces)) continue
    for (let i = p.startFace; i < p.startFace + p.nFaces && faces < maxFaces; i += 1) {
      const face = geom.faces[i]
      if (!face) continue
      faces += 1
      let ax = 0
      let ay = 0
      let az = 0
      for (let k = 0; k < face.length; k += 1) {
        const q = geom.points[face[k]]
        const r = geom.points[face[(k + 1) % face.length]]
        if (!q || !r) continue
        ax += q[1] * r[2] - q[2] * r[1]
        ay += q[2] * r[0] - q[0] * r[2]
        az += q[0] * r[1] - q[1] * r[0]
      }
      sums[0] += Math.abs(ax)
      sums[1] += Math.abs(ay)
      sums[2] += Math.abs(az)
    }
  }
  if (!faces) return null
  const total = sums[0] + sums[1] + sums[2]
  if (!(total > 0)) return null
  const axis = sums.indexOf(Math.max(...sums))
  // The patch must really be normal to this axis, not merely tilted towards it.
  if (sums[axis] < 0.9 * total) return null
  return axis
}

/** Area of a polygonal face, from its vertices. */
export function polygonArea(points, face) {
  let ax = 0
  let ay = 0
  let az = 0
  for (let i = 0; i < face.length; i += 1) {
    const p = points[face[i]]
    const q = points[face[(i + 1) % face.length]]
    if (!p || !q) continue
    ax += p[1] * q[2] - p[2] * q[1]
    ay += p[2] * q[0] - p[0] * q[2]
    az += p[0] * q[1] - p[1] * q[0]
  }
  return 0.5 * Math.hypot(ax, ay, az)
}

/**
 * Patch areas of a region, or null when the mesh is not readable as text.
 * `patches` comes from `parseBoundaryPatches` and carries startFace/nFaces.
 */
export function patchAreas(caseDir, patches, region = '') {
  const geom = readMeshGeometry(caseDir, region)
  if (!geom) return null
  const areas = new Map()
  for (const p of patches) {
    if (!Number.isFinite(p.startFace) || !Number.isFinite(p.nFaces)) continue
    let area = 0
    for (let i = p.startFace; i < p.startFace + p.nFaces; i += 1) {
      const face = geom.faces[i]
      if (face) area += polygonArea(geom.points, face)
    }
    areas.set(p.name, area)
  }
  return areas
}

/**
 * Flux per patch at one time, summed over the processors when the case is
 * decomposed. Returns `{time, counts, fluxes, processors, error}` where `counts`
 * maps patch -> number of boundary faces (needed to expand a `uniform` value).
 */
export function readPatchFlux(caseDir, { time, region = '', patches = [], processors = [] } = {}) {
  const faces = new Map(patches.map((p) => [p.name, p.nFaces]))
  const roots = processors.length ? processors.map((i) => join(caseDir, `processor${i}`)) : [caseDir]
  const flux = new Map()
  let read = 0
  for (const root of roots) {
    const path = region ? join(root, time, region, 'phi') : join(root, time, 'phi')
    const text = readText(path)
    if (!ascii(text)) continue
    const parsed = parsePhiBoundary(text)
    if (!parsed.size) continue
    read += 1
    for (const [name, entry] of parsed) {
      if (/^procBoundary/.test(name) || entry.type === 'processor') continue
      const sum = patchSum(entry, faces.get(name))
      flux.set(name, (flux.get(name) || 0) + sum)
    }
  }
  if (!read) {
    return {
      time,
      counts: faces,
      fluxes: flux,
      processors: roots.length,
      error: `no readable ascii phi file at time ${time}${region ? ` in region ${region}` : ''}`,
    }
  }
  return { time, counts: faces, fluxes: flux, processors: roots.length, error: null }
}

/**
 * Which axis is one cell thick, when the case is 2D. `empty` patches say that a
 * case is 2D; the shortest extent says along which axis. The cut-off is loose on
 * purpose: this only explains a zero-flux finding, it never raises one.
 */
export function flatAxisOf(extents, hasEmpty) {
  if (!hasEmpty || !Array.isArray(extents) || extents.length !== 3) return null
  const sorted = [...extents].sort((a, b) => a - b)
  if (!(sorted[0] > 0) || !(sorted[1] > 0)) return null
  if (sorted[0] > 0.5 * sorted[1]) return null
  return extents.indexOf(sorted[0])
}

/** Signed flux `phi` on a patch: negative into the domain, positive out of it. */
export function fluxTolerance(values) {
  const scale = Math.max(...values.map((v) => Math.abs(v)), 0)
  if (!(scale > 0)) return 1e-12
  return Math.max(scale * 1e-6, 1e-12)
}

/**
 * Turn the per-patch flux into a verdict.
 *
 * `uBoundary` maps patch -> {type, value} from `0/<region>/U`; the velocity
 * condition says what the patch is *meant* to do, the flux says what it does,
 * and a patch that promises inflow but carries none is the failure mode this
 * tool exists for.
 */
export function analyseFlow({ patches, uBoundary = {}, meshTypes = {}, flatAxis = null, incompressible = true }) {
  const fluxValues = patches.map((p) => p.flux)
  const tol = fluxTolerance(fluxValues)
  const JUDGED_MESH_TYPES = new Set(['patch'])
  const rows = patches.map((p) => {
    const bc = uBoundary[p.patch] || null
    const bcType = bc && bc.type ? String(bc.type) : ''
    const meshType = meshTypes[p.patch] || null
    const judged = meshType === null ? true : JUDGED_MESH_TYPES.has(meshType)
    let role = 'other'
    if (judged) {
      if (INLET_BC.test(bcType)) role = 'inlet'
      else if (OUTLET_BC.test(bcType)) role = 'outlet'
      else if (p.flux < -tol) role = 'inlet'
      else if (p.flux > tol) role = 'outlet'
    }
    const area = Number.isFinite(p.area) && p.area > 0 ? p.area : null
    return {
      patch: p.patch,
      meshType,
      bcType: bcType || null,
      role,
      area,
      flux: p.flux,
      meanNormalVelocity: area ? p.flux / area : null,
    }
  })
  const candidates = rows.filter((r) => r.meshType === null || r.meshType === 'patch')
  const inlet = rows.filter((r) => r.role === 'inlet')
  const outlet = rows.filter((r) => r.role === 'outlet')
  const inletFlux = inlet.reduce((a, r) => a + Math.abs(r.flux), 0)
  const outletFlux = outlet.reduce((a, r) => a + Math.abs(r.flux), 0)
  const net = candidates.reduce((a, r) => a + r.flux, 0)
  const reference = Math.max(inletFlux, outletFlux)
  const imbalance = reference > 0 ? Math.abs(net) / reference : Math.abs(net)

  const findings = []
  if (!candidates.length) {
    findings.push({
      severity: 'info',
      rule: 'no-flow-boundaries',
      title: 'the case has no inlet/outlet patches',
      detail:
        'every boundary is a wall, empty, symmetry or cyclic patch, so there is no way in or out to check — a lid-driven cavity is like this and is not a problem',
      patches: rows.map((r) => r.patch),
      fix: 'nothing to do',
    })
    return { rows, totals: { inletFlux, outletFlux, net, imbalance, tolerance: tol }, findings }
  }
  for (const r of inlet) {
    if (Math.abs(r.flux) > tol) continue
    const u = uBoundary[r.patch] && Array.isArray(uBoundary[r.patch].value) ? uBoundary[r.patch].value : null
    const alongFlat =
      flatAxis != null && Array.isArray(u) && Math.abs(u[flatAxis]) > 0 &&
      u.every((c, k) => k === flatAxis || Math.abs(c) < 1e-12)
    findings.push({
      severity: 'error',
      rule: 'inlet-without-flux',
      title: `patch "${r.patch}" is an inlet (${r.bcType}) but carries no flux`,
      detail: alongFlat
        ? `the inlet velocity points along ${'xyz'[flatAxis]}, the axis where the mesh is one cell thick ("empty"): the flux through it is identically zero, so no fluid enters and continuity stays trivially satisfied`
        : 'sum(phi) on this patch is zero, so nothing enters the domain here even though the velocity boundary condition asks for inflow',
      patches: [r.patch],
      fix: alongFlat
        ? `turn the inlet velocity into the plane of the mesh, e.g. U = (0 ${Math.abs(Number(u[flatAxis]) || 0).toFixed(2)} 0), then rerun`
        : 'check the inlet value and the direction of the patch normal, then run openfoam_flow_check again',
    })
  }
  if (reference <= tol) {
    findings.push({
      severity: 'error',
      rule: 'no-flow-through-boundaries',
      title: 'inlet and outlet both carry no flux',
      detail: `every open patch carries less than ${tol.toExponential(1)}, so the case moves no fluid through its boundaries`,
      patches: candidates.map((r) => r.patch),
      fix: 'give the inlet a velocity and the outlet a pressure condition that lets fluid leave, then rerun',
    })
  }
  for (const r of outlet) {
    if (Math.abs(r.flux) > tol) continue
    findings.push({
      severity: 'warn',
      rule: 'outlet-without-flux',
      title: `patch "${r.patch}" is an outlet (${r.bcType}) but carries no flux`,
      detail: 'if an inlet does carry flux, this patch is not where the fluid leaves, so mass piles up somewhere else',
      patches: [r.patch],
      fix: 'confirm the outlet is the patch the flow actually reaches',
    })
  }
  // A reacting or compressible case stores mass in the domain, so only a large
  // mismatch is news; incompressible flow must balance to a fraction of a percent.
  const imbalanceLimit = incompressible ? 1e-3 : 5e-2
  if (reference > tol && imbalance > imbalanceLimit) {
    findings.push({
      severity: 'warn',
      rule: 'mass-imbalance',
      title: `inflow and outflow differ by ${(imbalance * 100).toFixed(3)} %`,
      detail: incompressible
        ? 'for incompressible flow the boundary fluxes must balance; a mismatch means a patch is misassigned or the case is not converged yet'
        : `compressible flow accumulates mass when density or the domain content changes, so the ${(imbalanceLimit * 100).toFixed(0)} % band is a tolerance, not a guarantee — this run is outside it`,
      patches: candidates.filter((r) => Math.abs(r.flux) > tol).map((r) => r.patch),
      fix: 'compare the per-patch fluxes and check the velocity and pressure boundary conditions',
    })
  }
  return {
    rows,
    totals: { inletFlux, outletFlux, net, imbalance, tolerance: tol },
    findings,
  }
}
