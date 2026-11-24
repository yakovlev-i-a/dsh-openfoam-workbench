import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveCase } from './runtime.js'

export const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

export const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

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

export function computeFirstLayer({ U_ref, L_ref, nu = 1.5e-5, y_plus_target = 1, expansion_ratio = 1.2, coverage = 0.7 }) {
  const U = Number(U_ref)
  const L = Number(L_ref)
  if (!(U > 0) || !(L > 0)) return { ok: false, error: 'U_ref and L_ref must be positive' }
  const nuV = Number(nu) > 0 ? Number(nu) : 1.5e-5
  const yp = Number(y_plus_target) > 0 ? Number(y_plus_target) : 1
  const r = Number(expansion_ratio) > 1 ? Number(expansion_ratio) : 1.2
  const cov = Math.min(Math.max(Number(coverage) || 0.7, 0.1), 1)
  const Re = (U * L) / nuV
  const Cf = 0.026 * Math.pow(Re, -1 / 7)
  const uTau = U * Math.sqrt(Cf / 2)
  const firstLayer = (yp * nuV) / uTau
  const delta = 0.37 * L * Math.pow(Re, -0.2)
  const total = cov * delta
  const n = Math.max(1, Math.ceil(Math.log(1 + (total * (r - 1)) / firstLayer) / Math.log(r)))
  const totalThickness = (firstLayer * (Math.pow(r, n) - 1)) / (r - 1)
  return { ok: true, Re, Cf, uTau, delta, first_layer_thickness: firstLayer, n_layers: n, expansion_ratio: r, total_thickness: totalThickness }
}

export function parseStlTris(file) {
  const buf = readFileSync(file)
  let isBinary = false
  let count = 0
  if (buf.length >= 84) {
    const c = buf.readUInt32LE(80)
    if (c > 0 && buf.length === 84 + c * 50) { isBinary = true; count = c }
  }
  const tris = []
  if (isBinary) {
    for (let i = 0; i < count; i++) {
      const off = 84 + i * 50
      const t = []
      for (let k = 0; k < 3; k++) {
        const o = off + 12 + k * 12
        t.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)])
      }
      tris.push(t)
    }
  } else {
    const text = buf.toString('utf8')
    const vre = /vertex\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)/g
    let m
    const vs = []
    while ((m = vre.exec(text))) vs.push([+m[1], +m[2], +m[3]])
    for (let i = 0; i + 2 < vs.length; i += 3) tris.push([vs[i], vs[i + 1], vs[i + 2]])
  }
  return { isBinary, tris }
}

export function inspectStl(file) {
  const { isBinary, tris } = parseStlTris(file)
  if (!tris.length) return { ok: false, error: 'no triangles parsed (not an STL?)' }
  const mn = [Infinity, Infinity, Infinity]
  const mx = [-Infinity, -Infinity, -Infinity]
  let area = 0
  let vol = 0
  let nv = 0
  const ctr = [0, 0, 0]
  for (const t of tris) {
    for (const v of t) {
      for (let k = 0; k < 3; k++) {
        if (v[k] < mn[k]) mn[k] = v[k]
        if (v[k] > mx[k]) mx[k] = v[k]
        ctr[k] += v[k]
      }
      nv++
    }
    const cr = vcross(vsub(t[1], t[0]), vsub(t[2], t[0]))
    area += 0.5 * Math.hypot(cr[0], cr[1], cr[2])
    vol += (t[0][0] * (t[1][1] * t[2][2] - t[1][2] * t[2][1]) - t[0][1] * (t[1][0] * t[2][2] - t[1][2] * t[2][0]) + t[0][2] * (t[1][0] * t[2][1] - t[1][1] * t[2][0])) / 6
  }
  for (let k = 0; k < 3; k++) ctr[k] /= nv
  let watertight = null
  let openEdges = null
  if (tris.length <= 200000) {
    const edge = new Map()
    const key = (a, b) => {
      const k1 = a.map((x) => Math.round(x * 1e6)).join(',')
      const k2 = b.map((x) => Math.round(x * 1e6)).join(',')
      return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1
    }
    for (const t of tris) {
      for (let i = 0; i < 3; i++) {
        const k = key(t[i], t[(i + 1) % 3])
        edge.set(k, (edge.get(k) || 0) + 1)
      }
    }
    openEdges = 0
    for (const c of edge.values()) if (c !== 2) openEdges++
    watertight = openEdges === 0
  }
  return { ok: true, format: isBinary ? 'binary' : 'ascii', triangles: tris.length, bbox: { min: mn, max: mx }, centroid: ctr, volume: Math.abs(vol), area, watertight, open_edges: openEdges }
}

