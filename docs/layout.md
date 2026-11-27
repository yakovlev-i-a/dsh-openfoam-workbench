# Docs and layout

## CORE.md and the marketplace index

- [CORE.md](./CORE.md) — the always-on core prompt, read at runtime (the section
  text is a function, re-evaluated on every model step), so editing it changes the
  agent on the next message without restarting DSH. A test fails if it grows past
  3 KB or loses a routing marker. `{{language}}` is filled from the `language`
  config or the OS locale, so one file serves every language. The iron rules
  separate *verifiable facts* (the case, the installed OpenFOAM, a run result —
  check with a tool) from *conceptual answers* (answer directly, cite the source
  when the version matters), so the agent does not call a tool just to satisfy a
  rule.
- [NOTICE](./NOTICE) / [LICENSE](./LICENSE) — attribution (Apache-2.0 + MIT).
- [market/index.json](./market/index.json) — format-1 marketplace index pinned to a
  release commit (`node scripts/make-market-index.mjs --commit <sha>`); host it over
  https and add that URL in Discover.

## File layout

```text
lib/index.js        entry: mounts core + skills + tool groups
lib/core.js         always-on prompt section, re-read from CORE.md
lib/runtime.js      process/paths/runs helpers + the LD_LIBRARY_PATH gate
lib/discover.js     finds OpenFOAM/ParaView installs and probes capabilities
lib/versions.js     capability layer: feature detection, not version tables
lib/registry.js     registration choke point: render, schema, telemetry, safety
lib/presentation.js pvpython renders, inline images, cards, tables
lib/impact.js       write-impact classification for dict_set
lib/routing-guard.js  reads Bash calls that bypass the plugin's own tools
lib/escalations.js  short-lived audited exceptions to that policy
lib/of-engine.js    dict parser + 31 silent-failure rules (MIT, see below)
lib/of-case.js      multi-region model: regions, dict paths, whitelist, progress
lib/flowcheck.js    boundary flux read from the written phi files (flux check, empty axis)
lib/fields.js       field min/max read from the written field files (no utility)
lib/scaffold*.js    dictionaries for incompressible / compressible / CHT cases
lib/meshlib.js      STL helpers + blockMesh/snappy plan writer
lib/caselib.js      four-step contract extraction, case facts, contract audit
lib/buildlib.js     Make/files parsing + first compiler error
lib/knowledge.js    solver classification + error patterns + diagnosis
lib/paperlib.js     PDF/paper extraction helpers
lib/explib.js       experience cards + learned error patterns
lib/settings-schema.js  native schemastery Config for Settings → Plugins
lib/tools/*.js      one factory per group (65 tools)
client.js           browser half: the mark on tool and skill rows
skills/  test/  scripts/  locale/   SKILL.md × 11 · 196 tests · release+golden · en/ru
inline-icon.svg     source of the row mark (make-icon-mask.mjs inlines it)
icon.png / icon.svg plugin icon: 512×512 PNG for the catalog, vector source
test/golden/        cases, expected values and stored meshes
```
