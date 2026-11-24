# OpenFOAM Workbench (dsh-openfoam-workbench)

> **⚠ Prototype.** Experimental code — APIs and behavior may change. Use at your own risk.

Native **DeepSeek Harness** plugin for OpenFOAM: case inspection, solver
development, meshing, durable background runs, off-screen renders, paper
reproduction and an experience library — plus 10 on-demand CFD skills.

## Status

Implemented and validated on **OpenFOAM 14** (org, modular solvers) and
**ParaView 6.2.0**:

**v0.4.0 · 61 tools · 11 skills · 69 tests**

## Install

```bash
dsh plugin install /path/to/dsh-openfoam-workbench
```

**Edit `cordis.patch.yml` first** — it ships with the author's machine paths
(`foamRoots.org`/`foamRoots.com`, `/opt/paraview`, a `caseRoots`). Point them at
your own OpenFOAM distribution(s) — org and/or com — a headless-capable ParaView
(6.x), and your working directory. `defaultDistribution` picks the one used when a
tool is called without `distribution=`. Restart DSH after install or changes.

## Update

DSH imports plugin code at boot, so a running instance keeps the version it
started with:

```bash
# linked install ("...": "link:/path/to/dsh-openfoam-workbench") — no reinstall:
git -C /path/to/dsh-openfoam-workbench pull --ff-only
# package install (github:, npm tarball):
dsh plugin --profile web update @yakovlev-i-a/dsh-openfoam-workbench
# then restart the host that boots the profile:
dsh web
```

`openfoam_env_check`/`openfoam_version_info` return `plugin.version` from
`package.json`, so a stale in-memory copy is visible without guessing.

## Multiple distributions

Several OpenFOAM installations can coexist:

```yaml
foamRoots:
  org: /opt/openfoam14
  com: /usr/lib/openfoam/openfoam2606
defaultDistribution: org
```

`openfoam_env_check` reports **every** configured distribution. `openfoam_run`,
`openfoam_run_solver_async`, `openfoam_solver_build`, `openfoam_dry_compile`,
`openfoam_solver_smoke` and `openfoam_version_info` take a `distribution` argument
(`org` / `com`) and otherwise use `defaultDistribution`.

## Case conventions

Two conventions are enforced by the tools, not by the prompt:

- **`<case-dir-name>.foam`** — `clone_tutorial`, `mesh_plan`, `run`,
  `run_solver_async` and `render` create the ParaView entry file named after the
  case directory (`case.foam` is *not* accepted as a substitute). `inspect_case`
  reports `foamFile`, `list_cases` reports whether it exists.
- **Geometry-scale gate** — `mesh_plan` and `check` compare the bounding box with
  `scaleAskAbove` (default `0.1` m). Above it the result carries
  `needs_input: {question, options}`, rendered as a QUESTION block; the agent must
  ask the user with `ask_user_question` (e.g. "was the model built in
  millimetres?") before continuing. Set `scaleAskAbove: 0` to disable.

## Multi-region (CHT) cases

A multi-region case (`foamMultiRun`, `chtMultiRegionFoam`, `system/<region>/...`)
is understood end to end, not treated as a broken single-region case:

```text
inspect_case        -> regions, regionSolvers, per-region fields/patches
read_dict           -> file="fluid/fvSchemes", "system/fluid/...", "0/fluid/T", or region="fluid"
mesh_verify         -> checkMesh -region <r> for every region, verdict from checkMesh itself
run / run_async     -> mpirun -np N foamMultiRun (whitelisted launcher)
run_progress        -> t, steps, s/step, ETA from a multi-region/parallel log
solve_verify        -> RUNNING | STALLED | finished, no false divergence from the sigFpe banner
render              -> every mesh region (or region="fluid"), errors on an empty scene
```

`mesh_verify` takes its verdict from what checkMesh prints (`Mesh OK.` /
`Failed N mesh checks.`) and reports the stricter workbench thresholds
(aspect ratio, non-orthogonality, skewness) as warnings. `check` (the doctor)
is region-aware too: it reads `system/<r>/fvSchemes|fvSolution`, `0/<r>/*` and
`constant/<r>/*`, tags every finding with its region, and accepts
`region="<name>"` to narrow the report. `checkMesh -allRegions`
does not exist in OpenFOAM.org — the per-region call is the only honest one.

## What you get

- **Tools** (`openfoam_*`, 61): env/version, tutorials, solver clone/build/smoke,
  durable async runs (`run_solver_async` → `run_list` / `solver_status`),
  run progress/ETA (`run_progress`), meshing (STL → blockMesh/snappy → checkMesh),
  render (inline PNG, multi-region), verification (`solve_verify`, `mesh_verify`),
  case editing (`dict_set`, `clean`), doctor checks, diagnostics, papers,
  experience, and a usage self-audit (`usage_report`). Verdicts on huge logs read
  only the tail (`logTailBytes`, 4 MB by default) instead of the whole file.
- **Skills** (`SKILL.md`, load on demand, 11): case-builder, **cht** (multi-region
  conjugate heat transfer), solver-development, code-modify, meshing,
  mesh-independence, stats, viz, analyze, paper-reproduction, self-evolution.
  A test keeps every referenced tool registered and the always-on catalog under 4 KB.
- **Presentation**: inline render images (`image` block), tool-call cards
  (`generic` / `terminal`), table renders for `check` / `run_list` / `mesh_verify`.

## Security

No credentials ship with this repo. Put any API keys in DSH's `credentials`
service, never in `settings.json` or in the bundle.

## Docs

- [CORE.md](./CORE.md) — the always-on core prompt. It is read at runtime (the
  section text is a function, re-evaluated on every model step), so editing this
  file changes the agent on the next message, without restarting DSH. Keep it
  under 3 KB: a test fails if it grows past the budget or loses a routing marker.
- [NOTICE](./NOTICE) / [LICENSE](./LICENSE) — attribution (Apache-2.0 + MIT).

## Layout

```
lib/index.js       # entry: apply() mounts core + skills + tool groups (~50 lines)
lib/core.js        # always-on prompt section, read from CORE.md on every assembly
lib/skills.js      # reads skills/*/SKILL.md and registers the catalog
lib/runtime.js     # process/paths/runs helpers + config defaults (deps for tools)
lib/knowledge.js   # solver classification + error patterns + diagnosis
lib/presentation.js# pvpython renders, inline images, tool-call cards, tables
lib/registry.js    # registration choke point: render, strict schema, telemetry, safety
lib/of-engine.js   # OpenFOAM dict parser + 31 silent-failure rules (MIT)
lib/of-case.js     # multi-region model: regions, dict paths, command whitelist, progress
lib/meshlib.js     # STL/geometry helpers + blockMesh/snappy plan writer
lib/caselib.js     # four-step contract extraction, case facts, contract audit
lib/buildlib.js    # Make/files parsing + first compiler error
lib/paperlib.js    # PDF/paper extraction helpers
lib/explib.js      # experience cards + learned error patterns
lib/tools/*.js     # one factory per group: ({cfg, attachImage}) => tools (61 total)
skills/            # 11 × SKILL.md (progressive disclosure)
test/              # 60 tests: engine, tools, registry, skills, case model, inventory, log tail
locale/            # en/ru plugin-card strings
icon.svg           # plugin icon
```
