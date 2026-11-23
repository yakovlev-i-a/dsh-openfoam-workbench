---
name: openfoam-mesh-independence
description: Mesh-independence study before production runs — per physics group, run a baseline and a refined mesh (10% near-wall, 5% away-from-wall), compare QoIs against a 5% threshold, escalate to Richardson/GCI if needed, then lock the selected mesh. Use before bulk runs or when convergence must be justified.
---

# openfoam-mesh-independence

## When to use
- before production/bulk runs ("is this mesh good enough?")
- a reviewer asks for a mesh-independence statement
- a QoI moves when the mesh is refined

## Group cases by physics
Cases sharing solver + turbulence model + custom library form one physics group → **one mesh study per group**, not per sweep value. A different y+ target (wall function vs low-Re) is a different group.

## STEP A — reference scales and QoIs
For each group:
1. Choose `L_ref` (chord, diameter, body height, hydraulic diameter, gap) and state why.
2. List 3–6 QoIs: Cf, Cp, pressure drop, lift/drag/moments, x_reattach/x_separation, y+_max, mass flow, heat flux/Nusselt.

## STEP B — build one refined mesh
- **Near-wall**: reduce wall-adjacent cell size ~10% (including first-layer thickness and layer-stack scaling); keep layer count and growth ratio ~same; keep y+ inside the target range.
- **Away-from-wall**: reduce core/wake cell size ~5%.
- Preserve topology, domain extent, blocking and meshing method.
- No prism layers? Define near-wall as cells within `d_w <= 0.05*L_ref` of a no-slip wall.

## STEP C — run both, identical settings
Same solver/models/BCs/reference values/schemes/relaxation/dt/convergence criteria; **only the mesh changes**.
- Steady: converged by BOTH residual reduction and stabilization of integral quantities.
- Unsteady: transients decayed; same averaging window and procedure.

## STEP D — monitor and compare
Report for both meshes: cell count, y+ statistics, checkMesh metrics (skewness, non-orthogonality, aspect ratio), and QoIs at probes/lines/planes (Cf, Cp, heat flux, lift/drag, pressure loss, mass flow).

## STEP E — quantify
`delta_pct = 100 * |QoI_refined - QoI_baseline| / |QoI_baseline|`
- all QoIs < 5% (wall-bounded < 10%), y+ in range, refined mesh quality OK → **select baseline**.
- one QoI slightly over → run a second refinement.
- strong or monotone divergence → 3 meshes + Richardson:
  ```
  r = (cells_fine / cells_coarse) ** (1 / N_dim)
  p = log((f_med - f_coarse) / (f_fine - f_med)) / log(r)
  f_exact = f_fine + (f_fine - f_med) / (r**p - 1)
  GCI_fine = 1.25 * |(f_fine - f_med) / f_fine| / (r**p - 1)
  ```
  Accept `GCI_fine < 5%` (validation) or `< 10%` (exploratory); safety factor 1.25 for 3 levels.
- still > 10% after two refinements → **stop and warn**: usually physics/numerics, not mesh.

## Tools
`openfoam_mesh_verify` (checkMesh + metrics), `openfoam_run` (blockMesh/snappy/solver), `openfoam_residual_series`, `openfoam_check`, `openfoam_patch_diff`, `openfoam_render`. QoI extraction: `bash` + `python3` (see `openfoam-stats`).

## Pitfalls
- Re-doing the study per sweep value (waste) — the gate runs once per group; sweep cases inherit the locked mesh.
- Refining a mesh before the physics/requirements are settled → the mesh is selected against the wrong physics.
- A single-level comparison never proves mesh-independence.
