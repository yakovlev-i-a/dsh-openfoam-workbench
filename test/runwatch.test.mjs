// A run's log is the authority, not the registry record written by a previous
// host: a finished multi-region run ends with `End` then `Finalising parallel
// run`, a named log lives beside <id>.log, and a parallel log indents `Time =`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { countTimeSteps, logFinished, logState, resetRunDirCache, runSnapshot } from '../lib/runtime.js'

function mount(cfg = {}) {
  const tools = {}
  apply({
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register(t) { tools[t.name] = t } },
    on: () => {},
    get: () => undefined,
  }, { caseRoots: [], ...cfg })
  return tools
}

let seq = 0

/** A case with a run registry entry; `pid` 0 is dead on every platform. */
function makeRun({ tail, logName = null, status = 'running' }) {
  resetRunDirCache()
  const root = mkdtempSync(join(tmpdir(), 'ofwb-watch-'))
  const dir = join(root, 'caseA')
  const runs = join(dir, '.openfoam-runs')
  mkdirSync(join(dir, 'system'), { recursive: true })
  mkdirSync(runs, { recursive: true })
  writeFileSync(join(dir, 'system/controlDict'), 'application foamRun;\nendTime 0.1;\n')
  const id = 'runabc' + (seq += 1).toString(36) + Date.now().toString(36).slice(-4)
  const log = join(runs, (logName || id) + '.log')
  writeFileSync(log, tail)
  writeFileSync(join(runs, id + '.json'), JSON.stringify({
    id, casePath: dir, runsDir: runs, command: 'mpirun -np 4 foamMultiRun -parallel',
    argv: ['mpirun', '-np', '4', 'foamMultiRun', '-parallel'], pid: 0, startedAt: Date.now() - 60000,
    status, log,
  }))
  return { root, dir, id, log }
}

const MULTI_REGION_END = [
  '      Time = 0.09999s',
  '      ExecutionTime = 1977.9 s  ClockTime = 1978 s',
  '      Time = 0.1s',
  '      ExecutionTime = 1808.3503 s  ClockTime = 1978 s',
  '',
  '      End',
  '      ',
  '      Finalising parallel run',
  '',
].join('\n')

test('a multi-region log that ends with End then "Finalising parallel run" counts as finished', () => {
  const { root, id } = makeRun({ tail: MULTI_REGION_END })
  try {
    const cfg = { caseRoots: [root] }
    assert.equal(logFinished(cfg, id), true)
    assert.equal(logState(cfg, id), 'finished')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a run started with logName is read from its own log, not from <id>.log', () => {
  const { root, id } = makeRun({ tail: MULTI_REGION_END, logName: 'stage1-coupled' })
  try {
    const s = runSnapshot({ caseRoots: [root] }, id)
    assert.equal(s.status, 'success')
    assert.equal(s.lastTime, 0.1)
    assert.equal(s.lastTimeFromLog, 0.1)
    assert.match(s.logTail, /End/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a stale "interrupted" record is corrected by a log that reached End', () => {
  const { root, id } = makeRun({ tail: MULTI_REGION_END, logName: 'stage1c', status: 'interrupted' })
  try {
    const s = runSnapshot({ caseRoots: [root] }, id)
    assert.equal(s.status, 'success')
    assert.equal(s.logState, 'finished')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('countTimeSteps counts indented parallel Time lines', () => {
  const { root, log, id } = makeRun({ tail: MULTI_REGION_END })
  try {
    assert.equal(countTimeSteps(log).count, 2)
    const cfg = { caseRoots: [root] }
    assert.equal(runSnapshot(cfg, id).lastTime, 0.1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an mpirun signal crash is a failed log, not a running one', () => {
  const tail = [
    '      Time = 0.2s',
    '--------------------------------------------------------------------------',
    'mpirun noticed that process rank 2 with PID 416390 on node host exited on signal 8',
    '[host:416390] Signal: Floating point exception (8)',
  ].join('\n')
  const { root, id } = makeRun({ tail })
  try {
    const cfg = { caseRoots: [root] }
    assert.equal(logState(cfg, id), 'failed')
    assert.equal(logFinished(cfg, id), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('run_watch returns the verdict of a finished run without waiting', async () => {
  const { root, id } = makeRun({ tail: MULTI_REGION_END })
  try {
    const tools = mount({ caseRoots: [root] })
    const v = await tools.openfoam_run_watch.execute({ run_id: id, timeout_s: 30 })
    assert.equal(v.ok, true)
    assert.equal(v.state, 'finished')
    assert.equal(Number(v.time), 0.1)
    assert.equal(v.waitedSeconds, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('solver_status reports endTimeReached and the log verdict', async () => {
  const { root, id } = makeRun({ tail: MULTI_REGION_END, logName: 'stage1b' })
  try {
    const tools = mount({ caseRoots: [root] })
    const s = await tools.openfoam_solver_status.execute({ run_id: id })
    assert.equal(s.ok, true)
    assert.equal(s.status, 'success')
    assert.equal(s.logState, 'finished')
    assert.equal(s.lastTime, 0.1)
    assert.equal(s.endTimeReached, true)
    assert.match(s.logVerdict, /End/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
