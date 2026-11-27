#!/usr/bin/env node
// Build one plugin-market index (format 1) entry for the current commit.
//
//   node scripts/make-market-index.mjs --out market/index.json
//
// The index pins the exact commit, so publish only after the release commit is
// pushed. Validate the result with @deepseek-ai/dsh-plugin-market-index (the
// test suite does) and host the JSON over https (raw.githubusercontent.com or
// GitHub Pages) — that URL is what users add in Discover.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const toolCount = (/(\d+) tools/.exec(pkg.description || '') || [])[1] || ''
const commit = arg('--commit', execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit must be a 40-char lowercase sha, got: ${commit}`)

const repoUrl = arg('--repo', 'https://github.com/yakovlev-i-a/dsh-openfoam-workbench.git')
const homepage = arg('--homepage', 'https://github.com/yakovlev-i-a/dsh-openfoam-workbench')
const icon = arg('--icon', 'https://raw.githubusercontent.com/yakovlev-i-a/dsh-openfoam-workbench/main/icon.png')
const out = arg('--out', '')

const index = {
  format: 1,
  title: 'OpenFOAM Workbench',
  description: 'DeepSeek Harness plugins',
  plugins: [
    {
      name: pkg.name,
      title: { en: 'OpenFOAM Workbench', ru: 'OpenFOAM Workbench' },
      description: {
        en: pkg.description,
        ru: `Плагин OpenFOAM для DeepSeek Harness: ${toolCount} инструмента и 11 навыков — осмотр кейса, разработка солверов, сетки, многорегиональные CHT-расчёты, фоновые запуски, рендеры, воспроизведение статей и библиотека опыта.`,
      },
      icon,
      author: 'yakovlev-i-a',
      homepage,
      repository: { url: repoUrl.replace(/\.git$/, '') },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: repoUrl, commit },
          engines: pkg.engines ?? {},
        },
      ],
    },
  ],
}

const text = JSON.stringify(index, null, 2) + '\n'
if (out) {
  mkdirSync(dirname(join(root, out)), { recursive: true })
  writeFileSync(join(root, out), text)
  console.log(`wrote ${out} (${pkg.name}@${pkg.version}, commit ${commit.slice(0, 12)})`)
} else {
  process.stdout.write(text)
}
