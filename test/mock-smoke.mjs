// Mock-context smoke test: apply the plugin with a fake ctx and call tools
// directly, so batches can be validated without restarting the host.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const tmp = join(here, '.tmp')
mkdirSync(tmp, { recursive: true })
writeFileSync(join(tmp, 'run.log'), 'Time = 1\nsolving for Ux, Initial residual = 1e-06, Final residual = 1e-09, No Iterations 2\nTime = 2\nsolving for Ux, Initial residual = 1e-07, Final residual = 1e-10, No Iterations 2\nEnd\n')

const FOAM = process.env.FOAM_ROOT || '/opt/openfoam14'
const CASES = process.env.CASES || '/media/yakovlev-i-a/adata-legend-512/openfoam-dev'

const tools = {}
apply(
  { systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(d) { tools[d.name] = d } } },
  { foamRoot: FOAM, openfoamBash: join(FOAM, 'etc/bashrc'), caseRoots: [CASES], experienceDir: join(here, '.tmp', 'experience') },
)

const run = async (name, args) => ({ name, ...(await tools[name].execute(args)) })

const results = []

// Batch 4a
results.push(await run('openfoam_compute_first_layer', { U_ref: 10, L_ref: 1 }))
results.push(await run('openfoam_patch_diff', { casePath: 'kineticTheoryTransport/validation' }))
results.push(await run('openfoam_mesh_box_stl', { casePath: tmp, bbox_min: [-1, -1, -1], bbox_max: [1, 1, 1], name: 'box' }))
results.push(await run('openfoam_stl_inspect', { stl_path: join(tmp, 'constant/triSurface/box.stl') }))

// Batch 4b
results.push(await run('openfoam_stl_generate', { casePath: tmp, name: 'sphere', shape: 'sphere', params: { r: 0.5, segments: 16, rings: 8 } }))
results.push(
  await run('openfoam_mesh_plan', {
    casePath: tmp,
    stl_path: join(tmp, 'constant/triSurface/sphere.stl'),
    domain: { type: 'external', upstream: 3, downstream: 5, lateral: 3, vertical_top: 3, vertical_bottom: 3 },
    target_cell_size: 0.2,
  }),
)
results.push(await run('openfoam_mesh_verify', { casePath: 'kineticTheoryTransport/validation' }))

// Batch 5
results.push(await run('openfoam_diagnose_error', { text: '--> FOAM FATAL ERROR: Floating point exception (FPE) at t=0.1 for U' }))
results.push(await run('openfoam_case_probe_facts', { case_path: 'kineticTheoryTransport/validation' }))
results.push(await run('openfoam_algo_extract_contract', { source_file: '/opt/openfoam14/applications/legacy/incompressible/icoFoam/icoFoam.C', algorithm_name: 'icoFoam-main' }))
results.push(
  await run('openfoam_algo_case_audit', {
    contract: { assumes: { compressible: false, phases: 1, turbulence: 'laminar' }, governing_type: 'incompressible single-phase', outputs: [{ name: 'U' }] },
    case_facts: { compressible: true, phases: 2, turbulence: 'kEpsilon', governing: 'VOF two-phase', fields_in_0: ['U', 'p'] },
  }),
)
results.push(await run('openfoam_experience_save', { title: 'Box mesh quick check', domain: 'general', triggers: ['box', 'blockmesh'], recipe: ['write box stl', 'plan', 'blockMesh'] }))
results.push(await run('openfoam_experience_recall', { query: 'box blockMesh external flow' }))
results.push(await run('openfoam_experience_list', {}))

// Batch 6
results.push(await run('openfoam_geom_verify', { stl_path: join(tmp, 'constant/triSurface/box.stl') }))
results.push(await run('openfoam_solve_verify', { log_path: join(tmp, 'run.log') }))
results.push(await run('openfoam_paper_param_verify', { params: { U_in: 1.5, nu: 1.5e-5, T: 300 }, expected_units: { U_in: 'm/s', nu: 'm2/s' } }))
results.push(await run('openfoam_render', { case_path: tmp }))

// Batch 7
const pdf = '/media/yakovlev-i-a/adata-legend-512/openfoam-dev/lowMachMulticomponentFluid/hassanalyMinimallydissipativeLowMachNumber2018.pdf'
results.push(await run('openfoam_read_document', { path: pdf }))
results.push(await run('openfoam_read_paper', { path: pdf, focus: 'dissipation' }))
results.push(await run('openfoam_paper_extract', { path: pdf }))
results.push(await run('openfoam_paper_search', { query: 'k-omega SST turbulence', top_k: 3 }))

for (const r of results) {
  console.log('===', r.name, '===')
  const s = JSON.stringify(r, null, 2)
  console.log(s.length > 3500 ? s.slice(0, 3500) + '\n… (truncated)' : s)
}
