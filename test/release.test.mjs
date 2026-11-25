// Release hygiene: the README status, package.json and CHANGELOG must agree.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
