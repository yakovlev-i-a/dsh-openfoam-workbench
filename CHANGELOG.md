# Changelog

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
