# OpenFOAM Workbench (dsh-openfoam-workbench)

Native **DeepSeek Harness** plugin for OpenFOAM: 65 tools and 11 on-demand skills
covering case scaffolding, inspection, solver development, meshing, multi-region CHT runs,
durable background jobs, off-screen renders, paper reproduction and an
experience library. The agent gets one coherent surface — a thin always-on core
prompt (`CORE.md`), procedural skills, and tools that enforce the conventions
instead of asking the model to remember them.

## Status

Implemented and validated on **OpenFOAM 14** (org, modular solvers),
**OpenFOAM v2606** (com, multi-region tutorials) and **ParaView 6.2.0**:

**v0.9.34 · 65 tools · 11 skills · 196 tests**

Listed in the [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/yakovlev-i-a/dsh-openfoam-workbench/)
catalog (GitHub-only entry: the npm package was withdrawn, so installs come from
git or the release tarball).

Pre-1.0: the tool set and the on-disk conventions may still change between
minor versions.

## Requirements

- **DeepSeek Harness** `>=0.2.2-rc.1` — declared as `engines.dsh`, so the
  installer refuses an older host instead of mounting a plugin it cannot support.
- **OpenFOAM** installed locally (org, e.g. `openfoam14`, and/or com, `vYYMM`);
  the plugin drives it in subprocesses and never vendors it.
- **ParaView 6.x** with `pvpython` for renders and `-help` checks — optional:
  everything else works without it.
- A POSIX shell (`bash -lc`) on Linux or macOS. Windows/WSL is not tested.

## Golden cases

Three small cases with stored reference quantities live in `test/golden/`:
`cavity` (incompressible, both families), `sphereBox` (compressible, both
families, stored snappy mesh), `sphereCht` (CHT, both families, per-family stored
mesh) and `pitzDaily` (tutorial smoke test). Both branches run the same cases:
the compressible results agree within ~0.1 % and the CHT solid heats to the same
range, which is what makes `support: full` measurable. `sphereCht` starts
from a **stored mesh fixture** (`test/golden/meshes/sphereCht`, gzipped polyMesh
that both families read), so both branches solve exactly the same mesh and only
the dictionaries are generated per run. Run them against an installation with:

```bash
node scripts/run-golden.mjs --distribution org     # verify
node scripts/run-golden.mjs --update               # re-bless after a reviewed change
```

`--update` must be a deliberate, reviewed commit: the values are the regression
contract. `.github/workflows/golden.yml` runs the same script inside OpenFOAM containers
(`dicehub/openfoam:14`, `dicehub/openfoam:opencfd-2606`) for the `org` and `com`
matrix entries — proven on both: org runs all three cases, com runs `cavity`
with identical numbers and records the two skips with reasons. A case whose
tutorial is not usable on a distribution is recorded with a reason in
`test/golden/cases.mjs`.

## Supported versions

The tool targets **org 14** and **com v2606**: those are the installations it is
tested end to end on. Every other release is described through a capability
object (probed from the installation) and lands in `partial`/`unknown` until it
is added to the test matrix:

| family | tested | support | notes |
|---|---|---|---|
| org (OpenFOAM Foundation) | 14 | `full` | modular `foamRun` + solver module, `physicalProperties`/`momentumTransport`, `surfaceFeatures` |
| com (ESI/OpenCFD) | v2606 | `full` | legacy applications (`simpleFoam`, `rhoPimpleFoam`), `transportProperties`/`turbulenceProperties`, `surfaceFeatureExtract` |
| org 10-13 | – | `partial` | modular conventions assumed; templates and rules use the same layout |
| com 2312-2512 | – | `partial` | legacy conventions assumed |
| anything older or unknown | – | `unknown` | best effort; `openfoam_check` adds an `untested-version` warning |

