// The run registry belongs to the case, not to whatever project caseRoots[0] is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listRunIds, readRun, resetRunDirCache, runLogPath, runsDirOf, runsDirsOf, runSnapshot, writeRun,
} from '../lib/runtime.js'

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-runs-'))
  const caseDir = join(root, 'myCase')
  mkdirSync(caseDir, { recursive: true })
  writeFileSync(join(caseDir, 'system_placeholder'), '')
  return { root, caseDir }
}

test('a run registry lives next to its case, never in caseRoots[0]', () => {
  const { root, caseDir } = scratch()
  try {
    resetRunDirCache()
    const cfg = { caseRoots: [root], runsDir: '' }
    assert.equal(runsDirOf(cfg, caseDir), join(caseDir, '.openfoam-runs'))
    writeRun(cfg, { id: 'runA1', casePath: caseDir, status: 'success', command: 'icoFoam' })
    assert.ok(existsSync(join(caseDir, '.openfoam-runs', 'runA1.json')))
    assert.ok(!existsSync(join(root, '.openfoam-runs')), 'the case root must stay clean')

    // a fresh process finds it again by scanning the case roots
    resetRunDirCache()
    assert.ok(listRunIds(cfg).includes('runA1'))
    const dirs = runsDirsOf(cfg)
    assert.ok(dirs.includes(join(caseDir, '.openfoam-runs')), 'the case registry must be discovered')
    assert.ok(dirs.includes(join(root, '.openfoam-runs')), 'the root registry is also a candidate')
    const record = readRun(cfg, 'runA1')
    assert.equal(record.casePath, caseDir)
    assert.match(record.runsDir, /myCase\/\.openfoam-runs$/)

    // an explicit runsDir wins
    assert.equal(runsDirOf({ runsDir: '/tmp/somewhere' }, caseDir), '/tmp/somewhere')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('runSnapshot settles a finished log even when the pid is gone', () => {
  const { root, caseDir } = scratch()
  try {
    resetRunDirCache()
    const cfg = { caseRoots: [root], runsDir: '' }
    writeRun(cfg, { id: 'runB2', casePath: caseDir, status: 'running', command: 'icoFoam', pid: 0, startedAt: Date.now() - 5000 })
    const log = runLogPath(cfg, 'runB2')
    writeFileSync(log, 'Time = 0.1\nTime = 0.2\nEnd\n')
    const snap = runSnapshot(cfg, 'runB2')
    assert.equal(snap.status, 'success')
    // Numeric on purpose: the same unit as progressFrom().time, so a caller can compare.
    assert.equal(snap.lastTime, 0.2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
