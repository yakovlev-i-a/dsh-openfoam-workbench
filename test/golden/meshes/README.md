# Stored mesh fixtures

The golden cases start from these meshes instead of rebuilding them, so both
OpenFOAM families solve **exactly the same mesh** and a golden run is fast and
deterministic. The meshes are gzipped `polyMesh` files; OpenFOAM reads `.gz`
transparently.

| fixture | how it was made | cells |
|---|---|---|
| `sphereFlow/` | `blockMesh` 20x20x20 over the 100 mm cube + `snappyHexMesh` (sphere d=50 mm, level 1-2, `-overwrite`) | 17587 |
| `sphereCht/` | `blockMesh` + `createZones` sphere cell zone + `splitMeshRegions -cellZones all -defaultRegion fluid` in org 14 | 7448 fluid / 552 solid |

`sphereCht/constant/<region>/polyMesh` are per-region meshes as
`splitMeshRegions` writes them in org 14; the interface patches are
`fluid_to_solid` / `solid_to_fluid`. **The interface patch metadata is not
portable**: com writes `mappedWall` with `sampleMode nearestPatchFace`, which
org 14 rejects (`Unknown patchToPatch type nearestPatchFace`), so a com run needs
its own fixture built by com.
