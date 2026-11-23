---
name: openfoam-meshing
description: Go from STL geometry to an OpenFOAM mesh — inspect/render the STL, generate blockMeshDict + snappyHexMeshDict, compute the first-layer thickness from y+, run blockMesh/snappy and verify the mesh. Use for external/internal flow meshing and snappy cases.
---

# openfoam-meshing

## When to use
- "mesh this STL", "external flow", "airfoil/car/building", "snappyHexMesh"
- keys: STL, blockMesh, snappy, boundary layers, y+

## Recipe
1. `openfoam_stl_inspect(stl_path)` — triangles, bbox, watertightness, seeds.
2. `openfoam_stl_render(stl_path)` — check normals/watertightness visually.
3. `openfoam_compute_first_layer(U_ref, L_ref, y_plus_target)` — get the first-layer thickness.
4. `openfoam_mesh_plan(casePath, stl_path, domain=..., first_layer_thickness=...)` —
   `domain.type` is mandatory (external/internal/box).
5. `blockMesh` → `openfoam_mesh_verify(casePath)`.
6. `snappyHexMesh -overwrite` → `openfoam_mesh_verify(casePath)`.
7. `openfoam_patch_diff` — confirm inlet/outlet/walls were cut out.
8. `openfoam_mesh_stl_check` — Hausdorff fit to the original STL.

## Pitfalls
- Missing `domain.type` → the wrong computational domain.
- `nNonOrthogonalCorrectors 0` on a skewed mesh → false convergence.
- After 3 failed snappy attempts, downgrade: `strategy=coarsen` → `minimal` → `box_stl`.

## Verify
- `openfoam_mesh_verify` pass=true (checkMesh + visual)
- `openfoam_mesh_stl_check` pass=true
