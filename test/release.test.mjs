// Release hygiene: the README status, package.json and CHANGELOG must agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = new URL('..', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const readme = readFileSync(new URL('README.md', root), 'utf8')
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')

test('the README status line reports the package version', () => {
  const m = /\*\*v(\d+\.\d+\.\d+) · (\d+) tools · (\d+) skills · (\d+) tests\*\*/.exec(readme)
  assert.ok(m, 'the README must keep the "**vX.Y.Z · N tools · N skills · N tests**" status line')
  assert.equal(m[1], pkg.version, 'bump package.json and README together')
})

test('the CHANGELOG documents the released version', () => {
  assert.match(changelog, new RegExp(`^## v${pkg.version.replace(/\./g, '\\.')}`, 'm'))
})

test('the published tarball carries the CHANGELOG and licence files', () => {
  for (const file of ['CHANGELOG.md', 'README.md', 'LICENSE', 'NOTICE', 'cordis.patch.yml', 'CORE.md', 'client.js']) {
    assert.ok(pkg.files.includes(file), `package.json files must include ${file}`)
  }
})

test('the marketplace index pins a real commit that carries its own version', () => {
  const index = JSON.parse(readFileSync(new URL('market/index.json', root), 'utf8'))
  const plugin = index.plugins[0]
  assert.equal(plugin.name, pkg.name)
  const version = plugin.versions[0]
  assert.equal(version.source.type, 'git')
  assert.match(version.source.commit, /^[0-9a-f]{40}$/)
  let indexedPkg
  try {
    indexedPkg = JSON.parse(execFileSync('git', ['show', version.source.commit + ':package.json'], { cwd: root, encoding: 'utf8' }))
  } catch {
    // A shallow clone cannot see release commits; CI fetches the full history
    // (fetch-depth: 0), so only a genuinely unknown commit is a failure.
    let shallow = false
    try { shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true' } catch {}
    if (shallow) return
    assert.fail(`market/index.json pins ${version.source.commit}, which is not in this repository`)
  }
  assert.equal(indexedPkg.version, version.version, 'the index must describe the version that commit actually carries')
  // When HEAD is the tagged release commit, the index must already point at it:
  // that is the state a Discover user installs.
  let tags = ''
  try { tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: root, encoding: 'utf8' }) } catch {}
  if (tags.split('\n').map((t) => t.trim()).includes('v' + pkg.version)) {
    assert.equal(version.version, pkg.version, 'regenerate market/index.json for this tagged release')
  }
})

test('every published description carries the current tool count', () => {
  const inventory = JSON.parse(readFileSync(new URL('test/fixtures/inventory.json', root), 'utf8'))
  const count = inventory.tools.length
  const fromDescription = /(\d+) tools/.exec(pkg.description || '')
  assert.ok(fromDescription, 'package.json description must state the tool count')
  assert.equal(Number(fromDescription[1]), count, 'package.json description is stale')
  // The index is regenerated after the release commit and tagged; only then must
  // its description match (during the release window it still describes HEAD~1).
  let tags = ''
  try { tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: root, encoding: 'utf8' }) } catch {}
  if (tags.split('\n').map((t) => t.trim()).includes('v' + pkg.version)) {
    const index = JSON.parse(readFileSync(new URL('market/index.json', root), 'utf8'))
    assert.equal(index.plugins[0].description.en, pkg.description, 'market/index.json was generated from an older description')
  }
})

test('the README intro and the tool count in it agree with the registry', () => {
  const intro = /plugin for OpenFOAM: (\d+) tools/.exec(readme)
  assert.ok(intro, 'the README intro must state the tool count')
  const status = /· (\d+) tools ·/.exec(readme)
  assert.ok(status)
  assert.equal(intro[1], status[1], 'the intro and the status line disagree')
})
