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
2. `openfoam_dict_set(casePath, "fluid/fvSolution", "PIMPLE/maxDeltaT", "0.5", append: true)` —
   the local cap, typically 10–100× `deltaT`, *inside* the `PIMPLE { }` block (the
   path form exists exactly for this: a top-level `maxDeltaT` is never read). The
   block must exist even when it is nearly empty, and a missing one is fatal.
3. Keep `deltaT` small enough for the solid's thermal diffusion
   (`alpha·dt/dx² ≲ 0.5`) — the solid still takes that step.
4. Run, watch `Co` and the flow residuals with `openfoam_solve_verify`; with LTS
   the residuals drop fast and then plateau.
5. `openfoam_solve_verify` judges a transient case on completion, and its
   residual floor ignores species fields.

## The decoupling trap (a ratio between the two clocks)
The two clocks are independent, so a bad pair of numbers freezes the gas while the
run looks healthy:

    controlDict deltaT   0.1        <- clock; the solid advances by exactly this
    PIMPLE   maxDeltaT   1e-5       <- the gas advances at most this per clock step

The gas then advances 1e-5 s per iteration while the solid advances 0.1 s — a ratio
of 10⁴. The flame cannot move, the temperature field still looks plausible, the
residuals behave, there is no NaN and no warning. Keep `maxDeltaT` within a small
factor of `deltaT`: LTS is meant to let *slow* cells take longer steps, not to
replace the clock. Sanity check: 10 iterations must advance the gas by roughly
`10 · deltaT`, so if a reacting front has not moved after a few hundred iterations,
compare `maxDeltaT` with `deltaT` before blaming the kinetics.

## Step limiters (off by default)
`setRDeltaT` also sub-steps on temperature/mass-fraction change, and both limiters
are silent until you enable them:

- **temperature**: active only when `alphaTemp < 1` (`PIMPLE { alphaTemp 0.5; }`);
  the default `alphaTemp 1` switches it off, so raising `maxDeltaT` in a reacting
  channel is what produces negative mass fractions and a floating point exception
  inside the chemistry.
- **composition**: active when `alphaY` is present (`PIMPLE { alphaY 0.05; }`).

So "raise `maxDeltaT` and see" is a trap: raise it only together with `alphaTemp`,
or you exchange a slow-but-valid run for a crash you cannot read.

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
`openfoam_solve_verify`, `openfoam_run_watch`, `openfoam_field_stats` (native
reader, works on a decomposed or read-only case), `openfoam_flow_check` (the gas
must still move).
