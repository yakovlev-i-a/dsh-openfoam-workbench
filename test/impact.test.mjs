// Impact-based write policy: the entry semantics decide apply / preview / approval.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { classifyImpact, decideAction } from '../lib/impact.js'

function registry(config = {}, approval = undefined) {
  const tools = {}
  const ctx = {
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register(t) { tools[t.name] = t } },
    get(name) { return name === 'approval' ? approval : undefined },
  }
  apply(ctx, { caseRoots: [], ...config })
  return tools
}

function makeCase(root, name = 'caseA') {
  const dir = join(root, name)
  mkdirSync(join(dir, 'system'), { recursive: true })
  writeFileSync(join(dir, 'system/controlDict'), [
    'application     foamRun;',
    'solver          incompressibleFluid;',
    'startFrom       startTime;',
    'endTime         10;',
    'deltaT          0.001;',
    'writeControl    timeStep;',
    'writeInterval   100;',
    'libs            ();',
    '',
  ].join('\n'))
  mkdirSync(join(dir, '0'), { recursive: true })
  writeFileSync(join(dir, '0/U'), [
    'dimensions      [0 1 -1 0 0 0 0];',
    'internalField   uniform (0 0 0);',
    'boundaryField',
    '{',
    '    inlet',
    '    {',
    '        type            fixedValue;',
    '        value           uniform (1 0 0);',
    '    }',
    '}',
    '',
  ].join('\n'))
  return dir
}

test('impact is judged by the entry, not by the file', () => {
  assert.equal(classifyImpact('0/U', 'inlet'), 'high')
  assert.equal(classifyImpact('0/Yi', 'inlet'), 'high')
  assert.equal(classifyImpact('system/fvSchemes', 'divSchemes'), 'high')
  assert.equal(classifyImpact('constant/thermophysicalProperties', 'thermoType'), 'high')
  assert.equal(classifyImpact('controlDict', 'writeInterval'), 'low')
  assert.equal(classifyImpact('controlDict', 'writeFormat'), 'low')
  assert.equal(classifyImpact('controlDict', 'deltaT'), 'high')
  assert.equal(classifyImpact('controlDict', 'adjustTimeStep'), 'high')
  assert.equal(classifyImpact('controlDict', 'application'), 'high')
  assert.equal(classifyImpact('controlDict', 'libs'), 'critical')
  assert.equal(classifyImpact('controlDict', 'functions'), 'critical')
  // unknown file or entry: conservative
  assert.equal(classifyImpact('somethingElse', 'x'), 'high')
  assert.equal(classifyImpact('controlDict', 'unknownKey'), 'high')
})

test('decideAction honours the mode, the impact and an explicit request', () => {
  assert.equal(decideAction({ impact: 'low' }), 'apply')
  assert.equal(decideAction({ impact: 'high' }), 'preview')
  assert.equal(decideAction({ impact: 'critical' }), 'approval')
  assert.equal(decideAction({ impact: 'high', applyRequested: true }), 'apply')
  assert.equal(decideAction({ impact: 'low', dryRun: true }), 'preview')
  assert.equal(decideAction({ impact: 'high', writeMode: 'apply' }), 'apply')
  assert.equal(decideAction({ impact: 'low', writeMode: 'preview' }), 'preview')
})