export const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export function closestPtTriangle(p, a, b, c) {
  const ab = vsub(b, a), ac = vsub(c, a), ap = vsub(p, a)
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = vsub(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]] }
  const cp = vsub(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]] }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])] }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom, w = vc * denom
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

// Symmetric max over sampled triangle centroids of the nearest-distance to the other mesh.

export function hausdorffApprox(fromTris, toTris, maxSamples = 2000) {
  if (!fromTris.length || !toTris.length) return null
  const step = Math.max(1, Math.ceil(fromTris.length / maxSamples))
  let worst = 0
  for (let i = 0; i < fromTris.length; i += step) {
    const t = fromTris[i]
    const p = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]
    let best = Infinity
    for (const u of toTris) {
      const q = closestPtTriangle(p, u[0], u[1], u[2])
      const dd = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
      if (dd < best) best = dd
    }
    if (best > worst) worst = best
  }
  return worst
}

export function stlBoxTriangles(mn, mx) {
  const [x0, y0, z0] = mn
  const [x1, y1, z1] = mx
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
  const quads = [
    [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]],
    [[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]],
    [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
    [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]],
  ]
  const tris = []
  for (const q of quads) {
    const n = vcross(vsub(q[1], q[0]), vsub(q[2], q[0]))
    const fc = q.reduce((a, v) => [a[0] + v[0] / 4, a[1] + v[1] / 4, a[2] + v[2] / 4], [0, 0, 0])
    const out = [fc[0] - c[0], fc[1] - c[1], fc[2] - c[2]]
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) q.reverse()
    tris.push([q[0], q[1], q[2]])
    tris.push([q[0], q[2], q[3]])
  }
  return tris
}

export function stlToAscii(name, tris) {
  const lines = ['solid ' + name]
  for (const t of tris) {
    const n = vcross(vsub(t[1], t[0]), vsub(t[2], t[0]))
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    lines.push(`  facet normal ${n[0] / len} ${n[1] / len} ${n[2] / len}`, '    outer loop')
    for (const v of t) lines.push(`      vertex ${v[0]} ${v[1]} ${v[2]}`)
    lines.push('    endloop', '  endfacet')
  }
  lines.push('endsolid ' + name)
  return lines.join('\n') + '\n'
}

// --- primitive STL generators ---

export function ring(r, z, sections) {
  return Array.from({ length: sections }, (_, j) => {
    const a = (j / sections) * 2 * Math.PI
    return [r * Math.cos(a), r * Math.sin(a), z]
  })
}

export function primBox(lx, ly, lz) {
  return stlBoxTriangles([-lx / 2, -ly / 2, -lz / 2], [lx / 2, ly / 2, lz / 2])
}

export function primSphere(r, segments = 32, rings = 16) {
  const tris = []
  const vert = (i, j) => {
    const th = (i / rings) * Math.PI
    const ph = (j / segments) * 2 * Math.PI
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)]
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = vert(i, j)
      const b = vert(i, j + 1)
      const c = vert(i + 1, j + 1)
      const d = vert(i + 1, j)
      tris.push([a, b, c], [a, c, d])
    }
  }
  return tris.filter((t) => area2(t) > 1e-18)
}

export const area2 = (t) => {
  const cr = vcross(vsub(t[1], t[0]), vsub(t[2], t[0]))
  return Math.hypot(cr[0], cr[1], cr[2])
}

export function primCylinder(r, h, sections = 32, rInner = 0) {
  const tris = []
  const z0 = -h / 2
  const z1 = h / 2
  const o0 = ring(r, z0, sections)
  const o1 = ring(r, z1, sections)
  for (let j = 0; j < sections; j++) {
    const j2 = (j + 1) % sections
    tris.push([o0[j], o1[j], o1[j2]], [o0[j], o1[j2], o0[j2]])
  }
  if (rInner > 0) {
    const i0 = ring(rInner, z0, sections)
    const i1 = ring(rInner, z1, sections)
    for (let j = 0; j < sections; j++) {
      const j2 = (j + 1) % sections
      tris.push([i0[j], i1[j2], i1[j]], [i0[j], i0[j2], i1[j2]])
      tris.push([o0[j], i0[j], i0[j2]], [o0[j], i0[j2], o0[j2]])
      tris.push([o1[j], o1[j2], i1[j2]], [o1[j], i1[j2], i1[j]])
    }
  } else {
    const c0 = [0, 0, z0]
    const c1 = [0, 0, z1]
    for (let j = 0; j < sections; j++) {
      const j2 = (j + 1) % sections
      tris.push([c0, o0[j2], o0[j]], [c1, o1[j], o1[j2]])
    }
  }
  return tris
}