Capabilities are detected from the installation itself (`openfoam_version_info`
and `openfoam_env_check` return a `caps` object: modular form, post-processing
and feature utilities, transport/turbulence file names, 0/ vs 0.orig, support
level). `openfoam_mesh_plan`, `openfoam_case_scaffold` and `openfoam_check`
report the same capabilities, so a generated case always says which conventions
it followed.

## Install

One command installs the newest release, whatever it is:

```bash
dsh plugin --profile web add https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases/latest/download/dsh-openfoam-workbench.tgz
```

Then restart the host that boots the profile — `dsh web` for this Web UI (it is
the step that loads the new code):

```bash
dsh web
```

`--profile web` selects the profile that serves the Web UI; drop it for the
default profile. The link has no version in it: `releases/latest/download/…` is
GitHub's alias for the newest release, so it keeps working release after release.

Verify that it is live — `openfoam_env_check` prints `plugin.version` and the
OpenFOAM installations it found:

```text
openfoam_env_check
```

## Update

**The same command, then a restart:**

```bash
dsh plugin --profile web add https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases/latest/download/dsh-openfoam-workbench.tgz
dsh web
```

None of it happens by itself, on purpose: a tarball install carries no registry
metadata, so nothing polls for a new version, and the plugin never phones home.
A running DSH instance also keeps the code it booted with, so files replaced on
disk change nothing until the restart.

Nothing to remember about versions: the link above always resolves to the newest
release, and `openfoam_env_check` is the honest check of what is actually loaded —
an old number there means the restart has not happened.

### Pinned and other installs

| you want | command |
|---|---|
| a specific release | `dsh plugin --profile web add https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases/download/v0.9.33/yakovlev-i-a-dsh-openfoam-workbench-0.9.33.tgz` |
| a git tag | `dsh plugin --profile web add git+https://github.com/yakovlev-i-a/dsh-openfoam-workbench.git#v0.9.33` |
| exactly one commit (bug reports) | `…dsh-openfoam-workbench.git#<40-hex sha>` |
| your own checkout | `dsh plugin --profile web add link:/path/to/dsh-openfoam-workbench` |
| the plugin market | *Plugins → Plugin Market*, search "OpenFOAM" |

All of them end with the same restart. Notes on the choices:

- **pinned** — the tag is the useful middle ground: the version is in the
  command, the code is frozen at what was tested and released. A 40-hex commit
  pins byte for byte what a bug report was filed against. A branch such as
  `#main` also installs but takes unreleased commits and reports the same
  `plugin.version` for all of them.
- **checkout** — `link:` follows your edits after a restart; plain `add /path`
  copies the tree and goes stale silently. Update it with
  `git -C /path/to/dsh-openfoam-workbench pull --ff-only`.
