// Shell safety: paths and commands travel as argv, never as shell text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FOAM_LOG_SCRIPT, FOAM_RUN_SCRIPT, runFoam, startSolverRun } from '../lib/runtime.js'
import { commandAllowed } from '../lib/of-case.js'
import { apply } from '../lib/index.js'
import { forgetExperience } from '../lib/explib.js'

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-sec-'))
  return { root, marker: join(root, 'INJECTED') }
}

test('the shell scripts are static: no interpolation slots for values', () => {
  for (const script of [FOAM_RUN_SCRIPT, FOAM_LOG_SCRIPT]) {
    assert.match(script, /b="\$1"/, 'the bashrc comes from a positional parameter')
    assert.match(script, /d="\$2"/, 'the directory comes from a positional parameter')
    assert.match(script, /^set --$/m, 'positional parameters must be cleared before sourcing (OpenFOAM forwards "$@")')
    assert.doesNotMatch(script, /\$\{(b|d|l|log|dir|command|case)\}/, 'no value may be interpolated into the script')
    assert.match(script, /\$\{cmd\[@\]\}/, 'the command is an array expansion')
    assert.doesNotMatch(script, /openfoam-workbench\/\$/, 'the message text is static')
  }
})

test('a working directory with $(), quotes and spaces is passed verbatim', async () => {
  const { root, marker } = scratch()
  const dir = join(root, `case $(touch ${marker}) 'quoted' \`x\` ; &`)
  mkdirSync(dir, { recursive: true })
  try {
    const r = await runFoam(['/bin/pwd'], { bashrc: '/dev/null', dir })
    assert.equal(r.ok, true, r.stderr)
    assert.equal(r.stdout.trim(), dir, 'pwd must report the exact directory')
    assert.equal(existsSync(marker), false, 'the injected command must not run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('command arguments are quoted literally, not evaluated', async () => {
  const { root, marker } = scratch()
  try {
    const payload = `a$(touch ${marker})b`
    const r = await runFoam(['/bin/sh', '-c', 'printf %s "$1"', 'sh', payload], { bashrc: '/dev/null', dir: root })
    assert.equal(r.ok, true, r.stderr)
    assert.equal(r.stdout, payload, 'the argument must arrive as text')
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a bashrc path with command substitution is not executed', async () => {
  const { root, marker } = scratch()
  try {
    const r = await runFoam(['/bin/true'], { bashrc: `/nope/$(touch ${marker})/bashrc`, dir: root })
    assert.equal(r.ok, false)
    assert.equal(r.code, 97, 'a missing bashrc must fail with a named exit code')
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the async registry spawns with the same static script', async () => {
  const { root, marker } = scratch()
  const dir = join(root, `run $(touch ${marker})`)
  mkdirSync(dir, { recursive: true })
  try {
    const run = startSolverRun({ caseRoots: [root], runsDir: '' }, dir, ['/bin/true'], '/dev/null')
    assert.equal(run.command, '/bin/true')
    assert.deepEqual(run.argv, ['/bin/true'])
    // the spawn + log creation is asynchronous: poll instead of a fixed sleep
    for (let i = 0; i < 100 && !existsSync(run.log); i++) await new Promise((res) => setTimeout(res, 50))
    assert.equal(existsSync(marker), false, 'the injected command must not run')
    assert.ok(existsSync(run.log), 'the run log is created')
    assert.ok(run.log.includes(join(dir, '.openfoam-runs')), 'the log stays beside the case')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the whitelist rejects metacharacters and hands argv to the runner', () => {
  for (const bad of ['blockMesh; rm -rf /', 'blockMesh $(id)', 'blockMesh `id`', 'blockMesh && id', 'blockMesh\nrm']) {
    const r = commandAllowed(bad)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`)
  }
  const ok = commandAllowed('checkMesh -region fluid -allGeometry')
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.argv, ['checkMesh', '-region', 'fluid', '-allGeometry'])
  const mpi = commandAllowed('mpirun -np 4 foamRun -parallel')
  assert.equal(mpi.ok, true)
  assert.deepEqual(mpi.argv, ['mpirun', '-np', '4', 'foamRun', '-parallel'])
  // ranks without -parallel would each run the whole case serially
  assert.equal(commandAllowed('mpirun -np 4 foamRun').ok, false)
})

// --- dictionary editing: injection, executable directives, traversal ---------

function makeCase(root, name = 'caseA') {
  const dir = join(root, name)
  mkdirSync(join(dir, 'system'), { recursive: true })
  mkdirSync(join(dir, '0'), { recursive: true })
  writeFileSync(join(dir, 'system/controlDict'), 'application foamRun;\nwriteInterval 100;\n')
  writeFileSync(join(dir, '0/U'), 'internalField uniform (0 0 0);\nboundaryField { inlet { type fixedValue; value uniform (1 0 0); } }\n')
  return dir
}

function toolsFor(root, approval) {
  const tools = {}
  const ctx = {
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register(t) { tools[t.name] = t } },
    get(name) { return name === 'approval' ? approval : undefined },
  }
  apply(ctx, { caseRoots: [root] })
  return tools
}

test('a value cannot inject extra dictionary entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-inj-'))
  try {
    const dir = makeCase(root)
    const tools = toolsFor(root)
    const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '50;\nlibs (\"libevil.so\")' })
    assert.equal(r.ok, false)
    assert.match(r.error, /single line/)
    assert.equal(readFileSync(join(dir, 'system/controlDict'), 'utf8'), 'application foamRun;\nwriteInterval 100;\n')
    const semi = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '10; libs ("x")' })
    assert.equal(semi.ok, false)
    assert.match(semi.error, /must not contain ";"/)
    const bad = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval; libs', value: '1' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /invalid entry name/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an executable directive in the value is critical, not high', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-cs-'))
  try {
    const dir = makeCase(root)
    const tools = toolsFor(root) // no approval service, no agent identity
    const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: '0/U', entry: 'internalField', value: '#calc 1+1' })
    assert.equal(r.ok, false)
    assert.equal(r.impact, 'critical')
    assert.match(r.error, /approval/)
    assert.match(readFileSync(join(dir, '0/U'), 'utf8'), /uniform \(0 0 0\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('dictionary paths cannot escape the case directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-trav-'))
  try {
    makeCase(root)
    writeFileSync(join(root, 'outside.txt'), 'secret')
    const tools = toolsFor(root)
    for (const file of ['system/../../outside.txt', 'system/../../../etc/passwd']) {
      const read = await tools.openfoam_read_dict.execute({ casePath: 'caseA', file })
      assert.equal(read.ok, false)
      assert.match(read.error, /path traversal/)
      const write = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file, entry: 'x', value: '1' })
      assert.equal(write.ok, false)
      assert.match(write.error, /path traversal/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clean refuses a directory that is not an OpenFOAM case', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-clean-'))
  try {
    const dir = join(root, 'project')
    mkdirSync(join(dir, '2024'), { recursive: true })
    writeFileSync(join(dir, 'build.log'), 'x')
    const tools = toolsFor(root)
    const r = await tools.openfoam_clean.execute({ casePath: 'project', dryRun: false })
    assert.equal(r.ok, false)
    assert.match(r.error, /not an OpenFOAM case/)
    assert.ok(existsSync(join(dir, 'build.log')), 'nothing may be deleted')
    assert.ok(existsSync(join(dir, '2024')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('arguments that change the run context or load libraries are refused', () => {
  for (const cmd of ['foamRun -libs (x.so)', 'foamRun -case /tmp/other', 'simpleFoam -roots (..)', 'mpirun -np 2 foamRun -hostRoots (a b)']) {
    const r = commandAllowed(cmd)
    assert.equal(r.ok, false, cmd)
  }
})

test('experience cards cannot be deleted through a path', () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-exp-'))
  try {
    writeFileSync(join(root, 'victim.json'), 'x')
    for (const id of ['../victim', 'a/b', '..', '/etc/passwd']) {
      const r = forgetExperience({ experienceDir: root }, id)
      assert.equal(r.ok, false, id)
      assert.match(r.error, /invalid card id/)
    }
    assert.ok(existsSync(join(root, 'victim.json')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the meshing and post-processing utilities the plugin needs are whitelisted', () => {
  for (const cmd of ['surfaceFeatureExtract', 'surfaceFeatures', 'foamPostProcess -func cellMax(U)']) {
    assert.equal(commandAllowed(cmd).ok, true, cmd)
  }
})

test('a value cannot smuggle an entry through braces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-brace-'))
  try {
    const dir = makeCase(root)
    const tools = toolsFor(root)
    for (const value of ['{ } libs ("libevil.so")', '{}', '{ x }']) {
      const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value })
      assert.equal(r.ok, false, value)
      assert.match(r.error, /braces are not allowed/)
      assert.equal(readFileSync(join(dir, 'system/controlDict'), 'utf8'), 'application foamRun;\nwriteInterval 100;\n')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every dictionary directive is critical, not just #calc', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-directive-'))
  try {
    makeCase(root)
    const tools = toolsFor(root) // no approval service: critical must refuse
    for (const value of ['#includeEtc "caseDicts/setConstraintTypes"', '#includeIfPresent "/etc/passwd"', '#includeFunc patchAverage', '#remove writeInterval', '#inputMode merge']) {
      const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value, apply: true })
      assert.equal(r.ok, false, value)
      assert.equal(r.impact, 'critical', value)
      assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /writeInterval 100;/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('arguments that swap the case, dictionary or solver are refused in both forms', () => {
  for (const cmd of ['foamRun -case=/tmp/x', 'postProcess -dict /etc/passwd', 'foamRun -solver whatever', 'simpleFoam -roots=/tmp', 'foamRun -dict=system/fvSchemes']) {
    const r = commandAllowed(cmd)
    assert.equal(r.ok, false, cmd)
  }
})

test('clean with force:true needs approval and fails closed without it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-clean-force-'))
  try {
    const dir = join(root, 'project')
    mkdirSync(join(dir, '2024'), { recursive: true })
    writeFileSync(join(dir, 'build.log'), 'x')
    const tools = toolsFor(root)
    const r = await tools.openfoam_clean.execute({ casePath: 'project', dryRun: false, force: true })
    assert.equal(r.ok, false)
    assert.match(r.error, /approval/)
    assert.equal(r.approval.hasService, false)
    assert.ok(existsSync(join(dir, 'build.log')), 'nothing may be deleted without approval')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
