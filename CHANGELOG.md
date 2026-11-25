# Changelog

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
