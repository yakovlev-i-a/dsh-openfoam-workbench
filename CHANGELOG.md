# Changelog

## v0.9.41

The surface is smaller on purpose. A revision of every tool and skill found 16
tools that were a strict subset of another tool or had no producer at all, four
skills that repeated each other, and an always-on prompt sitting at 3071 of its
3072 allowed bytes — the budget was spent on routing lines for duplicates.

Every removal below was verified by running both sides on the same real input
before it was deleted, and every merge kept the surviving tool's behaviour:

- **Merged into an existing tool** (no capability lost): `mesh_box_stl` and
  `mesh_stl_check` → `stl_generate(bbox_min, bbox_max)` / `stl_inspect` +
  `mesh_verify`; `geom_verify` → `stl_inspect(expected_bbox)` (returns `pass` and
  `checks: watertight, positive volume, bbox matches expected`);
  `env_check` → `version_info(all: true)`; `log` → `mesh_verify(log_path)` for a
  saved checkMesh log and `solve_verify` for a solver log; `run_progress` →
  `solve_verify`, which now returns `time`, `endTime`, `secondsPerStep` and `eta`
  while the run is live; `case_probe_facts` → `inspect_case(facts: true)`
  (accepts `case_path` as before); `dry_compile` and `solver_smoke` →
  `solver_build(dryRun: true, smoke: true)`; `paper_param_verify` →
  `paper_extract(verify: true, expected_units: {…})`.
- **Removed** (duplicate or dead): `compare_render` (`render` twice),
  `post_verify`, `list_cases`, `read_document` (the harness `read` tool covers
  text), `experience_export_sft` and `experience_eval_compare` (nothing in the
  plugin ever produced the records the latter compared).
- **Skills 12 → 11**: `openfoam-analyze` folded into `openfoam-stats` as "Pattern
  N — several cases: the QoI table" (its collection, trends, correlation and
  RMSE/MAE recipe kept verbatim in spirit); every skill that named a removed tool
  now names the surviving call.
- `CORE.md` rewritten around the surviving tools and back inside the budget
  (3064 of 3072 bytes), so the always-on prompt routes to `inspect_case(facts:
  true)`, `solve_verify`, `run_watch` and `stl_generate` instead of the tools they
  replaced.

69 tools → **53**, 12 skills → **11**, 240 tests still green.

## v0.9.40

The transient verdict now actually runs. v0.9.36 taught `solve_verify` that a
transient case is judged on completion, not on the last step's initial residual —
but `steadyFrom` asked for `fvSchemes` without the `system/` prefix, so it read a
file that does not exist and returned `null` for every case. The old rule (compare
the floor with 1e-3) stayed in force, which is why a healthy 33-minute CHT stage
was still reported as `REVISE`.

- `steadyFrom` reads `system/fvSchemes` and `system/<region>/fvSchemes`; a
  multi-region case answers from the first region that has a `ddtSchemes.default`,
  and an unreadable case still returns `null` instead of guessing.
- Measured on the case that produced the report: `stage1-coupled.log` (10 000
  steps, t = 0.1, 0.185 s/step) now gives `state: finished`, `decision: PROCEED`,
  with the reason "transient run: residual floor 0.0014703535 (p) is the initial
  residual of the last time step, not a convergence criterion"; the 1000 s stage
  reports 9 800 steps and t = 1000.
- `test/runwatch.test.mjs` covers single-region, region-dir and unreadable cases.

## v0.9.39

A long run is now something the agent can watch, a dictionary key inside a block is
something it can reach, and a rank that dies under MPI is a diagnosable failure
instead of a silent stop.

- **`openfoam_run_watch`** (new, 69th tool) — one blocking window over a run log:
  `run_id` or `log_path`, `timeout_s` (default 120, max 1800), `poll_s`. It returns
  the verdict (finished / failed / still running) with `time`, `endTime`, `steps`,
  `secondsPerStep`, ETA, and `reason` + `firstErrorLine` on failure. This is the
  answer to the real gap: `openfoam_run_solver_async` registers the run in the
  workbench registry, not as a DSH background job, so no completion event reaches
  the agent and nobody polls after the turn ends.
- **Status no longer contradicts the log.** `openfoam_solver_status` read
  `<id>.log` even when the run was started with `logName`, and required the *last*
  non-empty line to be exactly `End` — a `foamMultiRun` log ends `End`, a blank
  line, `Finalising parallel run`, so every finished CHT run was reported as
  `interrupted` while `solve_verify` said finished. The registry now follows the
  recorded log path, accepts `End` among the last six non-empty lines, reads
  `lastTime` from the last `Time = …` line (leading whitespace and the `s` suffix
  included), corrects a stale `interrupted` record to `success`, and reports
  `endTime`, `endTimeReached` and `logVerdict`.
- **`solve_verify` counted zero steps** on every indented parallel log: the counter
  required `Time` in column 0. Fixed in `lib/runtime.js` (`TIME_LINE`,
  `TIME_VALUE`), the same tolerant pattern the log parser already used.
- **`openfoam_dict_set` reaches into a block**: `entry: "PIMPLE/maxDeltaT"` (up to
  three levels) with the same `expect`, structure guard, journal and undo as a
  top-level key. `maxCo`/`maxDeltaT`/`minDeltaT` live in the `PIMPLE` sub-dictionary
  of the fluid region's `fvSolution` (`singleRegionSolutionControl::dict()` returns
  `mesh.solution().subDict("PIMPLE")`), so switching LTS on used to need an
  escalation and a manual edit. An appended key inherits its neighbours'
  indentation; a one-line block is rewritten in place.
- **A dead MPI rank is a pattern, not a mystery**: `diagnose_error` learned
  `mpirun noticed that process rank N … exited on signal 8` (plus `MPI_ABORT`). A
  chemistry crash prints no `FOAM FATAL` — the log only carries the signal — so
  the pattern names signals 8/9/11 and points at the step limits.
- **Skills**: `openfoam-case-builder` and `openfoam-cht` now say that a long run
  needs a watchdog (`openfoam_run_watch`, or a real background job) rather than
  hope; `openfoam-lts-ch` documents the two-clock decoupling (with `deltaT 0.1`
  and `maxDeltaT 1e-5` the gas advances 1e-5 per global step while the solid
  advances 0.1 — the flame cannot move, with no crash and no warning) and the two
  step limiters that are off by default (`alphaTemp`, `alphaY`).
- Tests: `test/runwatch.test.mjs` (7), `test/nested-dict.test.mjs` (7), and the
  tool count is 69 in `test/inventory.test.mjs` / `test/registry.test.mjs`.

## v0.9.38

The `0/` directory becomes something the agent can build instead of hand-edit, and
`field_stats` can answer "did it change".

- **`openfoam_fields_from_template`** — `0/` for a new mesh. When a case is
  remeshed, its `0/` files still hold one value per cell of the *old* mesh (the
  reacting CHT case that triggered this carries a 8352-value list in `CH4`, `T`,
  `O2`, `N2`); the solver then refuses to start, or `mapFields` maps values by
  index and silently produces different physics. The tool takes class,
  dimensions and `boundaryField` from a reference case (itself by default) and
  sets each `internalField` to one uniform value. It never invents a physical
  value: a per-cell list becomes `needsValue` with the most frequent entry as an
  explicit suggestion (`suggestion.share` says how much of the old mesh it
  covered), and `values: {"T": "300"}` accepts one. A boundary key that matches
  no patch of the new mesh is reported as `stalePatches`, so a rename is caught
  before the solver is. Preview by default, `.bak` on write; `lib/fieldwrite.js`,
  `test/fieldwrite.test.mjs`.
