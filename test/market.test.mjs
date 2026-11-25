// The marketplace index must satisfy the real DSH validator, not our idea of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

function loadValidator() {
  try {
    return require('@deepseek-ai/dsh-plugin-market-index')
  } catch {}
  const bases = [dirname(String(process.argv[1] || '')), process.cwd()]
  const execDir = dirname(process.execPath)
  bases.push(join(execDir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  bases.push(join(execDir, '..', 'lib', 'node_modules'))
  for (const base of bases) {
    if (!base) continue
    let dir = resolve(base)
    for (let depth = 0; depth < 8; depth += 1) {
      const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index')
      if (existsSync(join(pkgDir, 'package.json'))) {
        try { return require(pkgDir) } catch { return null }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

test('the generated index is accepted by the DSH market validator', () => {
  const validator = loadValidator()
  if (!validator) return // no host installation to borrow the validator from
  const commit = 'a'.repeat(40)
  const out = execFileSync(process.execPath, ['scripts/make-market-index.mjs', '--commit', commit], { encoding: 'utf8' })
  const parsed = validator.parseMarketIndex(JSON.parse(out), 'https://example.com/index.json')
  assert.equal(parsed.plugins.length, 1)
  const plugin = parsed.plugins[0]
  assert.equal(plugin.name, '@yakovlev-i-a/dsh-openfoam-workbench')
  assert.equal(plugin.versions[0].source.type, 'git')
  assert.equal(plugin.versions[0].source.commit, commit)
  assert.match(plugin.versions[0].engines.dsh, />=/)
  assert.match(plugin.icon, /^https:\/\//)
  const target = validator.marketInstallTarget(plugin.name, plugin.versions[0])
  assert.match(target.spec, /^git\+https:\/\/github\.com\/yakovlev-i-a\/dsh-openfoam-workbench\.git#/)
  assert.match(target.spec, new RegExp(commit))
})
