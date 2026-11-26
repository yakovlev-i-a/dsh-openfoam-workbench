# Changelog

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