- **`openfoam_set_fields`** — initial composition, hot spot, seeded zone. Writes
  `system/[<region>/]setFieldsDict` (`defaultValues`, `zones` of type box /
  sphere / cylinder / set / …, `extrapolatePatches`) and can run `setFields
  [-region]`; every field is checked to exist in `0/` and to carry the right
  number of components first, because `setFields` silently sets nothing for a
  field that does not exist, and a box that misses the mesh is reported as a
  warning. Verified on the real CHT case: a 15 mm box at 450 K over a 300 K
  default, then `field_stats T` → 8352 cells, min 300, max 450.
- **`openfoam_field_stats` gained `time2`**: two written steps in one call,
  reporting each range and the change between them (`p` at 0 and 0.5 on a
  4-processor channel: 0/0 → 0.000282916/0.0452882).
- The always-on core gained two routing lines for the new tools (3 KB budget kept).

## v0.9.37

The tools that read a result no longer depend on a utility being able to build the
physics, and the camera stops rendering a plate as a line.

- **`openfoam_field_stats` reads the field files itself.** Min/max used to come
  from `foamPostProcess`, which fails on a reacting multi-region case
  (`reactionModel … available objects … are 0()`), writes
  `postProcessing/<region>/…` so it cannot touch a read-only case, and on a
  decomposed case silently reported the *serial* time directory (min 0, max 0 on a
  field that is not zero). The new reader (`lib/fields.js`) parses
  `internalField` in all four spellings and merges `processor*/` results, so it
  works on a read-only, decomposed or reacting case and writes nothing. An ASCII
  `uniform` internalField is expanded with the cell count from the mesh `owner`
  header, and a binary or oversized file falls back to the utility. `parallel`
  selects between `processor*/<time>/<field>` and `<time>/<field>` (default: on
  when `processor*` exist). Verified against the utility on a 4-processor case:
  identical min/max, while the serial utility answered 0/0 — the failure mode the
  field report hit is now impossible.
- **`openfoam_render` camera presets.** `view: "xy" | "xz" | "yz"` renders
  orthographically down the remaining axis and fits the frame — a 2.8 × 58.2 ×
  0.2 mm case was previously a 300 px strip. `view: "auto"` (default) chooses that
  preset when the mesh is a plate (smallest extent ≤ 2 % of the largest) and
  perspective otherwise, so `elevation=90` is no longer the only way to see a 2D
  case. `zoom` is documented as the multiplier of the camera distance after the
  fit (1 = whole mesh), and `azimuth`/`elevation`/`zoom` finally have parameter
  descriptions at all. Same `view` for `openfoam_compare_render`.
- **`skills/openfoam-cht`** now covers building the regions on org-14
  (`createZones` + `splitMeshRegions -cellZones all`, the quoted word list, the
  deprecated `-overwrite`) and post-processing per region (`foamToVTK` has no
  `-allRegions`, `surfaceFieldValue` reads `region <name>`, a solid has no `phi`).
- **New `skills/openfoam-lts-ch`** — LTS in the gas with a transient or steady
  solid: the three clocks (`deltaT`, `PIMPLE { maxCo; maxDeltaT }`, CFL), the
  `Using LTS` and `Flow time scale min/max` log lines, and the fatal
  `solid solver does not support LTS` / `keyword PIMPLE is undefined`.
- **`skills/openfoam-viz`** gained a camera section (presets, `zoom` semantics,
  what a one-pixel row means), and **`skills/openfoam-self-evolution`** now says to
  recall *before* planning even with an empty library.
- 215 tests.

## v0.9.36

A case that moves no fluid is now a finding, and the field report that produced
it is closed item by item.

- **`openfoam_flow_check`** (66th tool) — sums the boundary flux `phi` on every
  patch and compares it with what each velocity boundary condition intends. This
  is the failure no residual, convergence or mesh check can see: a 2D case whose
  inlet velocity points along the `empty` axis carries zero flux, continuity is
  then trivially satisfied, every residual falls to 0, the run reaches `End` and
  the temperature and heat-release fields still look physical.
  - Read-only: the flux is parsed out of the written `phi` field files, so no
    post-processing utility runs, no `postProcessing/` directory is written and a
    read-only case works. (On a reacting multi-region case `foamPostProcess`
    cannot build the physics at all — `reactionModel` and `objectRegistry region0`
    failures — so a utility-based probe was abandoned.)
  - Per patch: role from the `U` condition (`fixedValue`, `flowRateInletVelocity`
    vs `zeroGradient`, `inletOutlet`, `waveTransmissive`), area and mean normal
    velocity from the polyMesh, signed flux. Findings: `inlet-without-flux`
    (error), `no-flow-through-boundaries` (error), `outlet-without-flux` (warn),
    `mass-imbalance` (warn), `no-flow-boundaries` (info — a lid-driven cavity is
    not a problem). Decomposed cases are summed over `processor*/`.
- **Quoted arguments** — the run whitelist tokenizer now honours `'…'` and `"…"`,
  so `foamToVTK -fields '(T p)'`, `splitMeshRegions -cellZones 'fluid solid'` and
  `foamPostProcess -func "cellMax(U)"` pass one argument each instead of leaking
  the quotes to OpenFOAM ("invalid first character found : ''").
