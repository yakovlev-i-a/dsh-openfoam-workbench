# OpenFOAM Workbench (dsh-openfoam-workbench)

A native **DeepSeek Harness** plugin for OpenFOAM: 69 tools and 12 on-demand
skills for case setup, inspection, meshing, solver development, multi-region CHT
runs, durable background jobs, off-screen renders, paper reproduction and an
experience library. The agent gets one surface — a thin always-on core prompt
(`CORE.md`), procedural skills, and tools that enforce the conventions instead of
asking the model to remember them.

**v0.9.40 · 69 tools · 12 skills · 240 tests** · validated on **OpenFOAM 14**
(org) and **v2606** (com) with **ParaView 6.2** · in the
[awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/yakovlev-i-a/dsh-openfoam-workbench/)
catalog. Pre-1.0: tools and on-disk conventions may still change between minor
versions.

## Install

```bash
dsh plugin --profile web add https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases/latest/download/dsh-openfoam-workbench.tgz
dsh web
```

The second line is part of the install: DSH imports plugin bundles at boot, so
replacing files on disk changes nothing in memory. `--profile web` is the profile
that serves the Web UI — drop it for the default profile. The link carries no
version: `releases/latest/download/…` is GitHub's alias for the newest release.

Check what is actually loaded — `openfoam_env_check` prints `plugin.version` and
the OpenFOAM installations it found:

```text
openfoam_env_check
```

Requirements: **DSH `>=0.2.2-rc.1`** (declared as `engines.dsh`, so an older host
refuses to mount the plugin instead of half-running it), a local **OpenFOAM**
install (driven in subprocesses, never vendored), optionally **ParaView 6.x** for
renders, and a POSIX shell — Linux/macOS; Windows and WSL are untested.

## Update

**The same command, then a restart:**

```bash
dsh plugin --profile web add https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases/latest/download/dsh-openfoam-workbench.tgz
dsh web
```

Nothing updates by itself, on purpose: a tarball install carries no registry
metadata, nothing polls for a new version, and the plugin never phones home. The
link always resolves to the newest release, and an old `plugin.version` after a
restart means the install did not replace the package.

### Pinned and other installs

| you want | command |
|---|---|
| a specific release | `dsh plugin --profile web add https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases/download/v0.9.35/yakovlev-i-a-dsh-openfoam-workbench-0.9.35.tgz` |
| a git tag | `dsh plugin --profile web add git+https://github.com/yakovlev-i-a/dsh-openfoam-workbench.git#v0.9.35` |
| exactly one commit (bug reports) | `…dsh-openfoam-workbench.git#<40-hex sha>` |
| your own checkout | `dsh plugin --profile web add link:/path/to/dsh-openfoam-workbench` |
| the plugin market | *Plugins → Plugin Market*, search "OpenFOAM" |

All of them end with the same restart.

- **pinned** — the tag freezes the code at what was tested and released; a 40-hex
  commit pins byte for byte what a bug report was filed against. A branch such as
  `#main` also installs but takes unreleased commits and reports the same
  `plugin.version` for all of them.
- **checkout** — `link:` follows your edits after a restart; plain `add /path`
  copies the tree and goes stale silently. Update with
  `git -C /path/to/dsh-openfoam-workbench pull --ff-only`.
