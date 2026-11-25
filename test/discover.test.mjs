// Zero-configuration installs: discovery must find real layouts and never
// invent paths, and the shipped patch must stay machine-neutral.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyInstall, discoverFoamRoots, discoverParaview, resolveLanguage } from '../lib/discover.js'

function makeInstall(root, name, { bashrc = 'etc/bashrc' } = {}) {
  const dir = join(root, name)
  mkdirSync(join(dir, '..', 'etc'), { recursive: true })
  if (bashrc) {
    mkdirSync(join(dir, 'etc'), { recursive: true })
    writeFileSync(join(dir, 'etc', 'bashrc'), '# stub\n')
  }
  return dir
}

test('install names map to org/com flavours and versions', () => {
  assert.deepEqual(classifyInstall('/opt/openfoam14'), { kind: 'org', version: '14' })
  assert.deepEqual(classifyInstall('/usr/lib/openfoam/openfoam2606'), { kind: 'com', version: 'v2606' })
  assert.deepEqual(classifyInstall('/opt/OpenFOAM-v2312'), { kind: 'com', version: 'v2312' })
  assert.deepEqual(classifyInstall('/home/u/OpenFOAM/openfoam2606-multicomponent-wang'), { kind: 'com', version: 'v2606' })
})

test('discovery only returns directories that carry etc/bashrc', () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-discover-'))
  try {
    makeInstall(root, 'openfoam14')
    makeInstall(root, 'openfoam2606')
    mkdirSync(join(root, 'openfoam99'), { recursive: true }) // no bashrc: not an install
    const found = discoverFoamRoots([root])
    // the fake parent is scanned together with the real ones; filter to ours
    const mine = Object.entries(found.foamRoots).filter(([, dir]) => dir.startsWith(root))
    assert.equal(mine.length, 2, JSON.stringify(found.foamRoots))
    const kinds = mine.map(([, dir]) => classifyInstall(dir).kind).sort()
    assert.deepEqual(kinds, ['com', 'org'])
    assert.ok(!Object.values(found.foamRoots).some((d) => d.endsWith('openfoam99')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ParaView is found in a versioned directory or on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-pv-'))
  try {
    const bin = join(root, 'paraview-6.2', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'pvpython'), '#!/bin/sh\n')
    writeFileSync(join(bin, 'paraview'), '#!/bin/sh\n')
    const found = discoverParaview([], '', { parents: [root] })
    assert.equal(found.paraviewPython, join(bin, 'pvpython'))
    assert.equal(found.paraviewExe, join(bin, 'paraview'))

    const pathDir = join(root, 'pathbin')
    mkdirSync(pathDir, { recursive: true })
    writeFileSync(join(pathDir, 'pvpython'), '#!/bin/sh\n')
    const viaPath = discoverParaview([], pathDir, { parents: [] })
    assert.equal(viaPath.paraviewPython, join(pathDir, 'pvpython'))
    assert.equal(viaPath.paraviewExe, '')
    assert.deepEqual(discoverParaview([], '', { parents: [] }), { paraviewExe: '', paraviewPython: '' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('language: explicit config wins, then OS locale, then English', () => {
  assert.equal(resolveLanguage({ language: 'ru' }, { LANG: 'en_US.UTF-8' }), 'Russian')
  assert.equal(resolveLanguage({ language: 'Russian' }, { LANG: 'en_US.UTF-8' }), 'Russian')
  assert.equal(resolveLanguage({ language: 'de' }, { LANG: 'ru_RU.UTF-8' }), 'German')
  assert.equal(resolveLanguage({ language: 'Klingon' }, {}), 'Klingon')
  assert.equal(resolveLanguage({}, { LANG: 'ru_RU.UTF-8' }), 'Russian')
  assert.equal(resolveLanguage({}, { LC_ALL: 'de_DE.UTF-8' }), 'German')
  assert.equal(resolveLanguage({}, { LANG: 'C.UTF-8' }), 'English')
  assert.equal(resolveLanguage({}, {}), 'English')
})

test('the shipped bundle patch carries no machine-specific paths', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // comments may describe examples; the executable part must stay neutral
  const effective = patch.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  assert.doesNotMatch(effective, /\/media\//, 'author case root leaked into the patch')
  assert.doesNotMatch(effective, /\/opt\/openfoam/, 'author install path leaked into the patch')
  assert.doesNotMatch(effective, /\/usr\/lib\/openfoam/, 'author install path leaked into the patch')
  assert.match(effective, /name: '@yakovlev-i-a\/dsh-openfoam-workbench'/)
  assert.match(effective, /config: \{\}/, 'the shipped config must be empty')
})