- **market** — the [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/yakovlev-i-a/dsh-openfoam-workbench/)
  entry resolves to the default branch, i.e. `main`; if [dshmarket](https://github.com/dsh-market/dsh-market)
  is installed it can also flag updates (npm version or pinned commit vs
  repository HEAD — enable *Plugins → Update checks*). A tarball install gets no
  such signal, and `link:` installs are not tracked at all.
- **Discover** — the machine-readable `dsh-plugin-catalog` index only lists
  packages published on npm. This one is not, so to see it in *Discover* add this
  repository's own index as an index source:
  `https://cdn.jsdelivr.net/gh/yakovlev-i-a/dsh-openfoam-workbench@v0.9.34/market/index.json`.
- npm distribution was withdrawn: the package is gone from the registry and
  `package.json` keeps `private: true`. The tarball and the git spec are the
  supported paths.

### Where the version is written down

- the releases page — <https://github.com/yakovlev-i-a/dsh-openfoam-workbench/releases>
  (each release carries a stable-named tarball for the line above, plus the
  version-named one to pin, and the commit its tag points at);
- `market/index.json` — `version` and `source.commit` of the latest release;
- in a session — `openfoam_env_check`.

**Zero configuration.** The bundle ships no paths: at startup the plugin scans
`/opt`, `/usr/lib/openfoam`, `/usr/local` and `~/OpenFOAM` for directories that
contain `etc/bashrc` (org `openfoam14` and com `vYYMM` are told apart by name),
and looks for ParaView in `/opt` and on `PATH`. `openfoam_env_check` shows what
was found; `defaultDistribution` picks the install used when a tool is called
without `distribution=`.

Everything is also editable from **Settings → Plugins → OpenFOAM Workbench** once
DSH has mounted the plugin (`lib/settings-schema.js` exports a native schemastery
`Config`: `foamRoots`, `caseRoots`, `paraviewPython`, `language`, `scaleAskAbove`,
`logTailBytes`, `extraCommands`, …). The schema borrows the schemastery copy that
ships with DSH, so the bundle keeps zero npm dependencies.

Override in your **profile** patch (not in this repository) when you prefer YAML
or when discovery gets a path wrong:

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

## Case libraries (custom `.so`)

A case can ship its own compiled libraries — a custom `fvMeshTopoChanger`, an
`fvOption`, a boundary condition — and list them in `system/controlDict`:

```text
libs ("libamrTopoChanger.so");
```

OpenFOAM loads those with `dlopen()`, so the file has to be on the loader path of
the process that creates the mesh. That path is derived from `FOAM_USER_LIBBIN`,
which depends on `$USER`: a case built with a stripped environment (`env -i …`)
installs into `~/OpenFOAM/-<version>/platforms/...`, while the same command run
from a normal shell looks in `~/OpenFOAM/<user>-<version>/platforms/...`. The
solver then stops with `dlopen error` or `Unknown fvMeshTopoChanger type`, which
names neither the library nor the directory.

Three tools close that gap:

- **`libPaths`** (`run`, `run_solver_async`, `field_stats`, `solver_build`) —
  directories prepended to `LD_LIBRARY_PATH`, e.g.
  `libPaths: ["/home/me/OpenFOAM/-14/platforms/linux64GccDPInt32Opt/lib"]`.
- **`env`** — the same thing explicitly: `{LD_LIBRARY_PATH: "…:…"}`. Only
  library locations are accepted; `LD_PRELOAD`, `LD_AUDIT` and `PATH` are refused,
  because they would let a call choose the code that runs.
- **`solver_build(libbin=…)`** — install a library into a directory the run can
  reach (overrides `FOAM_USER_LIBBIN` for `wmake`). Without it the build reports
  the resolved target and refuses up front when that directory is not writable —
  a lib dir outside the workspace is read-only under the file sandbox.

`openfoam_check` resolves every `libs (...)` entry against `FOAM_LIBBIN`,
`FOAM_USER_LIBBIN` and the `~/OpenFOAM/*/platforms/*/lib` trees, and its
`case-library-missing` finding names the directory that does hold the library
plus the exact `libPaths` call to fix it. `diagnose_error` recognises the
`dlopen` / `Unknown fvMeshTopoChanger type` messages and points at the same fix.

Background runs keep their registry entry with the extra environment
(`openfoam_run_solver_async(logName=…)` only renames the log), so
`openfoam_run_list` / `openfoam_solver_status` / `openfoam_run_progress` still
track a run that needed a library path.

## Case conventions

Two conventions are enforced by these tools (for any work that goes through
them), not by the prompt:

- **`<case-dir-name>.foam`** — `clone_tutorial`, `mesh_plan`, `run`,
  `run_solver_async` and `render` create the ParaView entry file named after the
  case directory (`case.foam` is *not* accepted as a substitute). `inspect_case`
  reports `foamFile` and every other `.foam` in `foamFiles`, `list_cases` reports
  whether the entry file exists, and `check` warns about a stray `case.foam` — the
  usual souvenir of a case copied from an older one, or of a render helper that an
  older build wrote into the case directory.
- **Relative paths** — a relative `casePath` resolves against the first
  `caseRoots` entry (the session working directory is only the fallback when
  `caseRoots` is empty); absolute paths always work. Run records and logs live
  next to their case in `<case>/.openfoam-runs`, unless `runsDir` pins a
  directory.
- **Geometry-scale gate** — `mesh_plan` and `check` compare the bounding box with
  `scaleAskAbove` (default `0.1` m). Above it the result carries a
  language-neutral `needs_input` payload — `{kind, ask, data, options: [{id, label}]}`
  — rendered as a QUESTION block; the agent asks with `ask_user_question` in the
  user's language (CORE.md `{{language}}`), translating the option labels, and
  continues only after the answer. Set `scaleAskAbove: 0` to disable.

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
- **Presentation**: inline render images (`image` blocks), table renders for
  `check` / `run_list` / `mesh_verify` / `env_check` / `list_cases` /
  `run_progress` / `solve_verify` / `usage_report`, compact JSON for large
  payloads, and a `QUESTION` block whenever a tool needs a human decision
  (`needs_input`). In the Web UI every `openfoam_*` row carries a small OpenFOAM
  mark — flow around an obstacle, 26x13 — in front of the tool name, and so does
  the row of every skill this bundle ships (`Skill · openfoam-cht`), while other
  plugins' skills keep their plain row. The row keeps
  the colour DSH gives it (the label colour, red on an error, whatever the theme
  uses) and the mark inherits that colour through `currentColor`, so the
  presentation adds no second palette. It is one `::before` rule in `client.js`,
  the browser half of this bundle: no per-tool registration and no DOM change. The
  mark is an SVG **mask** (~900 bytes of drawing inlined as a data URI) because only
  a mask can be painted with `currentColor`; it needs no file, no `assets/` export
  and no request from the host. A skill row exposes no name attribute CSS could
  match on, so a small `MutationObserver` tags the rows whose summary is one of the
  `openfoam-*` skills with `data-ofw-skill` and removes the tag again when React
  reuses the node for another skill. The drawing itself lives in `inline-icon.svg` and
  `node scripts/make-icon-mask.mjs` regenerates the embedded copy — a test fails
  when the two drift apart.

## Screenshots

![Multi-region CHT case: temperature field rendered from the case directory](docs/media/cht-render.png)

`openfoam_render` on `multiRegion/CHT/coolingCylinder2D` — 3045 cells, both
regions, temperature. The render reads only the case directory (no GUI).

## Write policy

Every mutating tool decides by **impact**, and the impact is judged by the entry,
not by the file (a wrong `0/U` inlet or `fvSchemes` term converges to a
plausible but wrong answer, so neither is "safe"):

| Tool / change | Default | Why |
|---|---|---|
| `clean` | dry run | deletion cannot be undone |
| `case_scaffold` | writes only missing files (`force: true` to overwrite) | an existing setup is the user's |
| `dict_set` on `controlDict` output keys (`writeInterval`, `writeFormat`, …) | applies | organisational, visible in the log |
| `dict_set` on `purgeWrite` | low for `0`, **preview** for any value > 0 | it deletes older time directories |
| `dict_set` on `0/*`, `fvSchemes`, `fvSolution`, `constant/*`, `deltaT`, `application`, anything unknown | **preview** (`applied: false`, `NOT APPLIED`) until `apply: true` | can change physics or numerics |
| `dict_set` on `controlDict` `libs`/`functions` | **approval** via the DSH user-approval seam, always required (no config switch), fail-closed without an agent identity or an answerer | can execute code |

`writeMode: impact | apply | preview` (Settings) overrides the default globally.
`dict_set` edits **single-line top-level entries**; a sub-dictionary (`functions`, `boundaryField`) is refused with an explicit error rather than half-edited.
`expect: "<current value>"` refuses a write on top of a value you did not see, and
every applied change returns a `changeId` plus an `afterHash`; `openfoam_dict_undo`
reverts it and refuses when the file changed after that edit.

## Security

The plugin **runs local OpenFOAM programs with the privileges of your OS user**
and is **not a sandbox**: a solver or `wmake` call has the same access as a shell
started by you.

What it does to make that safe:

- only whitelisted applications run (`BASE_APPS` plus the `extraCommands`
  config), and a command containing shell metacharacters (`;`, `|`, `$()`,
  backticks, newlines) is refused before anything is spawned;
- the shell is always a **static script**: the bashrc, the working directory, the
  log path and the command arrive as argv / positional parameters, never as text
  spliced into the script, so a path containing quotes, `$()`, backticks or
  spaces cannot become shell code (`lib/runtime.js`, `FOAM_RUN_SCRIPT`);
- child processes get `stdin: ignore` and never inherit a terminal;
- `clean` is a dry run by default, `dict_set` replaces one entry atomically and
  keeps a `.bak`, and the source tools only read the OpenFOAM installation.

### What these gates do and do not cover

The write policy above applies to **this plugin's tools**. An agent that also has
generic shell/file tools can change a case without them — `bash -c 'echo ... >>
system/controlDict'` never reaches `dict_set`, its impact classification or its
approval request. So treat them as **defense in depth**, not as the barrier:

- the effective boundary is the DSH sandbox and permission mode (for example
  `workspace-write`, which refuses writes outside the workspace) plus the
  approval answerer for what you choose to review;
- `enforceToolRouting` (Settings: `off` / `warn` / `deny` / `strict`, default
  `warn`) makes the plugin watch DSH's `tools/pre-execute` seam: a
  `bash`/`write`/`edit` call that writes a case dictionary is recorded, refused
  (`deny`) or refused-unless-escalated (`strict`);
- `strict` has an audited way out: `openfoam_escalate({target, toolsTried, why})`
  grants one single-use, 10-minute token for that target, but only when the named
  plugin tools were really called and failed in the last 15 minutes (the call
  history is the evidence). `escalationAuthority` decides who issues it:
  `auto` (the plugin, recorded in `openfoam_usage_report`) or `ask` (the DSH
  approval answerer, fail-closed without it). Text matching on shell commands is
  evadable, so the guard is a strong deterrent plus a signal, not a proof;
- within a case, the plugin's gates make the *normal* path safe (one-entry
  atomic edits, previews for physics changes, approval for code execution,
  containment checks) and leave an audit trail (`changeId`, `afterHash`,
  `.openfoam-changes/`);
