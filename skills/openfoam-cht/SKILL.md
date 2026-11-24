---
name: openfoam-cht
description: Set up, run and verify a multi-region conjugate-heat-transfer case (foamMultiRun / chtMultiRegionFoam) — regions, per-region dictionaries and checkMesh, MPI run, progress/ETA and per-region renders. Use when the case has regionSolvers in system/controlDict or constant/<region>/polyMesh.
---

# openfoam-cht

## When to use
- `system/controlDict` has `regionSolvers { fluid ...; solid ...; }`
- the mesh lives in `constant/<region>/polyMesh`, not `constant/polyMesh`
- CHT tasks: conjugate heat transfer, cooled walls, combustion gas + solid, electronics cooling

## Step 1 — read the case as regions, not as one mesh
`openfoam_inspect_case` → `regions`, `regionSolvers`, per-region `fields`/`patches`;
`openfoam_case_probe_facts` → `region_governing` (e.g. fluid compressible multicomponent,
solid solid mechanics) and `compressible`.

A single `patches: []` or `fields: ["fluid","solid"]` means the tool looked at the case
root: never conclude that the case is broken, switch to the region view.

## Step 2 — dictionaries per region
- `openfoam_read_dict(casePath, file="fluid/fvSchemes")` or `region="fluid"`;
  `system/fluid/...`, `constant/fluid/...`, `0/fluid/T` are accepted as written.
- Global `system/controlDict`: region list, time controls, `libs`.
- Region files: `system/<r>/fvSchemes`, `system/<r>/fvSolution`, `constant/<r>/*`.
- Change a control on a live case with `openfoam_dict_set` (atomic, keeps a `.bak`);
  e.g. `file="fluid/fvSchemes", entry="ddtSchemes", value="..."` — check the top-level
  shape first, the tool reports the entries it found.

## Step 3 — mesh per region
- `openfoam_mesh_verify` runs `checkMesh -region <r>` for **every** region and takes the
  verdict from checkMesh itself (`Mesh OK.` / `Failed N mesh checks.`).
- `checkMesh -allRegions` does not exist in OpenFOAM.org — one call per region is the only
  honest one; `openfoam_mesh_verify(casePath, region="solid")` narrows it.
- A failing region: read `logTail`, do not re-run the whole case.

## Step 4 — decompose, then run under MPI
- `openfoam_run(casePath, "decomposePar -allRegions -force")` — without `-allRegions` only
  the first region is decomposed.
- `openfoam_run_solver_async(casePath, "mpirun -np 5 foamMultiRun")`. The synchronous
  `openfoam_run` refuses `mpirun` on purpose: a production run must not be killed by a
  tool timeout.
- `openfoam_run_progress(log_path)` → t, steps, s/step, ETA, state;
  `openfoam_solver_status(run_id)` → process state; `openfoam_solver_stop(run_id)` to stop.

## Step 5 — verify before reporting
- `openfoam_solve_verify(log_path)` → `RUNNING` is a state, not a failure; `RERUN` only on
  real divergence/errors; the residual floor comes from the last complete time step.
- `openfoam_render(case_path, field="T")` renders every region; `region="solid"` narrows it;
  an unknown field returns the available list. Confirm with `read_image` that the frame is
  the physics you expect (uniform colour at t≈0 is data, not a bug).
- Long runs: report `t / endTime`, s/step and ETA instead of "still running".

## Pitfalls
- **One `.foam` file at the case root** opens all regions in ParaView; a second one is noise.
- **`localEuler` in a solid region** fails: `solid solver does not support LTS, use
  'steadyState' ddtScheme`. Keep `Euler`/`steadyState` per region.
- **Interface patches**: `mappedWall` needs matching `patchToPatch`; org-14 wants
  `sampleMode nearest`, not the com name `nearestPatchFace`.
- **`symmetry` vs `symmetryPlane`**: org-14 expects `symmetryPlane` for flat faces.
- **Timings are load-dependent**: s/step on a busy desktop can be 4–5× the idle value;
  never quote a throughput without saying when it was measured.
- **`writeInterval` on a live run**: lowering it (via `openfoam_dict_set`, `runTimeModifiable on`)
  writes a snapshot without a restart, then restore it.

## Exit criteria
- `openfoam_mesh_verify`: PASS in every region;
- `openfoam_solve_verify`: RUNNING with ETA, or finished with decision `PROCEED`;
- `openfoam_render` + `read_image`: both regions visible, the field is the one you claim.
