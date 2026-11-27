---
name: openfoam-lts-ch
description: Run a conjugate-heat-transfer case with local time stepping (LTS) in the gas and a normal transient or steady solve in the solid — per-region ddtSchemes, where maxCo/maxDeltaT actually live, the traps that stop LTS from paying off. Use when a CHT case must reach a long physical time and only the fluid region uses localEuler.
---

# openfoam-lts-ch

## When to use
- the gas region is slow because the acoustic/Courant step is tiny, but the solid
  only needs a coarse step: LTS in the fluid, `Euler`/`steadyState` in the solid;
- a CHT case must reach seconds of physical time (flame stabilisation, thermal
  soak) where a uniform `deltaT` would take weeks;
- the case already has `ddtSchemes { default localEuler; }` in one region only.

## The three clocks
LTS does not add a time axis — it changes how one global step is taken:

- **`controlDict deltaT`** is the step for the whole case: the solid advances by
  exactly this `deltaT` at every iteration, and `writeInterval`/`endTime` are in
  this clock.
- **`maxCo` / `maxDeltaT` / `minDeltaT`** of the *fluid* region cap the local
  step LTS may take inside one `deltaT`. They are looked up in the region's
  `fvSolution` **`PIMPLE` sub-dictionary** (`singleRegionSolutionControl::dict()`
  returns `mesh.solution().subDict("PIMPLE")`), not at the top level and not in
  `controlDict`. `maxDeltaT` is pointless when it exceeds `deltaT`.
- **CFL** is reported for the fluid only. With LTS the printed `Co` is the
  maximum *local* Courant number; if it stays above 1 the local steps are capped
  by stability rather than by `maxDeltaT`, and LTS stops paying for itself.

## Recipe
1. `openfoam_read_dict(casePath, "fluid/fvSchemes")` → `ddtSchemes { default localEuler; }`,
   and make sure the solid region keeps `Euler` (or `steadyState`).
2. `openfoam_dict_set(casePath, "fluid/fvSolution", "maxDeltaT", "0.5")` — the
   local cap, typically 10–100× `deltaT`; it must be inside the `PIMPLE { }`
   block, which must therefore exist even when it is nearly empty.
3. Keep `deltaT` small enough for the solid's thermal diffusion
   (`alpha·dt/dx² ≲ 0.5`) — the solid still takes that step.
4. Run, watch `Co` and the flow residuals with `openfoam_run_progress`; with LTS
   the residuals drop fast and then plateau.
5. `openfoam_solve_verify` judges a transient case on completion, and its
   residual floor ignores species fields.

## How to tell it is working (verified on org-14, `foamRun -solver incompressibleFluid`)
The log says it outright:

- `Using LTS` right after the thermophysical setup — set from `localEuler` in
  `ddtSchemes`. No such line, no LTS.
- `Flow time scale min/max = <tmin>, <tmax>` at every step, followed by
  `Smoothed flow time scale min/max = …`. `<tmax>` equals your `maxDeltaT`
  whenever the cap binds; the smoothed pair is what is actually taken, cell by
  cell.
- Check that the local steps are far below `maxDeltaT` in the interesting region:
  if they are not, `maxCo` is doing the clipping and raising `maxDeltaT` buys
  nothing.

## Pitfalls
- **`localEuler` in a solid region is fatal**: `solid solver does not support LTS,
  use 'steadyState' ddtScheme` (`applications/modules/solid/solid.C:91`). LTS is a
  fluid-only scheme in org-14.
- **A missing `PIMPLE` block** in the region's `fvSolution` is fatal:
  `keyword PIMPLE is undefined in dictionary "<case>/system/fvSolution"` — the
  algorithm control, and through it the LTS step lookup, uses
  `mesh.solution().subDict("PIMPLE")`.
- **`adjustTimeStep on`** adjusts only the *global* step from the global Courant
  number; it does not set the local steps. If the global step is being cut to
  satisfy a criterion meant for LTS, pin `deltaT` instead.
- **Restarting an LTS run** needs `startFrom latestTime`; `mapFields` to a new
  `deltaT` breaks the local step history.
- **A flat residual is not a converged case**: check that the QoI (outlet
  temperature, wall heat flux) stopped moving between two written times.
- **`writeInterval` is global time**, so an LTS run writes far less often in
  wall-clock terms. Use `openfoam_field_stats` (it reads the field files, no
  utility needed) to confirm the field actually moved.

## Tools
`openfoam_read_dict` / `openfoam_dict_set` (per-region `ddtSchemes`,
`PIMPLE { maxCo; maxDeltaT }`), `openfoam_run_solver_async` +
`openfoam_run_progress`, `openfoam_solve_verify`, `openfoam_field_stats` (native
reader, works on a decomposed or read-only case), `openfoam_flow_check` (the gas
must still move).