- when a case matters, review what the agent actually ran: `openfoam_run_list`,
  the change journal and `git diff` in the workspace.

No credentials ship with this repo. Put any API keys in DSH's `credentials`
service, never in `settings.json` or in the bundle.

## Docs

- [CORE.md](./CORE.md) — the always-on core prompt. It is read at runtime (the
  section text is a function, re-evaluated on every model step), so editing this
  file changes the agent on the next message, without restarting DSH. Keep it
  under 3 KB: a test fails if it grows past the budget or loses a routing marker.
  The `{{language}}` placeholder is filled from the `language` config or the OS
  locale, so one file serves every language.
  The iron rules separate *verifiable facts* (the case, the installed OpenFOAM,
  a run result — check with a tool) from *conceptual answers* (`why does the
  pressure equation carry this correction?` — answer directly and cite the
  source when the version matters), so the agent does not call a tool just to
  satisfy a rule.
- [NOTICE](./NOTICE) / [LICENSE](./LICENSE) — attribution (Apache-2.0 + MIT).
- [market/index.json](./market/index.json) — the format-1 marketplace index
  pinned to a release commit (`node scripts/make-market-index.mjs --commit <sha>
  --out market/index.json`); host it over https and add that URL in Discover.

## Layout

```
lib/index.js       # entry: apply() mounts core + skills + tool groups (~60 lines)
lib/core.js        # always-on prompt section, read from CORE.md on every assembly
lib/skills.js      # reads skills/*/SKILL.md and registers the catalog
lib/runtime.js     # process/paths/runs helpers + the LD_LIBRARY_PATH gate for runs
lib/discover.js    # finds OpenFOAM/paraView installs, probes their capabilities
lib/versions.js    # capability layer: feature detection instead of version tables
lib/knowledge.js   # solver classification + error patterns + diagnosis
lib/presentation.js# pvpython renders, inline images, tool-call cards, tables
lib/registry.js    # registration choke point: render, strict schema, telemetry, safety
lib/impact.js      # write-impact classification for dict_set (low/high/critical)
lib/routing-guard.js # reads Bash calls that bypass the plugin's own tools
lib/escalations.js # short-lived, audited exceptions to the routing policy
lib/of-engine.js   # OpenFOAM dict parser + 31 silent-failure rules (MIT)
lib/of-case.js     # multi-region model: regions, dict paths, command whitelist, progress
lib/meshlib.js     # STL/geometry helpers + blockMesh/snappy plan writer
lib/scaffold.js    # writes the dictionaries of a fresh incompressible case
lib/scaffold-compressible.js, lib/scaffold-cht.js  # the same for those families
lib/caselib.js     # four-step contract extraction, case facts, contract audit
lib/buildlib.js    # Make/files parsing + first compiler error
lib/paperlib.js    # PDF/paper extraction helpers
lib/explib.js      # experience cards + learned error patterns
lib/settings-schema.js # native schemastery Config for Settings → Plugins
lib/tools/*.js     # one factory per group: ({cfg, attachImage}) => tools (65 total)
client.js          # browser half: the mark on this bundle's tool and skill rows
skills/            # 11 × SKILL.md (progressive disclosure)
test/              # 196 tests: engine, tools, registry, skills, security, golden schema
test/golden/       # cases + stored meshes, run by scripts/run-golden.mjs
scripts/           # release, catalog index, icon mask, golden runner
locale/            # en/ru plugin-card strings
inline-icon.svg    # source of the row mark (scripts/make-icon-mask.mjs turns it
                   #   into the mask embedded in client.js; test/icon.test.mjs
                   #   fails when the two drift)
icon.png           # plugin icon for the catalog (512x512 PNG, raster only there)
icon.svg           # the same icon as the vector source (crisp at any size)
```

