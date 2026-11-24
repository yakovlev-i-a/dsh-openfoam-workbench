// dsh-openfoam-workbench — OpenFOAM domain layer for DeepSeek Harness.
//
// The entry point only composes: the core prompt (CORE.md), the bundled skills
// and the tool groups. Everything else lives in focused modules:
//
//   lib/runtime.js      process/paths/runs helpers + config defaults (deps)
//   lib/knowledge.js    solver classification + error patterns + diagnosis
//   lib/presentation.js pvpython renders, inline images, tool-call cards, tables
//   lib/telemetry.js    usage counters + the reg() wrapper (render/presentCall)
//   lib/core.js         the always-on prompt section, sourced from CORE.md
//   lib/skills.js       reads skills/*/SKILL.md and registers them
//   lib/of-engine.js    dictionary parser + doctor checks (MIT, from dsh-openfoam-doctor)
//   lib/of-case.js      multi-region model, dict paths, command whitelist, progress
//   lib/tools/*.js      one factory per tool group: ({ cfg, attachImage }) => tools
import { DEFAULTS, reconcileAll, validateConfig } from './runtime.js'
import { mountCore } from './core.js'
import { mountSkills } from './skills.js'
import { makePresentation } from './presentation.js'
import { makeRegister } from './telemetry.js'
import envTools from './tools/env.js'
import caseTools from './tools/case.js'
import runTools from './tools/run.js'
import buildTools from './tools/build.js'
import meshTools from './tools/mesh.js'
import renderTools from './tools/render.js'
import paperTools from './tools/papers.js'
import experienceTools from './tools/experience.js'
import metaTools from './tools/meta.js'

export const name = 'openfoam-workbench'
export const inject = ['tools', 'systemPrompt', 'skills']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const configWarnings = validateConfig(cfg)
  if (configWarnings.length) console.warn('[openfoam-workbench] config warnings:\n ' + configWarnings.join('\n '))
  try { reconcileAll(cfg) } catch (e) { /* registry may be unwritable */ }

  mountCore(ctx, cfg)
  mountSkills(ctx)

  const presentation = makePresentation(ctx)
  const reg = makeRegister(ctx, presentation)
  const deps = { cfg, attachImage: presentation.attachImage }
  const factories = [
    envTools, caseTools, runTools, buildTools, meshTools,
    renderTools, paperTools, experienceTools, metaTools,
  ]
  for (const factory of factories) {
    for (const tool of factory(deps)) reg(tool)
  }
}
