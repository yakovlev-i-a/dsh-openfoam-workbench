// dsh-openfoam-workbench — OpenFOAM domain layer for DeepSeek Harness.
//
// The entry point only composes: the core prompt (CORE.md), the bundled skills
// and the tool groups. Everything else lives in focused modules:
//
//   lib/runtime.js      process/paths/runs helpers + config defaults (deps)
//   lib/knowledge.js    solver classification + error patterns + diagnosis
//   lib/presentation.js pvpython renders, inline images, tool-call cards, tables
//   lib/registry.js     the registration choke point: render, schema, telemetry, safety
//   lib/core.js         the always-on prompt section, sourced from CORE.md
//   lib/skills.js       reads skills/*/SKILL.md and registers them
//   lib/of-engine.js    dictionary parser + doctor checks (MIT, from dsh-openfoam-doctor)
//   lib/of-case.js      multi-region model, dict paths, command whitelist, progress
//   lib/tools/*.js      one factory per tool group: ({ cfg, attachImage }) => tools
import { DEFAULTS, reconcileAll, validateConfig } from './runtime.js'
import { mountCore } from './core.js'
import { mountSkills } from './skills.js'
import { makePresentation } from './presentation.js'
import { makeRegistry } from './registry.js'
import { discoverFoamRoots, discoverParaview, discoverPython, resolveLanguage } from './discover.js'
import envTools from './tools/env.js'
import caseTools from './tools/case.js'
import runTools from './tools/run.js'
import buildTools from './tools/build.js'
import meshTools from './tools/mesh.js'
import renderTools from './tools/render.js'
import paperTools from './tools/papers.js'
import experienceTools from './tools/experience.js'
import metaTools from './tools/meta.js'

export { Config } from './settings-schema.js'

export const name = 'openfoam-workbench'
export const inject = ['tools', 'systemPrompt', 'skills']

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  // Zero-configuration installs: find the machine's OpenFOAM and ParaView when
  // the profile does not name them. Explicit configuration always wins, so a
  // profile that sets foamRoots/paraview* is untouched.
  // An explicit legacy `foamRoot` also counts as configuration: discovery must
  // not replace it with whatever else is installed on the machine.
  if (!cfg.foamRoot && !Object.keys(cfg.foamRoots || {}).length) {
    const found = discoverFoamRoots()
    if (Object.keys(found.foamRoots).length) {
      cfg.foamRoots = found.foamRoots
      if (!cfg.defaultDistribution) cfg.defaultDistribution = found.defaultDistribution
      console.log('[openfoam-workbench] discovered OpenFOAM: ' + Object.entries(found.foamRoots).map(([k, v]) => k + '=' + v).join(', '))
    }
  }
  if (!cfg.paraviewPython || !cfg.paraviewExe) {
    const pv = discoverParaview()
    if (!cfg.paraviewPython && pv.paraviewPython) cfg.paraviewPython = pv.paraviewPython
    if (!cfg.paraviewExe && pv.paraviewExe) cfg.paraviewExe = pv.paraviewExe
  }
  if (!cfg.pythonPath) cfg.pythonPath = discoverPython()
  cfg.responseLanguage = resolveLanguage(cfg)

  const configWarnings = validateConfig(cfg)
  if (!Array.isArray(cfg.caseRoots) || !cfg.caseRoots.length) {
    configWarnings.push('caseRoots is empty: relative case paths resolve from ' + process.cwd() + ' (set caseRoots in the profile patch to pin a workspace)')
  }
  if (configWarnings.length) console.warn('[openfoam-workbench] config warnings:\n ' + configWarnings.join('\n '))
  try { reconcileAll(cfg) } catch (e) { /* registry may be unwritable */ }

  mountCore(ctx, cfg)
  mountSkills(ctx)

  const presentation = makePresentation(ctx)
  const registry = makeRegistry(ctx, { RENDERS: presentation.RENDERS })
  const approval = ctx.approval || (typeof ctx.get === 'function' ? ctx.get('approval') : undefined)
  const deps = { cfg, attachImage: presentation.attachImage, registry, approval }
  const factories = [
    envTools, caseTools, runTools, buildTools, meshTools,
    renderTools, paperTools, experienceTools, metaTools,
  ]
  for (const factory of factories) {
    for (const tool of factory(deps)) registry.register(tool)
  }
}
