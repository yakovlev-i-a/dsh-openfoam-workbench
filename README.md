# OpenFOAM Workbench (dsh-openfoam-workbench)

> **⚠ Prototype.** Experimental code — APIs and behavior may change. Use at your own risk.

Native **DeepSeek Harness** plugin for OpenFOAM: case inspection, solver
development, meshing, durable background runs, off-screen renders, paper
reproduction and an experience library — plus 10 on-demand CFD skills.

## Status

Implemented and validated on **OpenFOAM 14** (org, modular solvers) and
**ParaView 6.2.0**:

**57 tools · 10 skills · 28 tests**

## Install

```bash
dsh plugin install /path/to/dsh-openfoam-workbench
```

**Edit `cordis.patch.yml` first** — it ships with the author's machine paths
(`foamRoots.org`/`foamRoots.com`, `/opt/paraview`, a `caseRoots`). Point them at
your own OpenFOAM distribution(s) — org and/or com — a headless-capable ParaView
(6.x), and your working directory. `defaultDistribution` picks the one used when a
tool is called without `distribution=`. Restart DSH after install or changes.

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

## What you get

- **Tools** (`openfoam_*`, 57): env/version, tutorials, solver clone/build/smoke,
  durable async runs (`run_solver_async` → `run_list` / `solver_status`),
  meshing (STL → blockMesh/snappy → checkMesh), render (inline PNG),
  verification (`solve_verify`, `mesh_verify`), doctor checks, diagnostics,
  papers, experience.
- **Skills** (`SKILL.md`, load on demand, 10): case-builder, solver-development,
  code-modify, meshing, mesh-independence, stats, viz, analyze,
  paper-reproduction, self-evolution.
- **Presentation**: inline render images (`image` block), tool-call cards
  (`generic` / `terminal`), table renders for `check` / `run_list` / `mesh_verify`.

## Security

No credentials ship with this repo. Put any API keys in DSH's `credentials`
service, never in `settings.json` or in the bundle.

## Docs

- [DESIGN.md](./DESIGN.md) — architecture, tool inventory, status, open questions.
- [CORE.md](./CORE.md) — the thin always-on core text.
- [NOTICE](./NOTICE) / [LICENSE](./LICENSE) — attribution (Apache-2.0 + MIT).

## Layout

```
lib/index.js       # 57 tools + core section + skill registration
lib/of-engine.js   # OpenFOAM dict parser + 28 silent-failure rules (MIT)
skills/            # 10 × SKILL.md (progressive disclosure)
test/              # 18 engine tests + 10 tool tests + mock smoke
locale/            # en/ru plugin-card strings
icon.svg           # plugin icon
```
