// Cell zones: the step between one mesh and a multi-region case.
//
// org 14 ships `createZones` (reads system/createZonesDict, makes the cellZone
// directly); com v2606 does not, and the native path is `topoSet` (a cellSet from
// a shape source) followed by `setsToZones`. One recipe, two mechanisms — the
// capability says which one exists.
import { existsSync } from 'node:fs'

const BANNER = (object) => `FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      ${object};
}

`

const SHAPES = {
  sphere: (p) => ['sphere', `centre (${(p.centre || [0, 0, 0]).join(' ')});\n        radius ${Number(p.radius)};`],
  box: (p) => ['box', `min (${(p.min || [0, 0, 0]).join(' ')});\n        max (${(p.max || [0, 0, 0]).join(' ')});`],
  cylinder: (p) => ['cylinder', `point1 (${(p.point1 || [0, 0, 0]).join(' ')});\n        point2 (${(p.point2 || [0, 0, 1]).join(' ')});\n        radius ${Number(p.radius)};`],
}

/** Which mechanism this installation offers, and whether the tool can run it. */
export function zoneTool(caps) {
  return caps && caps.zoneTool ? caps.zoneTool : (caps && caps.modular ? 'createZones' : 'topoSet')
}

/**
 * Dictionaries and commands that create one cell zone.
 * Returns { dictRel, dictText, commands: [[argv...], ...] } or { error }.
 */
export function zonePlan({ caps, name, shape = 'sphere', params = {} }) {
  const make = SHAPES[shape]
  if (!make) return { error: `unsupported zone shape: ${shape} (use sphere, box or cylinder)` }
  const label = String(name || 'zone')
  const [kind, body] = make(params)
  const tool = zoneTool(caps)

  if (tool === 'createZones') {
    const dictText = BANNER('createZonesDict') + `${label}\n{\n    type        ${kind};\n    zoneType    cell;\n\n    ${body}\n}\n`
    return { tool, dictRel: 'system/createZonesDict', dictText, commands: [['createZones']], zone: label }
  }

  // com: a cellSet from a shape source, then promote it to a cellZone.
  const sourceName = `${kind}ToCell`
  const dictText = BANNER('topoSetDict') + `
actions
(
    {
        name        ${label};
        type        cellSet;
        action      new;
        source      ${sourceName};
        sourceInfo
        {
            ${body}
        }
    }
);
`
  // com reads the case schemes when splitting, so a bare mesh needs placeholders.
  const prereq = {
    'system/fvSchemes': BANNER('fvSchemes') + `
ddtSchemes { default Euler; }
gradSchemes { default Gauss linear; }
divSchemes { default none; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
`,
    'system/fvSolution': BANNER('fvSolution') + `
solvers { }
PIMPLE { nCorrectors 2; nNonOrthogonalCorrectors 1; }
`,
  }
  return {
    tool: 'topoSet',
    dictRel: 'system/topoSetDict',
    dictText,
    commands: [['topoSet'], ['setsToZones', '-noFlipMap']],
    zone: label,
    prereq,
    note: 'com path: topoSet builds the cellSet, setsToZones promotes it to a cellZone with the same name',
  }
}

/** True when the case already has that cell zone in the mesh. */
export function hasCellZone(caseDir, name) {
  return existsSync(`${caseDir}/constant/polyMesh/cellZones`) || existsSync(`${caseDir}/constant/polyMesh/cellZones.gz`)
}