- **market** — the catalog entry resolves to the default branch, i.e. `main`. With
  [dshmarket](https://github.com/dsh-market/dsh-market) installed it can also flag
  updates (npm version, or pinned commit vs repository HEAD; enable *Plugins →
  Update checks*). A tarball install gets no such signal and `link:` installs are
  not tracked at all.
- **Discover** — the machine-readable `dsh-plugin-catalog` index lists only
  packages published on npm. This one is not (npm distribution was withdrawn;
  `package.json` keeps `private: true`), so to see it in *Discover* add this
  repository's own index as an index source:
  `https://cdn.jsdelivr.net/gh/yakovlev-i-a/dsh-openfoam-workbench@v0.9.35/market/index.json`.
- **where the version is written down** — the
  [releases page](https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases)
  (stable-named asset for the install line, version-named one to pin, and the
  commit its tag points at), `market/index.json`, and `openfoam_env_check`.

## Configuration

**Zero configuration.** The bundle ships no paths: at startup the plugin scans
`/opt`, `/usr/lib/openfoam`, `/usr/local` and `~/OpenFOAM` for directories that
contain `etc/bashrc` (org `openfoam14` and com `vYYMM` are told apart by name),
and looks for ParaView in `/opt` and on `PATH`.

Everything is editable from **Settings → Plugins → OpenFOAM Workbench** once DSH
has mounted the plugin (`lib/settings-schema.js` exports a native schemastery
`Config`: `foamRoots`, `caseRoots`, `paraviewPython`, `language`, `scaleAskAbove`,
`logTailBytes`, `writeMode`, `enforceToolRouting`, `escalationAuthority`,
`extraCommands`, …). The schema borrows the schemastery copy that ships with DSH,
so the bundle keeps zero npm dependencies.

Prefer YAML, or discovery found the wrong path? Override in your **profile** patch
(not in this repository):

```yaml
- id: openfoam-workbench
  name: '@yakovlev-i-a/dsh-openfoam-workbench'
  config:
    foamRoots: { org: /opt/openfoam14, com: /usr/lib/openfoam/openfoam2606 }
    paraviewPython: /opt/paraview/bin/pvpython
    caseRoots: [/path/to/cases]   # relative case paths resolve from cwd otherwise
    language: ru                  # '' = OS locale, 'ru'/'en'/... or a name forces one
```

Restart DSH after install or after changing the patch.

### Several installations at once

```yaml
foamRoots:
  org: /opt/openfoam14
  com: /usr/lib/openfoam/openfoam2606
defaultDistribution: org
```

`openfoam_env_check` reports **every** configured distribution. `openfoam_run`,
`openfoam_run_solver_async`, `openfoam_solver_build`, `openfoam_dry_compile`,
`openfoam_solver_smoke` and `openfoam_version_info` take `distribution`
(`org` / `com`) and otherwise use `defaultDistribution`.

## What you get

- **Tools** (`openfoam_*`, 69): env/version, tutorials, solver clone/build/smoke,
  durable async runs (`run_solver_async` → `run_list` / `solver_status`), run
  progress and ETA, meshing (STL → blockMesh/snappy → checkMesh), renders (inline
  PNG, multi-region), verification (`solve_verify`, `mesh_verify`), case editing
  (`dict_set`, `clean`), `0/` fields for a new mesh (`fields_from_template`) and
  zone values (`set_fields`), doctor checks, error diagnosis, flux checking
  (`flow_check`), papers, experience, and a usage self-audit. Verdicts on huge logs read only the tail (`logTailBytes`, 4 MB
  by default) instead of the whole file.
- **Skills** (`SKILL.md`, load on demand, 12): case-builder, cht, lts-ch,
  solver-development, code-modify, meshing, mesh-independence, stats, viz, analyze,
  paper-reproduction, self-evolution. A test keeps every referenced tool registered and the always-on
  catalog under 4 KB.
- **Presentation**: inline render images, table renders for `check` / `run_list` /
  `mesh_verify` / `env_check` / `list_cases` / `run_progress` / `solve_verify` /
  `usage_report`, compact JSON for large payloads, and a `QUESTION` block whenever
  a tool needs a human decision (`needs_input`). In the Web UI every `openfoam_*`
  row and every skill row of this bundle (`Skill · openfoam-cht`) carries a small
  OpenFOAM mark — flow around an obstacle, 26×13 — while other plugins' skills keep
  their plain row. The row keeps the colour DSH gives it (label colour, red on an
  error, whatever the theme uses) and the mark inherits it through
  `currentColor`, so no second palette is introduced. It is one `::before` rule in
  `client.js`: no per-tool registration, no DOM change, no request. The mark is an
  SVG **mask** (~900 bytes inlined as a data URI) because only a mask can be
  painted with `currentColor`; a skill row exposes no name attribute CSS could
  match, so a small `MutationObserver` tags rows whose summary is one of the
  `openfoam-*` skills and untags them when React reuses the node. The drawing lives
  in `inline-icon.svg`; `node scripts/make-icon-mask.mjs` regenerates the embedded
  copy and a test fails when the two drift apart.

## Tested on

`support: full` is a measurement, not a claim: the golden cases in `test/golden/`
must pass on both families, and they run on every push.

| family | tested | support | notes |
|---|---|---|---|
| org (OpenFOAM Foundation) | 14 | `full` | modular `foamRun` + solver module, `physicalProperties`/`momentumTransport`, `surfaceFeatures` |
| com (ESI/OpenCFD) | v2606 | `full` | legacy applications (`simpleFoam`, `rhoPimpleFoam`), `transportProperties`/`turbulenceProperties`, `surfaceFeatureExtract` |
| org 10–13 | – | `partial` | modular conventions assumed, same layouts and rules |
| com 2312–2512 | – | `partial` | legacy conventions assumed |
| anything older or unknown | – | `unknown` | best effort; `openfoam_check` adds an `untested-version` warning |

Capabilities are detected from the installation itself, not from a version table:
`openfoam_version_info` / `openfoam_env_check` return a `caps` object (modular
form, post-processing and feature utilities, transport/turbulence file names, 0/
vs 0.orig, support level), and `mesh_plan`, `case_scaffold` and `check` report the
same capabilities, so a generated case always says which conventions it followed.

Golden cases: `cavity` (incompressible), `sphereBox` (compressible), `sphereCht`
(multi-region CHT) and `pitzDaily` (tutorial smoke test). The compressible pair
agrees within ~0.1 % and the CHT solid reaches the same temperature range on both
families. `sphereCht` starts from a **stored mesh fixture** (gzipped polyMesh in
`test/golden/meshes/`), so both families solve exactly the same mesh and only the
dictionaries are generated per run.

```bash
node scripts/run-golden.mjs --distribution org   # verify
node scripts/run-golden.mjs --update             # re-bless a reviewed change
```

`--update` must be a deliberate, reviewed commit: the stored values are the
regression contract. `.github/workflows/golden.yml` runs the same script inside
OpenFOAM containers (`dicehub/openfoam:14`, `dicehub/openfoam:opencfd-2606`);
a tutorial that is not usable on a family is recorded with a reason in
`test/golden/cases.mjs` rather than silently skipped.

## Screenshot

![Multi-region CHT case: temperature field rendered from the case directory](docs/media/cht-render.png)

`openfoam_render` on `multiRegion/CHT/coolingCylinder2D` — 3045 cells, both
regions, temperature. The render reads only the case directory (no GUI).

## The details

The long parts live in `docs/`, one page each — the README stays a map:

| page | what is in it |
|---|---|
| [docs/conventions.md](./docs/conventions.md) | the `<case-dir-name>.foam` entry file, relative paths and `caseRoots`, the geometry-scale gate, 2D cases and the `empty` axis, multi-region (CHT) behaviour, custom `.so` libraries (`libPaths` / `env` / `libbin`) |
| [docs/write-policy.md](./docs/write-policy.md) | what each mutating tool does by default and why: previews for physics, approval for `libs`/`functions`, `changeId` + `undo` |
| [docs/security.md](./docs/security.md) | what the gates do, what they do not cover, `enforceToolRouting`, and the audited `openfoam_escalate` path |
| [docs/layout.md](./docs/layout.md) | file layout, `CORE.md` and how the always-on prompt works, `market/index.json` |

## Prior art & acknowledgements

The plugin is its own implementation: a Cordis bundle with its own tool layer,
runtime, multi-region case model, presentation, tests and prompt design. Two parts
carry lineage, stated precisely:

- **Dictionary parser and doctor checks** — `lib/of-engine.js` is a port of
  [dsh-openfoam-doctor](https://github.com/bushizhanghan/dsh-openfoam-doctor) (MIT):
  the OpenFOAM dictionary parser, the silent-failure rules, the checkMesh and
  run-log parsers. This plugin extends it (region-aware checks, 31 rules, fixes)
  and ships its licence in `licenses/`.
- **Experience format and operation coverage** — the experience-card schema and the
  "inspect → plan → run → verify" coverage were inspired by
  [NullFlux / CFDriver](https://github.com/LZF1111/nullflux) (Apache-2.0). No source
  files were copied.
- **Skill protocols** — the mesh-independence procedure (STEPS A–E), the
  numerical-stats patterns and the PROCEED / REVISE / RERUN taxonomy were adapted
  from [AI-CFD-Scientist `cfd-skills`](https://github.com/csml-rpi/AI-CFD-Scientist/tree/main/cfd-skills);
  the wording in `skills/` was rewritten for this plugin.

OpenFOAM itself is not redistributed: the plugin drives the user's installed
OpenFOAM (GPL-3.0) in subprocesses.