## Prior art & acknowledgements

The plugin is its own implementation: a Cordis bundle with its own tool layer,
runtime, multi-region case model, presentation, tests and prompt design. Two
parts nevertheless carry lineage, stated here precisely:

- **Dictionary parser and doctor checks** — `lib/of-engine.js` is a port of
  [dsh-openfoam-doctor](https://github.com/bushizhanghan/dsh-openfoam-doctor)
  (MIT): the OpenFOAM dictionary parser, the silent-failure rules and the
  checkMesh / run-log parsers. This plugin extends it (region-aware checks, 31
  rules, fixes) and ships its license in `licenses/`.
- **Experience format and operation coverage** — the experience-card schema
  (`title / domain / triggers / solver / physics / recipe / key_params /
  verify_seq / pitfalls`) and the overall "inspect → plan → run → verify" tool
  coverage were inspired by [NullFlux / CFDriver](https://github.com/LZF1111/nullflux)
  (Apache-2.0). No source files were copied; the code, architecture and
  descriptions are original.
- **Skill protocols** — the mesh-independence procedure (STEPS A–E), the
  numerical-stats patterns and the PROCEED / REVISE / RERUN decision taxonomy
  were adapted from
  [AI-CFD-Scientist `cfd-skills`](https://github.com/csml-rpi/AI-CFD-Scientist/tree/main/cfd-skills).
  The wording lives in `skills/` and was rewritten for this plugin.

OpenFOAM itself is not redistributed: the plugin drives the user's installed
OpenFOAM (GPL-3.0) in subprocesses.