test('low-impact controlDict key applies, high-impact key previews first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-'))
  try {
    makeCase(root)
    const tools = registry({ caseRoots: [root] })

    const low = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '50' })
    assert.equal(low.applied, true, JSON.stringify(low))
    assert.equal(low.impact, 'low')
    assert.ok(low.changeId)

    const high = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'deltaT', value: '0.002' })
    assert.equal(high.applied, false)
    assert.equal(high.preview, true)
    assert.equal(high.impact, 'high')
    assert.match(high.note, /NOT APPLIED/)
    const rendered = tools.openfoam_dict_set.output.render({}, high)
    assert.match(rendered[0].text, /^NOT APPLIED/)
    // the file still has the old value
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /deltaT\s+0\.001;/)

    const forced = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'deltaT', value: '0.002', apply: true })
    assert.equal(forced.applied, true)
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /deltaT\s+0\.002;/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('initial/boundary conditions preview by default (0/U, 0/Yi)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp0-'))
  try {
    makeCase(root)
    mkdirSync(join(root, 'caseA/0'), { recursive: true })
    writeFileSync(join(root, 'caseA/0/Yi'), 'internalField uniform 0.2;\nboundaryField\n{\n    inlet { type fixedValue; value uniform 0.2; }\n}\n')
    const tools = registry({ caseRoots: [root] })
    const u = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: '0/U', entry: 'internalField', value: 'uniform (2 0 0)' })
    assert.equal(u.impact, 'high')
    assert.equal(u.applied, false)
    const yi = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: '0/Yi', entry: 'internalField', value: 'uniform 0.3' })
    assert.equal(yi.impact, 'high')
    assert.equal(yi.applied, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('expect refuses a write when the current value differs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-expect-'))
  try {
    makeCase(root)
    const tools = registry({ caseRoots: [root] })
    const bad = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '10', expect: '1' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /expect mismatch/)
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /writeInterval\s+100;/)
    const good = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '10', expect: '100' })
    assert.equal(good.applied, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('writeMode overrides the impact policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-mode-'))
  try {
    makeCase(root)
    const preview = registry({ caseRoots: [root], writeMode: 'preview' })
    const low = await preview.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '7' })
    assert.equal(low.applied, false, 'preview mode previews even low-impact keys')

    makeCase(root, 'caseB')
    const applyAll = registry({ caseRoots: [root], writeMode: 'apply' })
    const high = await applyAll.openfoam_dict_set.execute({ casePath: 'caseB', file: 'controlDict', entry: 'deltaT', value: '0.01' })
    assert.equal(high.applied, true, 'apply mode writes high-impact keys without a preview')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('undo restores the old value and refuses after a later edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-undo-'))
  try {
    makeCase(root)
    const tools = registry({ caseRoots: [root] })
    const first = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '50' })
    assert.equal(first.applied, true)
    const second = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '60' })
    assert.equal(second.applied, true)

    // undoing the first change must refuse: the file moved on
    const stale = await tools.openfoam_dict_undo.execute({ casePath: 'caseA', changeId: first.changeId })
    assert.equal(stale.ok, false)
    assert.match(stale.error, /file changed after this edit/)

    // undoing the latest change works
    const fresh = await tools.openfoam_dict_undo.execute({ casePath: 'caseA', changeId: second.changeId })
    assert.equal(fresh.ok, true, JSON.stringify(fresh))
    assert.equal(fresh.restored, '50')
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /writeInterval\s+50;/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('critical changes fail closed without an approval answerer, and pass with allowed-once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-appr-'))
  try {
    makeCase(root)
    const exec = { agent: { id: 'test-agent' }, callId: 'call-1', signal: new AbortController().signal }
    const noService = registry({ caseRoots: [root] })
    const refused = await noService.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'libs', value: '("libfoo.so")' }, exec)
    assert.equal(refused.ok, false)
    assert.match(refused.error, /approval service is not mounted|fail-closed/)
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /libs\s+\(\);/, 'the file must be untouched')

    const rejected = { request: async () => 'rejected' }
    const deny = registry({ caseRoots: [root] }, rejected)
    const denied = await deny.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'libs', value: '("libfoo.so")' }, exec)
    assert.equal(denied.ok, false)
    assert.match(denied.error, /approval rejected/)
    assert.equal(denied.approval.outcome, 'rejected')

    const allowed = { request: async () => 'allowed-once' }
    const allow = registry({ caseRoots: [root] }, allowed)
    const ok = await allow.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'libs', value: '("libfoo.so")' }, exec)
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(ok.applied, true)
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /libs\s+\("libfoo\.so"\);/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('approval needs the agent identity: without it the change is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-agent-'))
  try {
    makeCase(root)
    const allowed = { request: async () => 'allowed-once' }
    const tools = registry({ caseRoots: [root] }, allowed)
    const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'libs', value: '("libfoo.so")' })
    assert.equal(r.ok, false)
    assert.match(r.error, /no agent identity/)
    assert.match(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), /libs\s+\(\);/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('purgeWrite is low only at 0 and high above it', () => {
  assert.equal(classifyImpact('controlDict', 'purgeWrite', '0'), 'low')
  assert.equal(classifyImpact('controlDict', 'purgeWrite', '2'), 'high')
})

