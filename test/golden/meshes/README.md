# Stored mesh fixtures

The golden cases start from these meshes instead of rebuilding them, so both
OpenFOAM families solve **exactly the same mesh** and a golden run is fast and
deterministic. The meshes are gzipped `polyMesh` files; OpenFOAM reads `.gz`
transparently.

| fixture | how it was made | cells |
|---|---|---|
| `sphereFlow/` | `blockMesh` 20x20x20 over the 100 mm cube + `snappyHexMesh` (sphere d=50 mm, level 1-2, `-overwrite`) | 17587 |
| `sphereCht/` | `blockMesh` 20x20x20 + sphere cell zone + `splitMeshRegions` (fluid region + solid region) | 7448 fluid / 552 solid |

`sphereCht/constant/<region>/polyMesh` are per-region meshes as `splitMeshRegions`
writes them; the interface patches are named `fluid_to_solid` / `solid_to_fluid`.
