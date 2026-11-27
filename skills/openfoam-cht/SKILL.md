---
name: openfoam-cht
description: Set up, run and verify a multi-region conjugate-heat-transfer case (foamMultiRun / chtMultiRegionFoam) — regions, per-region dictionaries and checkMesh, MPI run, progress/ETA and per-region renders. Use when the case has regionSolvers in system/controlDict or constant/<region>/polyMesh.
---

# openfoam-cht

## When to use
- `system/controlDict` has `regionSolvers { fluid ...; solid ...; }`
- the mesh lives in `constant/<region>/polyMesh`, not `constant/polyMesh`
- CHT tasks: conjugate heat transfer, cooled walls, combustion gas + solid, electronics cooling

## Step 0 — which flavour is this case?
- **OpenFOAM.org (14+)**: `regionSolvers { fluid fluid; solid solid; }` in
  `system/controlDict`; mesh regions are exactly those names; run `foamMultiRun`.
- **OpenFOAM.com (v25xx/v26xx)**: `constant/regionProperties` groups MESH regions:
  `regions ( fluid (bottomAir topAir) solid (heater leftSolid) );` — the
  parenthesised names are the mesh regions (`constant/<r>/polyMesh`, `0/<r>`),
  `fluid`/`solid` are only solver groups. One application runs everything
  (`chtMultiRegionSimpleFoam`, `chtMultiRegionFoam`), and initial fields usually
  live in `0.orig/` until `restore0Dir` copies them to `0/`.
- `openfoam_inspect_case` reports `regionGroups` for the com layout, and
  `openfoam_read_dict("0/<region>/<field>")` falls back to `0.orig/`.
- `openfoam_run("restore0Dir")` (or `restore0Dir -processor`) does the copy the
  plugin-side way; it is a shell helper in OpenFOAM, not an executable.

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

## Step 3b — one mesh, several regions (building the case)
A CHT case usually starts as a single mesh with cell zones. Splitting it is the
step where org and com diverge, and where the org-14 CLI bites:

- **org-14**: `openfoam_run(casePath, "createZones")` then
  `openfoam_run(casePath, "splitMeshRegions -cellZones all")`.
  `-cellZones '(fluid solid)'` fails with `Wrong number of arguments` — the
  positional argument is a *word list*, so quote it as one word
  (`-cellZones 'fluid solid'` now reaches OpenFOAM correctly) or use `all`.
  `-overwrite` is deprecated in org-14 (`now default behaviour`) and is parsed as
  a stray positional token (`wrong token type … punctuation token '-'`) — drop it.
- **com**: `splitMeshRegions -cellZones -overwrite` (no zone list), and the
  original mesh lands in `constant/domain0/`.
- After the split every region needs its own `0/<region>/`, `system/<region>/`
  and the interface patches the splitter created (`<region>_to_<other>`); a
  `coupled`/`mappedWall` boundary field on a wall patch is an error the doctor
  reports as `coupled-bc-on-wall`.
- Verify with `openfoam_patch_diff` (interface patches present, types as
  expected) and `openfoam_mesh_verify` before touching the physics.

## Step 3c — post-processing per region (org-14)
- `foamToVTK` has **no** `-allRegions`: one call per region,
  `openfoam_run("foamToVTK -region <r>")`, or loop over the regions.
- `surfaceFieldValue` and friends read the region from a `region <name>;` entry —
  not `regionType patch; patchName …`, and not `region0`, which does not exist in
  an org-14 multi-region case.
- `openfoam_field_stats` and `openfoam_flow_check` need no utility at all: they
  read the written field files, so they work on a read-only case, on a decomposed
  case and on reactor cases whose physics `foamPostProcess` cannot construct.
- `openfoam_flow_check` per region: a solid has no `phi`, so it is reported as
  skipped — that is expected, not a failure.

## Step 4 — decompose, then run under MPI
- `openfoam_run(casePath, "decomposePar -allRegions -force")` — without `-allRegions` only
  the first region is decomposed.
- `openfoam_run_solver_async(casePath, "mpirun -np 5 foamMultiRun")`. The synchronous
  `openfoam_run` refuses `mpirun` on purpose: a production run must not be killed by a
  tool timeout.
- `openfoam_run_progress(log_path)` → t, steps, s/step, ETA, state;
  `openfoam_solver_status(run_id)` → process state plus `logVerdict`; `openfoam_solver_stop(run_id)` to stop.
- **A CHT run is long by definition: watch it.** There is no completion notification for an
  async run, so `openfoam_run_watch(run_id, timeout_s)` for one blocking window, and when the
  turn must end, start a watchdog as a real background job (`bash <case>/tools/watch_run.sh
  <log>`). A `foamMultiRun` log ends `End`, a blank line, `Finalising parallel run` — check
  the last few lines, not just the last one, and treat `mpirun noticed … exited on signal 8`
  as a crash (a rank dying with an FPE prints no `FOAM FATAL`).

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
- **`splitMeshRegions -overwrite` on org-14** is deprecated and parsed as a zone
  list: drop the flag or the run dies with `wrong token type … '-'`.
- **`foamToVTK -fields '(T p)'`** works (quotes are honoured since v0.9.36), but
  `-allRegions` does not exist in org-14.
- **Timings are load-dependent**: s/step on a busy desktop can be 4–5× the idle value;
  never quote a throughput without saying when it was measured.
- **`writeInterval` on a live run**: lowering it (via `openfoam_dict_set`, `runTimeModifiable on`)
  writes a snapshot without a restart, then restore it.

## Exit criteria
- `openfoam_mesh_verify`: PASS in every region;
- `openfoam_solve_verify`: RUNNING with ETA, or finished with decision `PROCEED`;
- `openfoam_render` + `read_image`: both regions visible, the field is the one you claim.