test('a sub-dictionary entry is refused instead of half-edited', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-subdict-'))
  try {
    makeCase(root)
    const cfg = join(root, 'caseA/system/controlDict')
    writeFileSync(cfg, readFileSync(cfg, 'utf8') + 'functions\n{\n    fieldMinMax1\n    {\n        type fieldMinMax;\n    }\n}\n')
    const tools = registry({ caseRoots: [root] })
    const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'functions', value: '{}' })
    assert.equal(r.ok, false)
    assert.match(r.error, /sub-dictionar/) // braces in a value are refused by name
    assert.match(r.hint, /single-line top-level entry/)
    assert.match(readFileSync(cfg, 'utf8'), /fieldMinMax1/, 'the block must be untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('undo of an appended key removes the line instead of writing an empty value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-append-'))
  try {
    makeCase(root)
    const cfg = join(root, 'caseA/system/controlDict')
    const tools = registry({ caseRoots: [root] })
    const added = await tools.openfoam_dict_set.execute({
      casePath: 'caseA', file: 'controlDict', entry: 'stopAt', value: 'endTime', append: true, apply: true,
    })
    assert.equal(added.applied, true)
    assert.match(readFileSync(cfg, 'utf8'), /stopAt endTime;/)
    const undone = await tools.openfoam_dict_undo.execute({ casePath: 'caseA', changeId: added.changeId })
    assert.equal(undone.ok, true, JSON.stringify(undone))
    assert.equal(undone.removed, true)
    assert.doesNotMatch(readFileSync(cfg, 'utf8'), /stopAt/, 'the appended line must be gone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no write happens when the undo journal cannot be recorded', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-journal-'))
  try {
    makeCase(root)
    const journal = join(root, 'caseA/.openfoam-changes')
    mkdirSync(journal, { recursive: true })
    let blocked = false
    try { chmodSync(journal, 0o500); blocked = true } catch {}
    if (!blocked) return
    const tools = registry({ caseRoots: [root] })
    const before = readFileSync(join(root, 'caseA/system/controlDict'), 'utf8')
    const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'writeInterval', value: '42' })
    if (r.ok === true) return // running as root: permissions cannot block the write
    assert.match(r.error, /cannot record the change for undo/)
    assert.equal(readFileSync(join(root, 'caseA/system/controlDict'), 'utf8'), before, 'the file must be untouched')
  } finally {
    try { chmodSync(join(root, 'caseA/.openfoam-changes'), 0o700) } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file that changes while approval is pending is not overwritten (TOCTOU)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-toctou-'))
  try {
    makeCase(root)
    const cfg = join(root, 'caseA/system/controlDict')
    // The answerer edits the file while the human "thinks", then approves.
    const racing = {
      request: async () => {
        writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('endTime         10;', 'endTime         99;'))
        return 'allowed-once'
      },
    }
    const tools = registry({ caseRoots: [root] }, racing)
    const exec = { agent: { id: 'test-agent' }, callId: 'call-1', signal: new AbortController().signal }
    const r = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'libs', value: '("libfoo.so")' }, exec)
    assert.equal(r.ok, false)
    assert.match(r.error, /file changed after the change was prepared/)
    const after = readFileSync(cfg, 'utf8')
    assert.match(after, /endTime\s+99;/, 'the concurrent edit must survive')
    assert.doesNotMatch(after, /libfoo\.so/, 'the stale edit must not be written')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('undo of an appended key removes only the top-level line', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ofwb-imp-depth-'))
  try {
    makeCase(root)
    const cfg = join(root, 'caseA/system/controlDict')
    writeFileSync(cfg, readFileSync(cfg, 'utf8') + 'nestedDict\n{\n    stopAt endTime;\n}\n')
    const tools = registry({ caseRoots: [root] })
    const added = await tools.openfoam_dict_set.execute({ casePath: 'caseA', file: 'controlDict', entry: 'stopAt', value: 'endTime', append: true, apply: true })
    assert.equal(added.applied, true, JSON.stringify(added))
    const undone = await tools.openfoam_dict_undo.execute({ casePath: 'caseA', changeId: added.changeId })
    assert.equal(undone.ok, true, JSON.stringify(undone))
    const text = readFileSync(cfg, 'utf8')
    assert.match(text, /nestedDict\n\{\n    stopAt endTime;\n\}/, 'the nested entry must survive')
    assert.equal((text.match(/^stopAt endTime;$/gm) || []).length, 0, 'the top-level entry must be gone')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
