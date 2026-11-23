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
(`/opt/openfoam14`, `/opt/paraview`, a `caseRoots`). Point them at your own
OpenFOAM, a headless-capable ParaView (6.x), and your working directory before
installing. Restart DSH after install or after source changes.

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