export function primCone(r, h, sections = 32) {
  const tris = []
  const z0 = -h / 2
  const base = ring(r, z0, sections)
  const apex = [0, 0, h / 2]
  for (let j = 0; j < sections; j++) {
    const j2 = (j + 1) % sections
    tris.push([base[j], base[j2], apex], [[0, 0, z0], base[j2], base[j]])
  }
  return tris
}

export function makePrimitive(shape, p = {}) {
  const s = String(shape)
  if (s === 'box') return primBox(Number(p.lx), Number(p.ly), Number(p.lz))
  if (s === 'sphere') return primSphere(Number(p.r), Number(p.segments) || 32, Number(p.rings) || 16)
  if (s === 'cylinder') return primCylinder(Number(p.r), Number(p.h), Number(p.sections) || 32)
  if (s === 'pipe') return primCylinder(Number(p.r_outer), Number(p.h), Number(p.sections) || 32, Number(p.r_inner))
  if (s === 'cone') return primCone(Number(p.r), Number(p.h), Number(p.sections) || 32)
  throw new Error('unsupported shape: ' + s)
}

export function transformTris(tris, translate = [0, 0, 0], rotateDeg = [0, 0, 0], scale = 1) {
  const [rx, ry, rz] = rotateDeg.map((d) => (d * Math.PI) / 180)
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  const sc = Number(scale) || 1
  return tris.map((t) =>
    t.map((v) => {
      let [x, y, z] = v.map((c) => c * sc)
      const y1 = y * cx - z * sx
      const z1 = y * sx + z * cx
      const x1 = x * cy + z1 * sy
      const z2 = -x * sy + z1 * cy
      const x2 = x1 * cz - y1 * sz
      const y2 = x1 * sz + y1 * cz
      return [x2 + translate[0], y2 + translate[1], z2 + translate[2]]
    }),
  )
}

export function stlGenerate(spec = {}) {
  let tris = []
  if (Array.isArray(spec.parts) && spec.parts.length) {
    for (const part of spec.parts) {
      const pt = makePrimitive(part.shape, part.params || {})
      tris.push(...transformTris(pt, part.translate || [0, 0, 0], part.rotate_deg || [0, 0, 0]))
    }
  } else {
    tris = makePrimitive(spec.shape, spec.params || {})
  }
  tris = transformTris(tris, spec.translate || [0, 0, 0], spec.rotate_deg || [0, 0, 0], spec.scale || 1)
  return tris
}

// --- mesh plan dictionaries ---

export function fmt(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(8)))
}

