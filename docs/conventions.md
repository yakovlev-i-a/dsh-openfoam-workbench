# Case conventions, multi-region cases, case libraries

How the tools treat a case on disk. All of it is enforced by the tools, not by
the prompt.

- **`<case-dir-name>.foam`** — `clone_tutorial`, `mesh_plan`, `run`,
  `run_solver_async` and `render` create the ParaView entry file named after the
  case directory; `case.foam` is never accepted or written. `inspect_case` reports
  `foamFile` and every other `.foam` in `foamFiles`, and `check` warns about a
  stray `case.foam` — the usual souvenir of a case copied from an older one, or of
  a render helper an older build wrote into the case directory.
- **Relative paths** — a relative `casePath` resolves against the first
  `caseRoots` entry (the session working directory is only the fallback when
  `caseRoots` is empty); absolute paths always work. Run records and logs live in
  `<case>/.openfoam-runs` unless `runsDir` pins a directory.
- **Geometry-scale gate** — `mesh_plan` and `check` compare the bounding box with
  `scaleAskAbove` (default `0.1` m). Above it the result carries a
  language-neutral `needs_input` payload (`{kind, ask, data, options: [{id,
  label}]}`) rendered as a QUESTION block; the agent asks with
  `ask_user_question` in the user's language (`CORE.md` `{{language}}`) and
  continues only after the answer. `scaleAskAbove: 0` disables it.

## Multi-region (CHT) cases

A multi-region case (`foamMultiRun`, `chtMultiRegionFoam`, `system/<region>/…`)
is understood end to end, not treated as a broken single-region case:

```text
inspect_case        -> regions, regionSolvers, per-region fields/patches
read_dict           -> "fluid/fvSchemes", "system/fluid/…", "0/fluid/T", or region="fluid"
mesh_verify         -> checkMesh -region <r> per region, verdict from checkMesh itself
run / run_async     -> mpirun -np N foamMultiRun (whitelisted launcher)
run_progress        -> t, steps, s/step, ETA from a multi-region/parallel log
solve_verify        -> RUNNING | STALLED | finished, no false divergence from the sigFpe banner
render              -> every mesh region (or region="fluid"), errors on an empty scene
```

`mesh_verify` takes its verdict from what checkMesh prints (`Mesh OK.` /
`Failed N mesh checks.`) and reports the stricter workbench thresholds (aspect
ratio, non-orthogonality, skewness) as warnings. The doctor is region-aware too:
it reads `system/<r>/fvSchemes|fvSolution`, `0/<r>/*` and `constant/<r>/*`, tags
every finding with its region, and accepts `region="<name>"`. `checkMesh
-allRegions` does not exist in OpenFOAM.org — the per-region call is the only
honest one.

## Case libraries (custom `.so`)

A case can ship its own compiled library — a custom `fvMeshTopoChanger`, an
`fvOption`, a boundary condition — and list it in `system/controlDict`:

```text
libs ("libamrTopoChanger.so");
```

OpenFOAM loads those with `dlopen()`, so the file must be on the loader path of
the process that creates the mesh. That path derives from `FOAM_USER_LIBBIN`,
which depends on `$USER`: a case built with a stripped environment (`env -i …`)
installs into `~/OpenFOAM/-<version>/platforms/…`, while the same command from a
normal shell looks in `~/OpenFOAM/<user>-<version>/platforms/…`. The solver then
stops with `dlopen error` or `Unknown fvMeshTopoChanger type`, naming neither the
library nor the directory.

Three tools close that gap:

- **`libPaths`** (`run`, `run_solver_async`, `field_stats`, `solver_build`) —
  directories prepended to `LD_LIBRARY_PATH`, e.g.
  `libPaths: ["/home/me/OpenFOAM/-14/platforms/linux64GccDPInt32Opt/lib"]`.
- **`env`** — the same explicitly: `{LD_LIBRARY_PATH: "…:…"}`. Only library
  locations are accepted; `LD_PRELOAD`, `LD_AUDIT` and `PATH` are refused, because
  they would let a call choose the code that runs.
- **`solver_build(libbin=…)`** — install a library where the run can reach it
  (overrides `FOAM_USER_LIBBIN` for `wmake`). Without it the build reports the
  resolved target and refuses up front when that directory is not writable.

`check` resolves every `libs (…)` entry against `FOAM_LIBBIN`, `FOAM_USER_LIBBIN`
and the `~/OpenFOAM/*/platforms/*/lib` trees; `case-library-missing` names the
directory that does hold the library plus the exact `libPaths` call.
`diagnose_error` recognises the `dlopen` / `Unknown fvMeshTopoChanger type`
messages and points at the same fix. Background runs keep the extra environment in
their registry entry, so `run_list` / `solver_status` / `run_progress` still track
them.
