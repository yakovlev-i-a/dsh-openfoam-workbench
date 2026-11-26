// Guards the golden-case contract without needing OpenFOAM: the case list, the
// stored reference values and the quantity names must stay coherent, so a broken
// expected file is caught by the normal test job, not only by the container job.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { CASES } from '../test/golden/cases.mjs'

const DISTRIBUTIONS = ['org', 'com']
const QOI_RE = /^(?:(fluid|solid)\.(?:cells|(?:\w+)\.(?:min|max|maxMagnitude|maxMag|minMag))|cells|maxNonOrtho|finalTime|lastResidual|(?:p|U|T|k|omega|e|h)\.(?:min|max|maxMagnitude)|U\.max)$/

test('every case is described and every reference file is valid JSON', () => {
  assert.ok(Object.keys(CASES).length >= 3, 'at least three golden cases')
  for (const dist of DISTRIBUTIONS) {
    const file = new URL(`./golden/expected/${dist}.json`, import.meta.url)
    assert.ok(existsSync(file), `missing test/golden/expected/${dist}.json`)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof data, 'object')
  }
})

test('each case has reference values for every distribution it is not skipped for', () => {
  for (const dist of DISTRIBUTIONS) {
    const file = new URL(`./golden/expected/${dist}.json`, import.meta.url)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    for (const [name, spec] of Object.entries(CASES)) {
      if (spec.skip && spec.skip[dist]) continue
      const hasTutorial = !spec.tutorial || Boolean(spec.tutorial[dist])
      if (!hasTutorial) continue
      assert.ok(data[name], `${dist}: no reference values for ${name} (run scripts/run-golden.mjs --update)`)
      const want = new Set(spec.qoi)
      for (const key of Object.keys(data[name])) {
        assert.ok(want.has(key), `${dist}/${name}: unexpected quantity ${key} in the expected file`)
      }
      for (const key of spec.qoi) {
        assert.ok(key in data[name], `${dist}/${name}: ${key} is declared but has no value`)
      }
    }
  }
})

test('reference values are numbers or numeric vectors', () => {
  for (const dist of DISTRIBUTIONS) {
    const data = JSON.parse(readFileSync(new URL(`./golden/expected/${dist}.json`, import.meta.url), 'utf8'))
    for (const [name, values] of Object.entries(data)) {
      for (const [key, value] of Object.entries(values)) {
        if (Array.isArray(value)) {
          assert.ok(value.length === 3, `${dist}/${name}/${key}: vector must have 3 components`)
          for (const n of value) assert.equal(typeof n, 'number', `${dist}/${name}/${key}: non-numeric component`)
        } else {
          assert.equal(typeof value, 'number', `${dist}/${name}/${key}: not a number`)
        }
      }
    }
  }
})

test('quantity names follow the runner grammar', () => {
  for (const [name, spec] of Object.entries(CASES)) {
    for (const key of spec.qoi) assert.match(key, QOI_RE, `${name}: quantity ${key} is not in the runner grammar`)
  }
})
