// Tail-read for big logs: verdicts must come from the last steps without loading
// a gigabyte file, and an early error must not leak into a truncated scan.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readLogTail, textOut } from '../lib/runtime.js'
import { apply } from '../lib/index.js'

function bigLog(path, { steps = 20000, earlyError = true } = {}) {
  const lines = []
  if (earlyError) lines.push('--> FOAM FATAL ERROR: this belongs to a previous attempt')
  for (let i = 1; i <= steps; i += 1) {
    lines.push('      Time = ' + (i * 0.001).toFixed(3) + 's')
    lines.push('fluid GAMG:  Solving for p_rgh, Initial residual = ' + (0.01 / i) + ', Final residual = 1e-07, No Iterations 3')
    lines.push('      ExecutionTime = ' + (i * 0.9) + ' s  ClockTime = ' + i + ' s')
  }
  lines.push('')
  lines.push('End')
  writeFileSync(path, lines.join('\n'))
}

test('readLogTail truncates, aligns to a line and hides the old head', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-tail-'))
  try {
    const p = join(dir, 'big.log')
    bigLog(p)
    const r = readLogTail(p, 64 * 1024)
    assert.equal(r.truncated, true)
    assert.equal(r.scannedBytes, 64 * 1024)
    assert.ok(!r.text.includes('previous attempt'), 'the truncated tail must not contain the head')
    assert.match(r.text.split('\n')[0], /Time = /, 'the tail must start on a complete line')
    const small = join(dir, 'small.log')
    writeFileSync(small, 'Time = 1\nEnd\n')
    assert.equal(readLogTail(small, 64 * 1024).truncated, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('solve_verify watches a huge log through the tail without seeing stale errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ofwb-tail2-'))
  try {
    const p = join(dir, 'big.log')
    bigLog(p)
    const tools = {}
    apply(
      { systemPrompt: { section() {} }, skills: { register() {} }, tools: { register(t) { tools[t.name] = t } } },
      { caseRoots: [dir], logTailBytes: 64 * 1024 },
    )
    const v = await tools.openfoam_solve_verify.execute({ log_path: p })
    assert.equal(v.ok, true)
    assert.equal(v.state, 'finished')
    assert.equal(v.decision !== 'RERUN', true, 'an early FATAL from a previous attempt must not force RERUN')
    assert.equal(v.logScan.truncated, true)
    assert.equal(v.logScan.totalBytes > v.logScan.scannedBytes, true)
    const r = await tools.openfoam_solve_verify.execute({ log_path: p })
    assert.equal(r.ok, true)
    assert.equal(r.state, 'finished')
    assert.equal(r.logScan.truncated, true)
    assert.equal(r.time, 20)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('textOut keeps small JSON pretty and compacts huge payloads', () => {
  assert.equal(textOut({ ok: true })[0].text, '{\n  "ok": true\n}')
  const huge = { ok: true, list: Array.from({ length: 500 }, (_, i) => ({ i, name: 'x' + i })) }
  const out = textOut(huge)[0].text
  assert.ok(out.length <= 8100, 'huge payloads are capped')
  assert.match(out, /truncated/)
})