- **`mpirun` without `-parallel`** is refused with the reason ("every rank runs
  its own complete serial copy of the case and they overwrite each other").
- **Doctor: `vector-along-empty-axis`** — a vector field with a component along
  the one-cell-thick axis of a 2D mesh is an error before the solver starts.
- **`solve_verify` reads transient runs as transient**: a `ddtSchemes` entry of
  `Euler`/`backward` means the residual floor of the last step is not a
  convergence criterion, so the verdict is completion instead of `REVISE`.
  Species (`CH4`, `CO2`, …) no longer dominate the floor; the core fields do, and
  the reason names the worst field.
- **`clean`** learned `vtk` (`VTK/`, `vtk/`) and `runs` (`.openfoam-runs/`).

## v0.9.35

The README is a map again: 237 lines instead of 491, and the long parts moved to
`docs/` unchanged in substance.

- `docs/conventions.md` — the `<case-dir-name>.foam` entry file, relative paths and
  `caseRoots`, the geometry-scale gate, multi-region (CHT) behaviour, custom `.so`
  libraries (`libPaths` / `env` / `libbin`).
- `docs/write-policy.md` — the impact table and the `changeId` / `undo` contract.
- `docs/security.md` — what the gates do, what they do not cover,
  `enforceToolRouting` and the audited `openfoam_escalate` path.
- `docs/layout.md` — the file layout, `CORE.md` and the marketplace index.
- README now runs: what it is → install → update → configuration → what you get →
  tested on → screenshot → the details table → prior art. Install and update are the
  first thing a reader meets, and both are one version-less command.
- `docs/` ships in the npm tarball so the links work from an installed package.

## v0.9.34

Installing is one command that never mentions a version, and so is updating.

- `releases/latest/download/dsh-openfoam-workbench.tgz` — every release now carries
  a stable-named tarball next to the version-named one, so GitHub's "latest"
  alias resolves to a real file. Install and update are the same line, followed by
  a restart of the host that boots the profile.
- README: Install and Update rewritten around that line; tag / commit / checkout /
  market installs moved to a short table with the trade-off of each; the release
  page, `market/index.json` and `openfoam_env_check` named as the three places the
  version is written down.
- `scripts/release-upload.sh <tag>` packs and uploads both asset names, so a release
  cannot ship without the stable one; it prints the URL and checks that it resolves.
- README Layout refreshed (it still said 61 tools / 60 tests, and missed
  `client.js`, the routing and escalation modules, the scaffolds and the tools).

## v0.9.33

The ParaView entry file stays one file, and the doctor sees the other one.

- A case directory can carry a `case.foam` it inherited from a copy, or from a
  render helper an older build wrote into the case. The plugin only ever writes
  `<case-dir-name>.foam` (`ensureFoamFile`, every creating path) and only accepts
  that (`findFoamFile`), so the stray was invisible: it opens fine in ParaView and
  quietly survives every copy.
- `openfoam_check` now reports `stray-foam-file` (a `.foam` file that is not the
  case entry file, with the exact delete/rename fix) and `stale-render-script`
  (a leftover `.pv_render.py` from an older build).
- `openfoam_inspect_case` lists every `.foam` file in `foamFiles` and carries a
  hint naming the accepted one when a stray is present.
- The render script no longer has a hardcoded `case.foam` fallback: it derives the
  name from the case directory, and `openfoam_render` always passes the accepted
  name instead of `none`.
- 196 tests.

## v0.9.32

The mark reaches the skill rows.

- Skill rows, `Skill · openfoam-cht`, now carry the same mark in front of the
  name. A skill row exposes no name attribute CSS could match on — its root says
  only `data-tool="skill"` — so a small `MutationObserver` in `client.js` tags the
  rows whose summary is one of this bundle's `openfoam-*` skills with
  `data-ofw-skill` and removes the tag again when React reuses the node for
  another skill. Other plugins' skills keep their plain row.
- Still one `::before` rule, one mask, `currentColor`: the skill mark follows the
  row colour exactly like the tool mark, error state included.
- The mid guide line of the mark is thicker (`stroke-width` 25 instead of 15),
  from the redrawn `inline-icon.svg`.
- Repository hygiene: `openfoam_icon_colored.svg` (a byte-identical copy of
  `icon.svg`) and `inline-icon-backup.svg` are gone; `icon.svg` is the vector
  source and `inline-icon.svg` the row mark.
- 190 tests: a new behavioural test drives the observer (our row tagged, another
  plugin's not, a reused node untagged, attribute mutations ignored, cleanup).

## v0.9.31

Presentation, and the plugin icon.

- The tool row keeps the colour DSH gives it; the OpenFOAM mark in front of the
  name is an SVG **mask** painted with `currentColor`, so it follows the row
  (label colour, red on an error, both palettes) instead of introducing a second
  accent. The blue `#3b518c` / `#9db4e0` rules are gone.
- The mark now has three streamlines (the redrawn `inline-icon.svg`) and lives in
  the stylesheet as a 1.2 KB data URI, so `client.js` shrank from 17 KB to 4 KB.
- `scripts/make-icon-mask.mjs` regenerates the embedded mask from
  `inline-icon.svg` (`--check` fails when the two drift, and a test runs it).
- The plugin icon is the coloured flow drawing: `icon.png` is its 512x512 PNG
  export (the catalog accepts raster only) and `icon.svg` ships as the vector
  source for surfaces that take one.
- 189 tests.

## v0.9.30

The rest of the field report: patch keys, tutorial search, and the verdict of a
failed run.

- `openfoam_check` treats `boundaryField` keys as `wordRe` patterns, the way
  OpenFOAM does: `".*"`, `"(inlet|outlet)"` and `"wall.*"` no longer produce a
  false "no boundaryField entry" plus "no such patch" pair on a case that runs.
  A key that matches no patch is still an error, and a macro key (`$…`) withholds
  the coverage verdict instead of guessing. The coupled-BC-on-wall rule expands a
  key to the patches it covers.
- `openfoam_find_tutorial` splits the query into tokens and matches them against
  the case path **and** the text of `system/controlDict` (`application`, `solver`,
  `regionSolvers`, `fvModels`), so `cht multiRegion regionSolvers` finds
  `multiRegion/CHT/*`; results report which tokens matched and whether every
  token did (`matchedAll`).
- `openfoam_solve_verify` and `openfoam_run_progress` no longer print an ETA for
  a failed run: the state is `failed`, the decision `FAILED`, and the result
  carries `reason` (sigfpe/fatal/nan/segv/diverged) plus `firstErrorLine`
  `{line, text}` and a reason string quoting it. The org `sigFpe` startup banner
  is not mistaken for a failure.
- 187 tests (6 new).

## v0.9.29

Case libraries, and the environment a case needs to run (field report from an
AMR + viewFactor + CHT case: the tools could not load the case's own `.so`).

- `openfoam_run`, `openfoam_run_solver_async`, `openfoam_field_stats` and
  `openfoam_solver_build` accept `libPaths` and `env`. Only library locations are
  accepted (`LD_LIBRARY_PATH`, plus `FOAM_USER_LIBBIN` for a build); `LD_PRELOAD`,
  `LD_AUDIT` and `PATH` are refused, because they would let a call choose the
  code that runs.
- `openfoam_run_solver_async(logName=…)` names the run log without leaving the
  run registry, so `run_list`/`status`/`progress` still find it.
- `openfoam_solver_build(libbin=…)` installs into a directory the run can reach,
  and refuses up front with the resolved target when that directory is not
  writable instead of letting `wmake` fail with "Permission denied".
- `openfoam_check` gains `case-library-missing`: every `libs (...)` entry is
  resolved against `FOAM_LIBBIN`/`FOAM_USER_LIBBIN` and the
  `~/OpenFOAM/*/platforms/*/lib` trees; the finding names the directory that holds
  the library and the exact `libPaths` call.
- `openfoam_diagnose_error` recognises `dlopen error` / `Cannot open shared
  object file` / `Unknown fvMeshTopoChanger type` as a missing case library.
- `openfoam_field_stats` explains a `dlopen` failure instead of returning "no
  statistics parsed".
- 181 tests (7 new: the env whitelist, lib path merging, `logName` validation,
  `libs (...)` parsing, the library rule, the diagnosis).

## v0.9.28

npm distribution withdrawn.

- The registry is no longer part of the release: `package.json` is `private`
  again, `publishConfig` and `.github/workflows/publish.yml` are gone, and the
  README documents the git spec and the release tarball as the install paths.
- The three versions that had reached npm (`0.0.0-stage`, `0.9.26`, `0.9.27`) are
  **deprecated** with a message pointing at the git install; removing them
  outright needs a 2FA session (a bypass-2FA token may not unpublish), so it is
  left as a manual step if the account ever enrols a security key.
- Each release now carries `yakovlev-i-a-dsh-openfoam-workbench-<version>.tgz`,
  installable with `dsh plugin add <tarball-url>` — versioned without a registry.
- 174 tests.

## v0.9.27

- The npm account enables publishing only with proof of presence: the first
  attempt (web-login session, no 2FA) staged `0.9.26` and the staged version
  blocked republishing that number (`E409 Cannot publish over previously staged
  version`). `0.9.27` is the same content published with a granular access token
  that has `bypass_2fa`.
- 174 tests.

## v0.9.26

Packaging for distribution.

- `package.json`: `private` is now `false` with `publishConfig.access: public`, so
  the package can be published to npm as
  `@yakovlev-i-a/dsh-openfoam-workbench` (still `0.x`, as agreed).
- README documents all three install paths: a commit-pinned git spec, the npm
  package, and a local checkout.
- Repository metadata moved to the current state (65 tools) and the
  `dsh-plugin` topic is set for discovery.
- 174 tests.

## v0.9.25

`strict` routing with an audited exception path.

- **`enforceToolRouting: 'strict'`**: a `bash`/`write`/`edit` call that writes a
  case dictionary is refused with a message that names the plugin tool *and* the
  escalation call.
- **`openfoam_escalate({ target, operation, toolsTried, why, ttlMinutes })`**
  (65th tool) grants **one single-use token** for one target, valid 10 minutes.
  The request is verified against the call history: at least one named plugin
  tool must have been called **and failed** in the last 15 minutes, so the
  exception carries evidence instead of a claim. The hook consumes the token on
  the next matching write, so one escalation authorises exactly one write.
- **`escalationAuthority: 'auto' | 'ask'`** (default `auto`, as agreed for the
  first release): `auto` issues the token from the verified evidence, `ask`
  routes the decision to the DSH approval answerer and fails closed without it.
- `openfoam_usage_report` gains an `escalations` section (active, used, expired
  and the recent request/consume events), next to the `routing` section, so
  "which tools were tried, why it failed, what was let through" is an artifact.
- 174 tests (evidence verification, single use, TTL and target scoping,
  auto/ask authority, strict vs warn vs deny).

## v0.9.24

Steering the agent onto the plugin's tools, in layers.

- **New `enforceToolRouting` setting** (`off` / `warn` / `deny`, default `warn`).
  The plugin subscribes to DSH's `tools/pre-execute` waterfall and classifies
  every call: a `bash`/`write`/`edit` that writes a case dictionary
  (`system/`, `constant/`, `0/`, or a known dictionary file name) is a bypass.
  `warn` records it, `deny` returns a refusal naming the tool to use
  (`openfoam_dict_set`, `openfoam_read_dict`) so the change is classified,
  journaled and reversible.
- `openfoam_usage_report` now carries a `routing` section (bypass attempts with
  tool, target and decision), so "the work went through bash" is visible instead
  of inferred.
- `lib/routing-guard.js` is deliberately conservative: reads, `ls`, solver runs
  and the plugin's own tools are never flagged; the shell patterns are known to
  be evadable (printf/python indirection), which the README states plainly —
  the guard is a deterrent and a signal, the sandbox stays the boundary.
- 169 tests (routing classification, warn/deny/off modes, hook wiring).

## v0.9.23

Security review follow-up: the write gate and the run whitelist, again.

- **Braces are refused in a scalar value.** `value='{ } libs ("libevil.so")'`
  used to pass every check (one line, no `;`, balanced braces) and produced
  `writeInterval { } libs ("libevil.so");` as a *low* impact change — the line
  parser saw only `writeInterval` and the injected entry was invisible to the
  structural guard. Any `{`/`}` in a value is now an error by name.
- **Every `#` directive is critical.** `#includeEtc`/`#includeIfPresent`/
  `#includeFunc`/`#inputMode`/`#remove` were applied as low/high because the
  pattern used a trailing word boundary after `#include`; any `#word` token now
  forces approval (`#codeStream`, `#calc`, `#eval`, absolute includes, rewrites).
- **Structural invariant**: replacing one entry may not change the number of
  semicolons in the file (an append is exempt by design), on top of the existing
  top-level key comparison.
- **Argument whitelist**: `-case`, `-dict`, `-solver`, `-roots`, `-hostRoots`,
  `-libs` are refused in both `-x value` and `-x=value` forms.
- **`clean(force:true)` requires approval**: forcing past the case-marker guard is
  destructive and now fails closed without an answerer.
- `test/golden/work/` (generated runs, ~2.6 MB including a 49k-line mesh) is out
  of git and gitignored.
- Tests: 165, including regressions for each item above.

## v0.9.22

A clean com v2606 install fixed the segfaults, and com now passes the whole
golden matrix.

- The com crashes were **the local installation**, not the case or the plugin: a
  fresh `openfoam2606` from the official apt repository runs `rhoPimpleFoam` and
  `chtMultiRegionFoam` normally. `scripts/reinstall-com.sh` documents the purge +
  reinstall (the apt install ships no tutorials; `openfoam2606-tutorials` is a
  separate package).
- **Compressible golden `sphereBox` on both families**: org and com agree within
  ~0.1 % (`p` 99.88-100.07 kPa, `T.max` 300.036 K, `U.max` ~17.5 m/s), which also
  showed that the earlier org setup (separate `p`/`p_rgh` pair) over-pressurised
  the box; both families now use one `p` field with a wave-transmissive outlet.
- **CHT golden `sphereCht` on both families**: com gets its own mesh fixture
  (`sphereChtCom`, built by com's `splitMeshRegions`; the mapped-patch metadata is
  not portable), plus com-side dictionary requirements: solid `p` field,
  enthalpy solvers (`h`/`hFinal`), `heRhoThermo` keys, interface condition
  `compressible::turbulentTemperatureCoupledBaffleMixed`. Solid heats 300 ->
  313.1-313.9 K on com (org: 311.4-312.2 K), gas max 500 K on both.
- Only `pitzDaily` stays org-only, with the reason recorded (the apt install has
  no tutorials directory).
- 161 tests.

## v0.9.21

- **`openfoam_case_scaffold` family `compressible`**: family-aware rho-thermo
  (`hePsiThermo` + internal energy + `p`/`p_rgh` for org's `foamRun fluid`;
  `heRhoThermo` + enthalpy + `p` for com's `rhoPimpleFoam`), with the working
  scheme set (`div(phi,(p|rho))` vs `div(phi,h)`/`div(phid,p)`), `constant/g`,
  `pRef`, laminar transport, and the gas initialised at rest so the inlet drives
  the flow instead of an impulsive pressure wave.
- **Golden case `sphereBox`**: compressible gas around the sphere on the stored
  snappy mesh (17587 cells); QoI recorded on org 14. The values are regression
  references of this transient blocked-duct run, not a validated benchmark.
- **CHT scaffold is family-complete as far as the solvers allow**: interface
  temperature is `coupledTemperature` on org and
  `compressible::turbulentTemperatureCoupledBaffleMixed` (with `Tnbr`,
  `kappaMethod`, `sampleMode`) on com; com thermo keys (`Hf`, `heRhoThermo`,
  `constIso`/`hConst`) and a fixed-value inlet are used where com's dictionary
  API differs.
- Two com findings recorded, both build-level, not case-level:
  `rhoPimpleFoam` and `chtMultiRegionFoam` **segfault** in this com v2606
  installation (`dictionary::clone()`), and org's `mappedWall` interface
  metadata is not portable to com (needs a com-built fixture).
- 161 tests.

## v0.9.20

Golden cases start from **stored meshes**, and the tool surface stays at 64.

- `test/golden/meshes/` — two fixtures (gzipped `polyMesh`): `sphereFlow`
  (snappy: 100 mm cube minus 50 mm sphere, 17587 cells, level 1-2) and
  `sphereCht` (blockMesh + sphere cell zone + `splitMeshRegions`: 7448 fluid /
  552 solid). Both families read the same files, so a golden run is deterministic
  and takes seconds.
- `sphereCht` golden now copies the fixture and only generates dictionaries
  (`zero` mesh commands at run time); the runner reads `.gz` boundaries.
- **`openfoam_create_zone` removed** (the 65th tool): the golden path no longer
  needs it, the underlying commands (`createZones`, `topoSet`, `setsToZones`) are
  whitelisted, and a tool that only writes one small dictionary and calls a
  whitelisted command does not justify the extra surface. `caps.splitRegions`
  keeps the org/com difference as data.
- Verified: org runs `cavity`, `pitzDaily`, `sphereCht` green; com runs `cavity`
  green (skips carry their reasons).

## v0.9.19

Cell zones are now a capability, which is the step that unblocks multi-region
work on both families.

- **`caps.zoneTool`** (`createZones` on org, `topoSet` on com) and
  **`caps.splitRegions`** (`-cellZones all -defaultRegion fluid` vs
  `-cellZones -overwrite`), both probed from the installation.
- **New tool `openfoam_create_zone`**: carves one cell zone out of a single mesh
  from a sphere/box/cylinder, distribution-aware, writes the dictionaries the
  mechanism needs (com also needs `fvSchemes`/`fvSolution` placeholders before
  splitting). Verified: org `createZones` -> `solid`, com `topoSet`+`setsToZones`
  -> `solid`.
- **Golden recipe `sphereCht` is mechanism-agnostic**: `blockMesh` -> `zone` ->
  `splitMeshRegions`, all through the capability; org stays green.
- **CHT scaffold knows the com layout** as far as it is understood:
  `thermophysicalProperties`, `turbulenceProperties`, case-level `constant/g`,
  `heRhoThermo` + `sensibleEnthalpy` and `div(phi,h)`/`div(phid,p)` schemes for
  com; org keeps `hePsiThermo` + internal energy.
- Remaining com blocker, recorded with the exact reason: com injects per-region
  boundary conditions with `changeDictionary -region` from a shared `0.orig` and
  names the interface condition `turbulentTemperatureCoupledBaffleMixed`, so
  `coupledTemperature` is not accepted on a `mappedWall`.

## v0.9.18

The golden matrix is proven in CI, not just locally.

- `.github/workflows/golden.yml` runs on every push to main: docker images
  `dicehub/openfoam:14` and `dicehub/openfoam:opencfd-2606`, Node bootstrapped
  inside the image, installation located via `WM_PROJECT_DIR` or a glob/find
  fallback, containers started with `--user root --entrypoint bash` (the images
  ship a login-shell entrypoint and an unprivileged user).
- Verified in CI: org container finds `/home/openfoam/OpenFOAM-14` and runs
  `cavity`, `pitzDaily`, `sphereCht` — all ok; com container finds
  `/home/openfoam/OpenFOAM-2606`, runs `cavity` ok (identical QoI to org) and
  skips the other two with recorded reasons.
- `run-golden.mjs` exits 2 when a requested distribution is not installed
  (before, a missing installation made the run pass silently).
- Discovery also scans the home directories container images use.

## v0.9.17

Golden cases: stored reference quantities for real OpenFOAM runs.

- `test/golden/` — three cases with a recipe (`cases.mjs`): `cavity`
  (incompressible, both families), `pitzDaily` (compressible, org 14) and
  `sphereCht` (the sphere-in-box CHT case that the scaffold itself builds).
- `scripts/run-golden.mjs` — discovers installations, prepares/clones each case,
  runs mesh + solver, extracts the quantities (cells, non-orthogonality, field
  min/max, final time) and compares with `test/golden/expected/<distribution>.json`
  (`--update` re-blesses, a reviewed change).
- `test/golden-schema.test.mjs` — catches a broken expected file or a declared
  quantity without a value in the normal (OpenFOAM-free) test job.
- `.github/workflows/golden.yml` — the same script inside OpenFOAM containers,
  matrix `org` (dicehub/openfoam:14) and `com` (dicehub/openfoam:opencfd-2606).
- Verified locally: `org` runs all three cases green; `com` runs `cavity` green
  with **identical** QoI to org (0.344284, 0.0485151), `pitzDaily` is skipped
  with a recorded reason (rhoPimpleFoam segfaults in this com build) and
  `sphereCht` is skipped (com has no `createZones`; use topoSet + setsToZones).
- Fixed on the way: the incompressible scaffold wrote `simpleFoam` for transient
  cases (now `pimpleFoam`), the pressure reference was missing from the PIMPLE
  block, and a closed domain got no `pRefCell` in the algorithm actually used.

## v0.9.16

- **`openfoam_case_scaffold` with `family: "cht"`** writes a complete
  conjugate-heat-transfer case once the region meshes exist:
  - per-region `system/<r>/{fvSchemes,fvSolution}` and `constant/<r>/*`
    (fluid: `hePsiThermo` air + laminar momentum/thermophysical transport + `g`/`pRef`;
    solid: `heSolidThermo` with `{rho, Cv, kappa}` from the call), `0/<r>/*`;
  - `coupledTemperature` on the `<region>_to_<other>` interface patches and
    physical conditions on the outer walls/inlets/outlets, chosen from the
    patch roles of the region's own `polyMesh/boundary`;
  - org glue `system/regionSolvers` + `#includeIfPresent` controlDict for
    `foamMultiRun`; com glue `constant/regionProperties` + `chtMultiRegionFoam`;
  - the root `system/fvSolution` that `foamMultiRun` requires.
- Verified end to end on a fresh sphere-in-box case: `blockMesh` -> `createZones`
  -> `splitMeshRegions` -> scaffold -> `foamMultiRun` with **no manual edits**
  (solid 300 -> 311-312 K, gas 482-501 K over 0.02 s).
- Doctor: `coupledTemperature`/`coupledPressure`/... are known patch-field types,
  and region field findings name the field path with its region.
- 153 tests (CHT scaffold: org/com glue, interface BC placement, refusals).

## v0.9.15

The second live test — a conjugate-heat-transfer sphere-in-box (solid sphere
conducting heat, small `Cv` to heat fast) — plus the fixes it exposed.

- **`openfoam_field_stats` takes `region`**, so per-region extrema work in CHT
  cases (`-region solid`).
- **Doctor: multi-region field/patch consistency** (`checkRegionFieldPatches`):
  a `boundaryField` entry that names no patch of the region is a warning, a
  patch without an entry is an error, and a `coupled`/`mapped` condition on a
  plain wall patch is an error — the exact trap of `splitMeshRegions` naming
  interface patches `<region>_to_<other>` while templates still say `wall`.
- **Whitelist**: `createZones`, `foamSetupCHT`, `setsToZones`; the classic
  compressible solvers are spelled correctly now (`rhoPimpleFoam` was
  `rhopimpleFoam`, so it could never run).
- README states the targets explicitly: **org 14 and com v2606** are tested;
  other releases stay `partial`/`unknown` until added.

## v0.9.14

Version-capability layer, wired through the tools that generate content.

- **`lib/versions.js` v2**: one capability object per installation — `family`,
  `modular`, `support` (full/partial/unknown), `blockMeshScale`,
  `featuresUtility`/`featuresDict`/`featuresDictStyle`, `postProcess`,
  `fieldStats`, `transportFile`, `turbulenceFile`, `regionModel`, `zeroDir`.
  `probeCaps()` asks the installation itself (version + which utilities exist)
  and caches the result; `versionCaps()` gives the same object without probing.
- **`openfoam_mesh_plan`** is capability-driven: `scale` vs `convertToMeters`,
  snappy quality keys, and the feature dictionary the family expects
  (`surfaceFeaturesDict` on org, `surfaceFeatureExtractDict` on com). The result
  reports `caps` and an advisory on partial/unknown releases.
- **`openfoam_case_scaffold`** takes `caps`: modular (`foamRun` + `solver`) vs
  legacy (`simpleFoam`), `physicalProperties`/`momentumTransport` vs
  `transportProperties`/`turbulenceProperties`; org 9 now falls back to the
  legacy form instead of assuming the modular one.
- **`openfoam_check`** reports `caps` and adds an `untested-version` warning when
  the release is outside the support matrix.
- **`openfoam_env_check`/`openfoam_version_info`** return `caps` per
  distribution; README documents the support matrix and the capability model.
- Tests: capability matrix (org 14/9, com v2606/v2512), scaffold and mesh_plan
  conventions per capability, feature-dictionary naming.

## v0.9.13

All findings from the sphere-in-box live test (F1-F12), plus a first step towards
a version-capability layer.

- **`lib/versions.js`**: one capability object per installation (`family`, `modular`,
  `snappyQualityKeys`, `fieldStats`, `postProcess`, `features`, `thermoFile`,
  `turbulenceFile`, `regionModel`, `zeroDir`) from the distribution/version.
- **F1/F9** whitelist: `surfaceFeatureExtract`, `surfaceFeatures`, `foamPostProcess`.
  Parentheses are allowed in command arguments again (`-func cellMax(U)`); `;`,
  `|`, `&`, backticks, `$` and redirects stay forbidden.
- **F3** `mesh_plan` emits `errorReduction 0.75`, `nSmoothScale 4`, `maxIter 100`
  (org 14 aborted in the morphing phase without them).
- **F2** `mesh_plan` writes a placeholder `system/controlDict` when the case has
  none, so `blockMesh` can start; it says so in `notes` and never overwrites one.
- **F7** the doctor reports unknown `patchField` types (`unknown-bc-type`) and
  knows that `alphat*WallFunction` exists only as `compressible::...`.
- **F12** the doctor flags compressible cases without an energy-flux scheme, and
  `div(phi,e)` without the pressure-work term `div(phi,(p|rho))`.
- **F6** `no-nonortho-correctors` reads the algorithm the case actually uses
  (transient -> PIMPLE/PISO, steady -> SIMPLE).
- **F10** `openfoam_case_scaffold` takes `family` and refuses anything but
  incompressible-laminar instead of silently writing an incompressible case.
- **F11** patch roles use the `type` when given and know sphere/ball/obstacle/
  airfoil/blade/... names, so a sphere gets `noSlip`.
- **F8** new read-only `openfoam_field_stats` (min/max, magnitude) built on the
  distribution's `postProcess`/`foamPostProcess` and `cellMin`/`cellMax`.
- **F5** the geometry-scale gate ignores floating-point noise at the threshold.

## v0.9.12

- **Live approval verified end to end** on a real profile: `dict_set` on
  `controlDict.libs` requested approval with `{hasService, hasAgent, hasCallId}`
  all true, `allowed-once` applied the write, `rejected` left the file unchanged,
  and `openfoam_dict_undo` restored the previous value afterwards.
- The result carries the **actual** outcome (`allowed-once` / `rejected` /
  `cancelled` / `unavailable`) instead of a generic "refused".

## v0.9.11

- **The approval service is resolved when it is needed, not at mount time.** The
  `approval` service is mounted by the base bundle after this plugin, so
  `ctx.get('approval')` during `apply()` returned `undefined` and every critical
  change failed closed with "service is not mounted". The plugin now keeps a
  getter and resolves the service inside the tool call; the refusal also reports
  `approval: {hasService, hasAgent, hasCallId}` so a live smoke test shows
  exactly what is missing (on this host: agent ✓, callId ✓).

## v0.9.10

Security pass from the third audit: the write gate and the file layer.

- **No dictionary-entry injection**: `entry` must be a plain OpenFOAM key
  (`[A-Za-z_][A-Za-z0-9_.:]*`), and `value` must be a single line without `;`
  and with balanced braces. `value="50;\nlibs (\"...\")"` was previously
  written as a low-impact change and is now refused by name.
- **Executable directives are critical**: a value containing `#codeStream`,
  `#calc`, `#eval`, `#include` or `codeStream` requires approval regardless of
  the entry it is written to.
- **Path containment**: `containedPath()` refuses `..`, absolute paths and
  symlinks that leave the case, and `read_dict`/`dict_set`/`dict_undo` use it, so
  `system/../../outside.txt` is no longer readable or writable. Experience card
  ids are validated as slugs before deletion.
- **`clean` requires a case marker** (`system/controlDict`, `system/blockMeshDict`
  or `constant/polyMesh`); a directory named `2024` with `build.log` is no longer
  treated as a time directory unless `force: true`.
- **`commandAllowed` refuses context-changing arguments** (`-libs`, `-case`,
  `-roots`, `-hostRoots`), not just non-whitelisted applications.
- **Paper downloads are size-capped** (50 MB) and use the package version in the
  User-Agent.
- **Metadata**: the market index ru description is generated from the package
  description (it said 61 tools), the stray `.tmp-pack.json` is gone, and
  `.gitignore` covers files as well as directories.

## v0.9.9

Hotfix: the plugin failed to mount in a real DSH profile.

- `lib/index.js` read the optional approval service as `ctx.approval`, but the
  restricted Cordis context throws on any property that is not declared in
  `inject`, so `apply()` aborted with `cannot get property "approval" without
  inject` and the whole entry stayed inactive (no tools, no skills, no core
  section). The lookup now goes through `ctx.get('approval')`, which returns
  `undefined` when the service is absent.
- Regression test: `apply()` is mounted against a Proxy context that throws on
  every uninjected property; the tool set must still register.

## v0.9.8

Second reliability pass from the v0.9.7 audit.

- **TOCTOU guard**: the change is computed from a snapshot whose hash is kept;
  right before the journal and the write (i.e. after a possibly long approval
  wait) the file is re-read and compared, and a concurrent modification aborts
  the change instead of overwriting the newer content. The refusal tells the
  agent to re-read and prepare the edit again.
- **`undo` is depth-aware**: the top-level entry is removed only at brace depth
  0, so an identical `key ...;` inside a nested dictionary is left alone.
- **Strict `purgeWrite`**: only a literal zero (`0`, `0.0`, `00`) is low impact;
  `-1`, `abc` and an empty value are high. `runTimeModifiable` moved to high as
  well (it changes how dictionaries are re-read during a run).
- **Metadata**: `package.json` description now states 63 tools (the market index
  is regenerated from it), and two guards check the description count and the
  index description.
- Approval answers now report `approval: {outcome, hasAgent, hasCallId}` so the
  live smoke test can be verified without guessing.

## v0.9.7

Reliability release: no new tools, only the defects the v0.9.6 review found.

- **`purgeWrite` is value-aware**: `0` stays low impact, any value `> 0` is high
  impact (preview), because it deletes older time directories — a long run's
  history is not an organisational setting.
- **Approval is always required for `libs`/`functions`**; the `approvals` switch
  is gone (it never took effect and implied the protection was optional). A
  missing agent identity or a missing answerer refuses the change (fail-closed).
- **Sub-dictionaries are refused explicitly**: `dict_set` edits single-line
  top-level entries; `functions { ... }` now returns a named error instead of a
  confusing "entry not found", and the block is never half-edited.
- **Undo of an appended key removes the line** (`existedBefore` is recorded in
  the journal) instead of writing an empty value.
- **No file is written without a durable undo record**: the journal is written
  before the case file, and a failure aborts the change (the temp file and any
  journal entry are rolled back).
- **Release consistency**: the market index guard now verifies that the pinned
  commit really carries the indexed version, and the README intro tool count is
  checked against the status line and the registry.

## v0.9.6

- **Impact-based write policy** (`lib/impact.js`): the decision comes from the
  entry semantics, not the file. `controlDict` output keys apply; boundary and
  initial conditions, `fvSchemes`, `fvSolution`, `constant/*`, `deltaT` and
  `application` **preview** (`applied: false`, rendered as `NOT APPLIED`) until
  `apply: true`; `controlDict` `libs`/`functions` request user approval through
  the DSH `ctx.approval` seam and fail closed when it is not mounted.
  `writeMode: impact | apply | preview` (Settings) overrides it.
- **`expect`** refuses a write whose current value differs, and every applied
  change gets a `changeId` + `afterHash`.
- **`openfoam_dict_undo`** (63rd tool) reverts a change and refuses when the file
  changed after it, so a later edit is never silently discarded.
- CORE.md: a write tool answering `applied: false` has changed nothing - apply it
  or say so.
- Tests: classification (0/U and 0/Yi high, writeInterval low, deltaT high,
  unknown high, libs critical), mode overrides, expect, undo + stale undo, and
  approval allowed-once / rejected / missing-service fail-closed.

## v0.9.5

- **No shell string is built from paths or commands.** Every OpenFOAM call
  (`openfoam_run`, the async registry, `mesh_verify`, `stl_fit`, `wmake`,
  `solver_smoke`, `version_info`, `env_check`) now runs through one static
  script with the bashrc, working directory, log path and command passed as
  positional parameters / argv (`FOAM_RUN_SCRIPT`, `FOAM_LOG_SCRIPT`,
  `runFoam`, `spawnFoamLog`). A path containing `"`, `'`, `$()`, backticks,
  `;` or newlines can no longer become shell code; the whitelist also returns
  the parsed `argv` instead of a string to re-split.
- `set --` clears the positional parameters before sourcing: OpenFOAM's com
  `etc/bashrc` forwards `"$@"` into `etc/config.sh/setup`, so a non-empty list
  made the probe hang (this surfaced as a 30 s stall per distribution in
  `openfoam_env_check`).
- Child processes run with `stdin: ignore`.
- Security section in the README states explicitly that the plugin executes
  local commands as the OS user and is not a sandbox.
- Tests: injection regression suite (paths with `$()`, quotes, spaces,
  backticks; bashrc path with substitution; argv literalness; whitelist argv).

## v0.9.4

- **Iron rule 1 is no longer absolute.** "Every turn calls a tool" forced a tool
  call even for conceptual questions ("why does the pressure equation carry this
  correction?"), which produced theatre calls and less natural answers. It now
  splits the two cases: verify with a tool when the answer depends on the user's
  case, the installed OpenFOAM or a run result; answer a conceptual question
  directly, citing the source only when the version matters. Rule 3
  ("Check, don't guess") still pins the anti-hallucination side, and the routing
  table is unchanged.

## v0.9.3

- **Explicit `foamRoot` beats discovery.** Discovery filled `foamRoots` even when
  the profile set the legacy single `foamRoot`, and `rootFor` prefers
  `foamRoots[distribution]`, so a configured install was silently replaced by
  whatever was installed on the machine. Discovery now runs only when neither
  `foamRoot` nor `foamRoots` is configured. This is also why the v0.9.1 CI
  failure only reproduced without OpenFOAM installed. Regression test added.

## v0.9.2

- **CI fix**: `openfoam_list_solvers` treated `applications/modules` like
  `applications/solvers` and only accepted directories that hold `Make/files`.
  Module directories are solvers in their own right (org layout), so the tool
  now lists them directly and walks only `applications/solvers` and
  `applications/legacy` down to the `Make/files` level. Verified: org 42
  solvers, com 69 including `chtMultiRegionFoam`.

## v0.9.1

Second-review fixes (1-9 from the agreed list).

- **`limiter-wide-open` advice is legal**: OpenFOAM rejects `k > 1`
  (`should be >= 0 and <= 1`); the fix now says `limitedLinear 1` only, with the
  k in (0,1] scale stated.
- **`caseBBox` reads only the `vertices` block and applies `scale`**: a hex block
  resolution tuple `(30 10 10)` is no longer read as a vertex, so CHT and
  multi-block cases stop reporting a 30 m box and a false `geometry-scale` ask.
- **`closed-domain-no-pref`** recognises `waveTransmissive`, `fixedFluxPressure`,
  `prghPressure`, `advective`, `supersonicFreestream`, `pinnedValue` as pressure
  references (a transmissive outlet is not a closed domain).
- **`u-empty-patch`** is one finding per case listing all empty patches.
- **blockMesh vertex heuristics**: the wrong `block-vertex-mismatch` rule
  (`hexCount*8 > vertexCount`) is removed and `vertex-count` is advice, not an
  error (blocks share vertices).
- **`mesh_verify`/doctor problems** now include the threshold lines behind
  "Failed N mesh checks." (`faces with face pyramid volume < 2e-11: 10001`), so a
  failure no longer comes back with an empty problems list.
- **`list_solvers`** recurses `applications/{solvers,modules,legacy}` to the
  `Make/files` level; com now lists 69 solvers including `chtMultiRegionFoam`.
- **`resolvedFrom`** tracing on the path-bearing answers (inspect_case,
  case_probe_facts, check) - `{kind, root, input}`.
- **`openfoam_case_scaffold`** writes `case-manifest.json` (application,
  algorithm, distribution, compressible, phases, turbulence, patches) and its
  description states it writes no geometry; `paper_search` reports `degraded`
  when a source failed.

## v0.9.0

- **`openfoam_case_scaffold`**: a case can now be built from nothing. Writes
  `controlDict`, `fvSchemes`, `fvSolution`, the constant files and `0/U`, `0/p`
  for incompressible **laminar** flow (SIMPLE steady or PIMPLE transient),
  deriving the boundary conditions from the case's own patches (inlet/outlet/
  wall/empty/symmetry, with `pRefCell` for closed domains) and falling back to
  the `inlet/outlet/walls` set `mesh_plan` creates. Distribution-aware: org 14
  gets `application foamRun; solver incompressibleFluid;` plus
  `momentumTransport`/`physicalProperties`; com v2606 gets `application
  simpleFoam;` plus `turbulenceProperties`/`transportProperties`. Runs the doctor
  afterwards and returns its findings. Verified end to end on both: STL → mesh
  plan → blockMesh → solver → `End` (2.2 s per run).
- **`stl_generate` creates the case directory** instead of failing with
  "case not found", so the first step of a from-scratch build works.
- Turbulent/compressible/CHT requests are refused with a tutorial hint rather
  than guessed.
- README: a "Supported versions" matrix (org 14 vs com v2606) and an explicit
  statement that other branches are best effort.

## v0.8.1

- **`steps` describes the whole run.** On a log larger than `logTailBytes` the
  tools counted the tail window and reported it as the total (224 MB / 74 318
  steps came back as 1 331). `progressFrom` now takes a full-file count:
  `steps` is the run total, `stepsInWindow` is what the tail saw, and
  `logWindow.truncated` says the window was smaller. Counting costs ~0.25 s per
  90 MB (measured) and is bounded by a 4 s budget; `solve_verify` exposes the
  same fields next to `metrics.timeSteps`.

## v0.8.0

Fixes from the first external review (BFER series, ESI v2512) except the two
feature requests, which land in v0.9.0.

- **`limiter-wide-open` was inverted.** `limitedLinear k` computes
  `psi = clamp(2r/k, 0, 1)` (`limitedLinear.H`), so k -> 0 is the disabled
  limiter and k = 1 is the conservative default. The rule now warns only below
  0.1 and its advice no longer asks for a weaker scheme.
- **Run registry next to the case.** Records and logs go to
  `<case>/.openfoam-runs` (discovered across `caseRoots`), never into whatever
  `caseRoots[0]` happens to be; `runsDir` is a documented setting.
- **Log arguments.** `log_path` and `path` are interchangeable on
  `run_progress`, `solve_verify` and `residual_series`; a wrong name returns
  "log_path (alias: path) is required — got: ...", and "case not found" lists
  the searched roots.
- **`mesh_verify` verdict.** `failed` mirrors `pass`, and a checkMesh that
  cannot run now reports the OpenFOAM message in `problems`/`regions[].error`.
- **`0_orig`.** Initial fields are found in `0/`, `0.orig/` or `0_orig/` by
  inspect_case, case_probe_facts, the doctor and `restore0Dir`; `probe_facts`
  reads patch names from `polyMesh/boundary` (it used to disagree with
  inspect_case) and accepts `case_path`/`casePath`.
- **`read_source`** lists similarly named files and points at
  `openfoam_find_source` instead of a bare "not found".
- The four log tools now say which one to call (metrics vs progress vs verdict
  vs series).
- Release guard: a test fails when the README status line and `package.json`
  disagree, when the CHANGELOG lacks the current version, or when the package
  `files` list misses CHANGELOG/LICENSE/NOTICE/client.

## v0.7.0

Marketplace readiness.

- **CI**: `.github/workflows/tests.yml` runs the unit suite on Node 20/22/24 for
  every push and pull request (the suite is host-agnostic; host-dependent tests
  skip themselves).
- **Packaging**: `exports["./package.json"]` added (tools that resolve the
  manifest by subpath no longer fail), icon and client verified through a
  consumer-style resolution, `npm pack` ships 48 files / 243 KB.
- **Docs**: Requirements section, marketplace install path, a committed render
  as the README screenshot.
- **`scripts/make-market-index.mjs`** builds a format-1 index entry pinned to a
  commit (version, publishTimestamp, git source, engines, icon URL); a test runs
  it through the real `@deepseek-ai/dsh-plugin-market-index` validator and
  `marketInstallTarget`.

## v0.6.2

- **PNG plugin icon.** `icon.png` (512×512, 143 KiB) replaces `icon.svg`; the
  package export `./icon` points at it. DSH reads the icon as a base64 data URL
  and caps raw bytes at 256 KiB, so the 1254×1254 source was downscaled and
  re-encoded (PNG is explicitly supported alongside SVG/JPEG/WebP).

## v0.6.1

- **`needs_input` is language-neutral.** The payload now carries the decision
  (`kind`, numbers in `data`, stable option ids with English labels) and one
  English instruction for the model; the user-facing wording is the agent's job
  (CORE.md: ask in `{{language}}`, translate the labels). `lib/i18n.js` and the
  `responseLanguage` reads in `mesh_plan`/`check` are gone, so every future gate
  needs one template, not one per language. The registry renders
  `[<kind>] <ask>` + `id: label` options and still accepts the legacy
  `{question, options}` shape.

## v0.6.0

- **Settings page.** `lib/settings-schema.js` exports a native schemastery
  `Config` (resolved from the DSH installation, so the bundle stays
  dependency-free) with fields for `foamRoots`, `foamBashs`, `defaultDistribution`,
  `paraviewExe/Python`, `pythonPath`, `caseRoots`, `extraCommands`, `corePath`,
  `logTailBytes`, `scaleAskAbove` and `language`. Without the host library the
  export degrades to `undefined` and the plugin works as before.
- **One language for human-facing tool text.** `lib/i18n.js` holds the
  geometry-scale question/options template per language; `mesh_plan` and `check`
  now emit the same question in the resolved language (Russian and English
  shipped, others fall back to English). The Russian hardcode in `check` is gone.
- Tests: settings schema (native marker, a field for every default, graceful
  degradation) and language coverage for both gate call sites (79 total).

## v0.5.0

- **Zero-configuration installs.** `cordis.patch.yml` ships an empty config; the
  plugin discovers OpenFOAM installations (`/opt`, `/usr/lib/openfoam`,
  `/usr/local`, `~/OpenFOAM`, `$WM_PROJECT_DIR`) and ParaView (`/opt`
  directories, `PATH`). Explicit profile config still wins.
- **Configurable response language.** `language: ''` follows the OS locale
  (`LC_ALL`/`LC_MESSAGES`/`LANG`); `language: ru` (or any code/name) forces one.
  `CORE.md` carries a `{{language}}` placeholder resolved on every assembly, so
  the same file serves every language; `openfoam_env_check` reports the choice.
- `caseRoots: []` now warns in the config warnings instead of failing later.
- Discovery/language tests (5) and the machine-neutral patch guard.

## v0.4.4

- Web UI: the call summary of every `openfoam_*` tool row is blue
  (`#3b518c` light, `#9db4e0` dark) through the client half.

## v0.4.3

- Web UI: orange ring around `openfoam_*` rows and an orange tool name
  (replaced by the blue summary in v0.4.4).

## v0.4.2

- Browser half of the bundle (`client.js`, `dsh.client`) that styles
  `openfoam_*` tool rows.

## v0.4.0

- Region-aware doctor: `check` walks `system/<r>/`, `0/<r>/`, `constant/<r>/`,
  tags findings with their region and accepts `region=`.

## v0.3.9

- `<case-dir-name>.foam` is created on every case-creating path and is the only
  accepted ParaView entry file.
- Geometry-scale gate: `mesh_plan`/`check` ask the human (`needs_input`) when the
  bounding box exceeds `scaleAskAbove` (0.1 m).

## v0.3.8

- Dead-code removal, boundary-parser dedup, `restore0Dir` wired as a builtin.

## v0.3.7

- Tail-read logs (`logTailBytes`, 4 MB) and table renders for eight tools.

## v0.3.6

- com multi-region: `regionProperties` groups, `0.orig/` + `restore0Dir`,
  per-region renders.

## v0.3.5

- `openfoam-cht` skill and skills guard tests.

## v0.3.4

- Registration layer (`lib/registry.js`): strict schema, render wrapper,
  per-tool telemetry, `needs_input` question block.

## v0.3.0

- Multi-region (CHT) support, honest verifiers, tool routing, `openfoam_usage_report`.

## v0.2.0

- Bundle version in `env_check`/`version_info`; documented update flow.

## v0.1.0

- Initial prototype: case inspection, doctor, meshing, runs, renders.
