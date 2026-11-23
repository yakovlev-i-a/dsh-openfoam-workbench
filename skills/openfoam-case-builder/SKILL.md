---
name: openfoam-case-builder
description: Set up and run an OpenFOAM case from a tutorial — find a matching case, inspect it, list every tunable item, edit one at a time, run blockMesh/checkMesh/solver and verify. Use when the user wants to run or adapt a case they have or want to find.
---

# openfoam-case-builder

## When to use
- "run this case", "set up a case", "find a tutorial for X"
- adapting an existing case (BCs, schemes, time step, solver choice)

## Step 0 — detect the distribution
`openfoam_version_info` / `openfoam_list_solvers` report `distribution`:
- **OpenFOAM.org (v10+, modular):** `solver <module>;` in `system/controlDict`,
  run with `foamRun` (e.g. `solver incompressibleFluid;`). There is no solver
  executable. Module names are in `applications/modules/`.
- **OpenFOAM.com (ESI):** `application <solver>;`, run the solver executable
  (e.g. `simpleFoam`).
`openfoam_inspect_case` and `openfoam_case_probe_facts` accept both keys — read
what the case actually has, do not assume `application` or `solver`.

## Step 1 — intent
Ask: "Do you already have a case (give me the path), or should I find a tutorial
by keywords?"

## Step 2 — case selection
- Has a case → go to step 3.
- Else `openfoam_find_tutorial(query)` → 8–12 candidates → numbered list →
  the user picks → `openfoam_clone_tutorial(tutorial_path, dest)`.

## Step 3 — inspect
`openfoam_inspect_case(casePath)` (it already includes the recursive file
listing — do not list directories one by one). Then:
  a. list every tunable item (BC / properties / mesh / solver / dt / write
     frequency) as `todo` items;
  b. for each item give one recommended default + 2–4 alternatives.

## Step 4 — one item at a time
Ask one item, wait, apply with `edit`, mark the todo done, move on. Never fire
5 questions at once.

## Step 5 — run + verify
Pre-flight `openfoam_check(casePath)` (silent failures) → `blockMesh` →
`checkMesh` → solver via `openfoam_run_solver_async` → `openfoam_residual_series`
→ `openfoam_render`. Do **not** poll immediately after starting; tell the user the
runId and let the monitor refresh.

## Run validity (before declaring success)
- **Pre-flight**: if a stale half-finished run is in the case dir, archive it (`<case>.stale_<ts>`) and start fresh; do not clobber without asking.
- **Allrun audit** (when the case ships an `Allrun`): confirm it actually runs a flow solver to completion — `foamRun` (solver module named in controlDict) counts, `runApplication`/`runParallel` count, a commented-out solver line is BROKEN. Fix only the solver invocation, keep pre-solver setup, provide a serial fallback.
- **Runtime triage** on failure/stall: classify `divergence` / `mesh` / `bc` / `allrun_bug` / `of_version` / `oom` / `code_mod_source_bug` / `other`, and decide whether the fix belongs in the harness (Allrun/runner) or the model (physics).
- **CFL-aware retry** (numerical failures only, max 3 tries): `adjustTimeStep yes;`, `maxCo 0.5–1.0` (start 0.7), bound `maxDeltaT` (~10× initial), keep `endTime`/physics unchanged. Do not jump dt aggressively or silently downgrade physics.
- **Honest status**: `success` only when the solver log ends with `End` AND no `FOAM FATAL ERROR` in any `log.*`. Never claim success over a FATAL log.

## Discipline
- Keep answers short, prefer numbered lists.
- Do not edit before the request is clear.