export function planMesh(cfg, args) {
  const stlPath = resolveCase(cfg, args.stl_path)
  if (!stlPath || !existsSync(stlPath)) return { ok: false, error: 'stl not found: ' + stlPath }
  const info = inspectStl(stlPath)
  if (!info.ok) return info
  const mn = info.bbox.min
  const mx = info.bbox.max
  const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
  const L = Math.max(size[0], size[1], size[2]) || 1
  const cell = Number(args.target_cell_size) > 0 ? Number(args.target_cell_size) : L / 30
  const domain = args.domain || { type: 'wrap' }
  let dmn = [mn[0], mn[1], mn[2]]
  let dmx = [mx[0], mx[1], mx[2]]
  const type = domain.type || 'wrap'
  if (type === 'box') {
    if (!Array.isArray(domain.bbox_min) || !Array.isArray(domain.bbox_max)) return { ok: false, error: 'box domain needs bbox_min/bbox_max' }
    dmn = domain.bbox_min.map(Number)
    dmx = domain.bbox_max.map(Number)
  } else if (type === 'external') {
    const up = Number(domain.upstream) > 0 ? Number(domain.upstream) : 3
    const down = Number(domain.downstream) > 0 ? Number(domain.downstream) : 5
    const lat = Number(domain.lateral) > 0 ? Number(domain.lateral) : 3
    const vt = Number(domain.vertical_top) > 0 ? Number(domain.vertical_top) : 3
    const vb = Number(domain.vertical_bottom) > 0 ? Number(domain.vertical_bottom) : 3
    dmn = [mn[0] - up * L, mn[1] - lat * L, mn[2] - vb * L]
    dmx = [mx[0] + down * L, mx[1] + lat * L, mx[2] + vt * L]
  } else if (type === 'internal') {
    dmn = [mn[0], mn[1], mn[2]]
    dmx = [mx[0], mx[1], mx[2]]
  } else {
    const m = 0.1 * L
    dmn = [mn[0] - m, mn[1] - m, mn[2] - m]
    dmx = [mx[0] + m, mx[1] + m, mx[2] + m]
  }
  const nx = Math.max(1, Math.round((dmx[0] - dmn[0]) / cell))
  const ny = Math.max(1, Math.round((dmx[1] - dmn[1]) / cell))
  const nz = Math.max(1, Math.round((dmx[2] - dmn[2]) / cell))
  const v = [
    [dmn[0], dmn[1], dmn[2]], [dmx[0], dmn[1], dmn[2]], [dmx[0], dmx[1], dmn[2]], [dmn[0], dmx[1], dmn[2]],
    [dmn[0], dmn[1], dmx[2]], [dmx[0], dmn[1], dmx[2]], [dmx[0], dmx[1], dmx[2]], [dmn[0], dmx[1], dmx[2]],
  ]
  const name = basename(stlPath).replace(/\.stl$/i, '') || 'geometry'
  const header = (cls, obj) => `FoamFile\n{\n    format      ascii;\n    class       ${cls};\n    object      ${obj};\n}\n`
  const blockMesh = header('dictionary', 'blockMeshDict') + `\nscale 1;\n\nvertices\n(\n${v.map((p) => `    (${p.map(fmt).join(' ')})`).join('\n')}\n);\n\nblocks\n(\n    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1)\n);\n\nboundary\n(\n    inlet\n    {\n        type patch;\n        faces ((0 4 7 3));\n    }\n    outlet\n    {\n        type patch;\n        faces ((1 2 6 5));\n    }\n    walls\n    {\n        type wall;\n        faces ((0 1 5 4) (3 2 6 7) (0 1 2 3) (4 5 6 7));\n    }\n);\n`
  const loc = Array.isArray(args.location_in_mesh) && args.location_in_mesh.length === 3
    ? args.location_in_mesh.map(Number)
    : type === 'internal'
      ? [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2]
      : [dmn[0] + 0.05 * (dmx[0] - dmn[0]), (dmn[1] + dmx[1]) / 2, (dmn[2] + dmx[2]) / 2]
  const refMin = Number(args.refinement_level_min) || 1
  const refMax = Number(args.refinement_level_max) || 3
  const feat = Number(args.feature_level) || refMax
  const nLayers = Number(args.n_layers) || 0
  const firstLayer = Number(args.first_layer_thickness) || 0
  const expRatio = Number(args.expansion_ratio) || 1.2
  const snappy = header('dictionary', 'snappyHexMeshDict') + `\ncastellatedMesh true;\nsnap true;\naddLayers ${nLayers > 0 ? 'true' : 'false'};\n\ngeometry\n{\n    ${name}\n    {\n        type triSurfaceMesh;\n        file "${name}.stl";\n    }\n}\n\ncastellatedMeshControls\n{\n    maxLocalCells 1000000;\n    maxGlobalCells 8000000;\n    minRefinementCells 10;\n    nCellsBetweenLevels 5;\n    features\n    (\n        {\n            file "${name}.eMesh";\n            level ${feat};\n        }\n    )\n    refinementSurfaces\n    {\n        ${name}\n        {\n            level (${refMin} ${refMax});\n            patchInfo\n            {\n                type wall;\n            }\n        }\n    }\n    resolveFeatureAngle 30;\n    refinementRegions\n    {\n    }\n    locationInMesh (${loc.map(fmt).join(' ')});\n    allowFreeStandingZoneFaces true;\n}\n\nsnapControls\n{\n    nSmoothPatch 3;\n    tolerance 2.0;\n    nSolveIter 30;\n    nRelaxIter 5;\n}\n\naddLayersControls\n{\n    relativeSizes false;\n    layers\n    {\n        ${name}\n        {\n            nSurfaceLayers ${nLayers};\n        }\n    }\n    expansionRatio ${expRatio};\n    ${firstLayer > 0 ? `firstLayerThickness ${firstLayer};` : 'firstLayerThickness 0.001;'}\n    minThickness 1e-6;\n    nGrow 0;\n    featureAngle 30;\n}\n\nmeshQualityControls\n{\n    maxNonOrtho 65;\n    maxBoundarySkewness 20;\n    maxInternalSkewness 4;\n    maxConcave 80;\n    minVol 1e-13;\n    minTetQuality 1e-15;\n    minArea -1;\n    minTwist 0.02;\n    minDeterminant 0.001;\n    minFaceWeight 0.05;\n    minVolRatio 0.01;\n    minTriangleTwist -1;\n}\n\ndebug 0;\nmergeTolerance 1e-6;\n`
  const featureDict = header('dictionary', 'surfaceFeatureExtractDict') + `\nsurfaces\n(\n    "${name}.stl"\n    {\n        extractionMethod extractFromSurface;\n        includedAngle 150;\n    }\n);\n`
  return { ok: true, stl: stlPath, name, bbox: { min: mn, max: mx }, domain: { type, min: dmn, max: dmx }, cells: [nx, ny, nz], target_cell_size: cell, blockMeshDict: blockMesh, snappyHexMeshDict: snappy, surfaceFeatureExtractDict: featureDict }
}

// --- diagnostics + four-step + experience store ---
