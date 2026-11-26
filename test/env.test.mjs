// The environment a tool call may add: only library locations, and only in the
// shape the launcher can prepend to LD_LIBRARY_PATH. Everything else is refused,
// because LD_PRELOAD/PATH would let a call choose the code that runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foamEnv, safeLogName } from '../lib/runtime.js'
import { caseLibNames, checkCaseLibs } from '../lib/of-engine.js'
import { diagnoseError } from '../lib/knowledge.js'

test('only library locations pass, and the refusal names the reason', () => {
  assert.equal(foamEnv({ env: { LD_PRELOAD: '/tmp/x.so' } }).ok, false)
  assert.match(foamEnv({ env: { LD_PRELOAD: '/tmp/x.so' } }).error, /arbitrary code/)
  for (const key of ['PATH', 'LD_AUDIT', 'BASH_ENV', 'LD_DEBUG']) {
    assert.equal(foamEnv({ env: { [key]: '/tmp' } }).ok, false, key + ' must be refused')
  }
  assert.equal(foamEnv({ env: { SOMETHING_ELSE: '1' } }).ok, false)
  assert.equal(foamEnv({ env: { LD_LIBRARY_PATH: 'relative/dir' } }).ok, false)
  assert.equal(foamEnv({ env: { LD_LIBRARY_PATH: '/a\n/b' } }).ok, false)
  assert.equal(foamEnv({ libPaths: ['rel/dir'] }).ok, false)
  assert.equal(foamEnv({ libPaths: 'not-an-array' }).ok, false)
})

test('libPaths and env merge in the caller order, deduped', () => {
  const e = foamEnv({ libPaths: ['/tmp/libs', '/opt/x'], env: { LD_LIBRARY_PATH: '/a:/tmp/libs' } })
  assert.equal(e.ok, true)
  assert.equal(e.extraLibPath, '/tmp/libs:/opt/x:/a')
  assert.deepEqual(e.libPaths, ['/tmp/libs', '/opt/x', '/a'])
})

test('FOAM_USER_LIBBIN is a build-only key', () => {
  assert.equal(foamEnv({ env: { FOAM_USER_LIBBIN: '/tmp/lib' } }).ok, false)
  const build = foamEnv({ env: { FOAM_USER_LIBBIN: '/tmp/lib' }, build: true })
  assert.equal(build.ok, true)
  assert.equal(build.userLibbin, '/tmp/lib')
})

test('a caller-chosen log name stays a plain file name', () => {
  assert.equal(safeLogName('run2'), 'run2.log')
  assert.equal(safeLogName('log.run2'), 'log.run2.log')
  assert.equal(safeLogName('log.run2.log'), 'log.run2.log')
  for (const bad of ['../x', 'a/b', '.hidden', '', 'with space', '-rf']) {
    assert.equal(safeLogName(bad), null, JSON.stringify(bad) + ' must be refused')
  }
})

test('libs (...) is read in both spellings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'libs-'))
  mkdirSync(join(dir, 'system'), { recursive: true })
  const write = (body) => writeFileSync(join(dir, 'system/controlDict'), 'FoamFile { version 2.0; }\n' + body)
  write('libs ("libA.so" B);\n')
  assert.deepEqual(caseLibNames(dir), ['libA.so', 'B'])
  write('application icoFoam;\n')
  assert.deepEqual(caseLibNames(dir), [])
})

test('checkCaseLibs resolves, reports the directory that holds the library, and stays silent without a probe', () => {
  const caseDir = mkdtempSync(join(tmpdir(), 'case-'))
  const libDir = mkdtempSync(join(tmpdir(), 'myfoam-'))
  mkdirSync(join(caseDir, 'system'), { recursive: true })
  writeFileSync(join(caseDir, 'system/controlDict'), 'FoamFile { version 2.0; }\nlibs ("libamrTopoChanger.so");\n')
  writeFileSync(join(libDir, 'libamrTopoChanger.so'), '')

  assert.equal(checkCaseLibs(caseDir, {}).length, 0, 'no probe directories means no claim')

  const missing = checkCaseLibs(caseDir, { libDirs: ['/opt/openfoam14/platforms/linux64GccDPInt32Opt/lib'], searchDirs: [libDir] })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].rule, 'case-library-missing')
  assert.equal(missing[0].severity, 'error')
  assert.match(missing[0].title, /libamrTopoChanger\.so/)
  assert.ok(missing[0].detail.includes(libDir), 'the detail names the directory that holds it')
  assert.ok(missing[0].fix.includes(libDir), 'the fix quotes a libPaths call with that directory')

  assert.equal(checkCaseLibs(caseDir, { libDirs: [libDir] }).length, 0)
})

test('a dlopen failure is diagnosed as a missing case library', () => {
  const r = diagnoseError({}, 'dlopen error : libamrTopoChanger.so: cannot open shared object file\nFOAM FATAL IO ERROR: Unknown fvMeshTopoChanger type amr')
  assert.equal(r.ok, true)
  const hit = r.hits.find((m) => /library of the case/.test(m.category))
  assert.ok(hit, 'the dlopen pattern must match')
  assert.match(hit.next_steps.join(' '), /libPaths/)
})
