import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveCase, run, textOut } from './runtime.js'
import { ensureFoamFile, findFoamFile } from './of-case.js'

export const PV_RENDER_SCRIPT = `import sys, os, json
from paraview.simple import *

def main():
    def num(s, d):
        try:
            return float(s[1:]) if s.startswith('n') else float(s)
        except Exception:
            return d

    case = sys.argv[1]
    field = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != 'none' else ''
    step = int(num(sys.argv[3] if len(sys.argv) > 3 else 'n-1', -1))
    az = num(sys.argv[4] if len(sys.argv) > 4 else 'n0', 0.0)
    el = num(sys.argv[5] if len(sys.argv) > 5 else 'n0', 0.0)
    zoom = num(sys.argv[6] if len(sys.argv) > 6 else 'n1', 1.0)
    out = sys.argv[7] if len(sys.argv) > 7 else 'render.png'
    region = sys.argv[8] if len(sys.argv) > 8 and sys.argv[8] != 'none' else ''
    foam_name = sys.argv[9] if len(sys.argv) > 9 and sys.argv[9] != 'none' else 'case.foam'
    foam = os.path.join(case, foam_name)
    if not os.path.exists(foam):
        open(foam, 'w').close()
    reader = OpenFOAMReader(FileName=foam)
    avail = []
    try:
        avail = [str(x) for x in list(reader.MeshRegions.Available or [])]
    except Exception:
        pass
    if region:
        want = [x for x in avail if x == region or x.endswith('/' + region + '/internalMesh')]
        if not want:
            print('META ' + json.dumps({'ok': False, 'reason': 'region not available', 'region': region, 'regions': avail}))
            sys.exit(3)
    else:
        want = [x for x in avail if x.endswith('/internalMesh')]
        if not want:
            want = ['internalMesh']
    try:
        reader.MeshRegions = want
    except Exception:
        pass
    cells = []
    points = []
    try:
        cells = [str(x) for x in list(reader.CellArrays.Available or [])]
    except Exception:
        pass
    try:
        points = [str(x) for x in list(reader.PointArrays.Available or [])]
    except Exception:
        pass
    if field and (cells or points) and field not in cells and field not in points:
        print('META ' + json.dumps({'ok': False, 'reason': 'field not available', 'field': field, 'regions': avail, 'cellArrays': cells[:40], 'pointArrays': points[:20]}))
        sys.exit(4)
    if field:
        try:
            reader.CellArrays = [field]
        except Exception:
            try:
                reader.PointArrays = [field]
            except Exception:
                pass
    UpdatePipeline()
    view = GetActiveViewOrCreate('RenderView')
    display = Show(reader, view)
    ncells = 0
    try:
        ncells = int(reader.GetDataInformation().GetNumberOfCells())
    except Exception:
        ncells = 0
    if ncells <= 0:
        # Reader builds that do not honour the MeshRegions list fall back to
        # their default selection; only a second zero is a real empty scene.
        try:
            reader.MeshRegions = ['internalMesh']
            UpdatePipeline()
            ncells = int(reader.GetDataInformation().GetNumberOfCells())
        except Exception:
            pass
    if ncells <= 0:
        print('META ' + json.dumps({'ok': False, 'reason': 'empty scene', 'regions': want, 'available': avail}))
        sys.exit(5)
    if field:
        for loc in ('CELLS', 'POINTS'):
            try:
                ColorBy(display, (loc, field))
                break
            except Exception:
                continue
    if step >= 0:
        try:
            view.ViewTime = reader.TimestepValues[step]
        except Exception:
            pass
    # A domain that is much longer in z than in x/y looks like a tiny square
    # from the default -z view (e.g. a 3.5 x 3.5 x 49 m channel): turn the camera
    # so the long axis spans the frame.
    try:
        b = reader.GetDataInformation().GetBounds()
        ex, ey, ez = b[1] - b[0], b[3] - b[2], b[5] - b[4]
        if ez > 2 * max(ex, ey):
            view.GetActiveCamera().Azimuth(90)
    except Exception:
        pass
    ResetCamera(view)
    cam = view.GetActiveCamera()
    cam.Azimuth(az)
    cam.Elevation(el)
    cam.Zoom(zoom)
    Render()
    SaveScreenshot(out, view, ImageResolution=[1200, 800])
    print('META ' + json.dumps({'ok': True, 'regions': want, 'cells': ncells, 'field': field}))

main()
`

export function parseRenderMeta(stdout) {
  const line = String(stdout || '').split('\n').find((l) => l.trim().startsWith('META '))
  if (!line) return null
  try { return JSON.parse(line.trim().slice(5)) } catch { return null }
}

export async function doRender(cfg, args) {
  const dir = resolveCase(cfg, args.case_path || args.casePath)
  if (!dir || !existsSync(dir)) return { ok: false, error: 'case not found: ' + dir }
  const pv = cfg.paraviewPython || 'pvpython'
  // Script and PNG live in a temp dir: rendering must not write into the case
  // (a production case may sit on a read-only mount, and stray .png files end
  // up in the time directories).
  const work = join(tmpdir(), 'ofwb-render-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
  try { mkdirSync(work, { recursive: true }) } catch (e) { return { ok: false, error: 'cannot create render dir: ' + (e.message || e) } }
  const script = join(work, 'render.py')
  try { writeFileSync(script, PV_RENDER_SCRIPT) } catch (e) { return { ok: false, error: 'cannot write render script: ' + (e.message || e) } }
  const field = String(args.field || 'none')
  const step = args.time_step != null ? Number(args.time_step) : -1
  const az = Number(args.azimuth) || 0
  const el = Number(args.elevation) || 0
  const zoom = Number(args.zoom) || 1
  const region = String(args.region || '')
  const foam = findFoamFile(dir) || ensureFoamFile(dir).path
  const out = join(work, 'render.png')
  const runArgs = [script, dir, field, 'n' + step, 'n' + az, 'n' + el, 'n' + zoom, out, region || 'none', foam ? basename(foam) : 'none']
  let r = await run('/usr/bin/env', ['-u', 'DISPLAY', pv, ...runArgs], { timeoutMs: 300000 })
  let log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  let meta = parseRenderMeta(r.stdout)
  if ((!r.ok || !existsSync(out)) && /GLX|BadValue|X Error|X_GLX/i.test(log) && existsSync('/usr/bin/xvfb-run')) {
    r = await run('/usr/bin/xvfb-run', ['-a', pv, ...runArgs], { timeoutMs: 300000 })
    log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
    meta = parseRenderMeta(r.stdout) || meta
  }
  if (meta && meta.ok === false) {
    if (meta.reason === 'field not available') {
      return {
        ok: false,
        error: `field '${field}' is not in this case`,
        available: { regions: meta.regions, cellArrays: meta.cellArrays, pointArrays: meta.pointArrays },
        hint: 'cellArrays lists the fields ParaView exposes (multi-region readers expose the union); regions look like /fluid/internalMesh',
      }
    }
    if (meta.reason === 'region not available') {
      return {
        ok: false,
        error: `no such mesh region: ${meta.region}`,
        regions: meta.regions,
        hint: 'pass region="fluid" (or "solid"); the available regions are listed in regions',
      }
    }
    if (meta.reason === 'empty scene') {
      return {
        ok: false,
        error: 'empty scene: the selected mesh regions contain no cells',
        regions: meta.regions,
        available: meta.available,
        hint: 'multi-region cases need MeshRegions like /fluid/internalMesh; pass region="<name>" or check that the case actually has a mesh',
      }
    }
    return { ok: false, error: meta.reason || 'render failed', meta }
  }
  if (r.ok && existsSync(out)) {
    return { ok: true, path: out, case: dir, field, time_step: step, region: region || null, regions: meta && meta.regions, cells: meta && meta.cells }
  }
  if (/GLX|BadValue|X Error|X_GLX|SIGSEGV|Segmentation fault|core dumped/i.test(log)) {
    return { ok: false, error: 'headless rendering unavailable: this ParaView build needs a GLX display (no OSMesa/EGL) and cannot create an offscreen GL context.', hint: 'Use a machine with a display, or an OSMesa/EGL ParaView build. xvfb alone is not enough for this build.', log: log.slice(-1200) }
  }
  return { ok: false, error: 'render failed', log: log.slice(-1200) }
}

export const PV_STL_SCRIPT = `import sys
from paraview.simple import *

stl, out = sys.argv[1], sys.argv[2]
def num(s, d):
    try:
        return float(s[1:]) if s.startswith('n') else float(s)
    except Exception:
        return d
az = num(sys.argv[3] if len(sys.argv) > 3 else 'n0', 0.0)
el = num(sys.argv[4] if len(sys.argv) > 4 else 'n0', 0.0)
zoom = num(sys.argv[5] if len(sys.argv) > 5 else 'n1', 1.0)
r = OpenDataFile(stl)
r.UpdatePipeline()
view = GetActiveViewOrCreate('RenderView')
Show(r, view)
view.ViewSize = [1200, 900]
ResetCamera(view)
cam = view.GetActiveCamera()
cam.Azimuth(az)
cam.Elevation(el)
cam.Zoom(zoom)
Render()
SaveScreenshot(out, view, ImageResolution=[1200, 900])
print('DONE', out)
`

export async function doRenderStl(cfg, args) {
  const stl = resolveCase(cfg, args.stl_path || args.stlPath)
  if (!stl || !existsSync(stl)) return { ok: false, error: 'stl not found: ' + stl }
  const pv = cfg.paraviewPython || 'pvpython'
  const base = join(tmpdir(), 'ofwb-stl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5))
  const script = base + '.py'
  const out = join(dirname(stl), '.stl_render_' + Date.now().toString(36) + '.png')
  try { writeFileSync(script, PV_STL_SCRIPT) } catch (e) { return { ok: false, error: 'cannot write render script: ' + (e.message || e) } }
  const runArgs = [script, stl, out, 'n' + (Number(args.azimuth) || 0), 'n' + (Number(args.elevation) || 0), 'n' + (Number(args.zoom) || 1)]
  let r = await run('/usr/bin/env', ['-u', 'DISPLAY', pv, ...runArgs], { timeoutMs: 300000 })
  let log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  if (!r.ok || !existsSync(out)) {
    r = await run('/usr/bin/env', ['-u', 'DISPLAY', '/usr/bin/xvfb-run', '-a', pv, ...runArgs], { timeoutMs: 300000 })
    log = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '')
  }
  if (r.ok && existsSync(out)) return { ok: true, path: out, stl }
  return { ok: false, error: 'stl render failed', log: log.slice(-1200) }
}

// --- paper / document helpers ---

export const renderBlocks = (v) => (v && v.image ? [...textOut(v), { type: 'image', attachment: v.image }] : textOut(v))
export const renderCompare = (v) => {
  const out = textOut(v)
  for (const r of [v && v.a, v && v.b]) if (r && r.image) out.push({ type: 'image', attachment: r.image })
  return out
}

export function makePresentation(ctx) {
// --- presentation helpers: inline images + tool-call cards ---
async function attachImage(result) {
  if (!result || !result.ok || !result.path || !existsSync(result.path)) return result
  try {
    const att = ctx.get('attachments')
    if (!att || typeof att.saveImage !== 'function') return result
    const ref = await att.saveImage({ data: readFileSync(result.path), mediaType: 'image/png', name: 'render.png' })
    return { ...result, image: ref }
  } catch (e) {
    return result
  }
}

const fmtDuration = (ms) => {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + (s % 60) + 's'
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
}
function fmtTable(headers, rows) {
  const all = [headers, ...rows]
  const widths = headers.map((_, i) => Math.max(1, ...all.map((r) => String(r[i] == null ? '' : r[i]).length)))
  const fmt = (r) => r.map((c, i) => String(c == null ? '' : c).padEnd(widths[i])).join('  ')
  return [fmt(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(fmt)].join('\n')
}

const RENDERS = {
  openfoam_check: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const f = v.findings || []
    if (!f.length) return [{ type: 'text', text: `check: ${v.path || ''} — no findings` }]
    const body = fmtTable(['SEVERITY', 'RULE', 'TITLE'], f.map((x) => [x.severity || '', x.rule || '', x.title || '']))
    const fixes = f.map((x, i) => `  ${i + 1}. ${x.fix || ''}`).join('\n')
    return [{ type: 'text', text: `check: ${v.path || ''} — ${f.length} finding(s)\n\n${body}\n\nfixes:\n${fixes}` }]
  },
  openfoam_run_list: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const runs = v.runs || []
    if (!runs.length) return [{ type: 'text', text: 'runs: none' }]
    const rows = runs.map((r) => [r.runId || '', r.status || (r.running ? 'running' : ''), fmtDuration(r.durationMs), r.lastTime == null ? '' : r.lastTime, r.command || ''])
    return [{ type: 'text', text: `runs: ${runs.length}\n\n${fmtTable(['ID', 'STATUS', 'TIME', 'LAST TIME', 'COMMAND'], rows)}` }]
  },
  openfoam_mesh_verify: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const m = v.metrics || {}
    const rows = Object.entries(m).map(([k, val]) => [k, typeof val === 'object' ? JSON.stringify(val) : String(val)])
    const head = `mesh verify: ${v.pass === true ? 'PASS' : v.pass === false ? 'FAIL' : '?'}`
    const regions = Array.isArray(v.regions) && v.regions.length > 1
      ? '\n\n' + fmtTable(['REGION', 'VERDICT', 'CHECKS'], v.regions.map((r) => [r.region, r.pass ? 'Mesh OK' : r.failedChecks ? `${r.failedChecks} failed` : 'no Mesh OK', r.command]))
      : ''
    const warn = v.warnings && v.warnings.length ? '\n\nwarnings:\n' + v.warnings.map((w) => '  - ' + w).join('\n') : ''
    const sug = v.suggestions && v.suggestions.length ? '\n\nsuggestions:\n' + v.suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n') : ''
    return [{ type: 'text', text: `${head}${regions}\n\n${fmtTable(['METRIC', 'VALUE'], rows)}${warn}${sug}` }]
  },
  openfoam_env_check: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const dists = Array.isArray(v.distributions) ? v.distributions : [v]
    const rows = dists.map((d) => [d.distribution || 'default', d.version || '?', d.distributionKind || '', d.ok ? 'ok' : 'FAIL', d.foamRoot || ''])
    const head = `plugin ${v.plugin ? v.plugin.version : '?'}`
    return [{ type: 'text', text: `${head}\n\n${fmtTable(['DIST', 'VERSION', 'KIND', 'STATUS', 'ROOT'], rows)}` }]
  },
  openfoam_list_cases: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const cases = Array.isArray(v.cases) ? v.cases : []
    if (!cases.length) return [{ type: 'text', text: `cases: none under ${v.root || ''}` }]
    const shown = cases.slice(0, 25)
    const rows = shown.map((c) => [c.name || c.path || '', c.solver || '?', c.steady === true ? 'steady' : c.steady === false ? 'transient' : '?', c.endTime == null ? '' : String(c.endTime), (c.strayTimes || []).length ? `stray:${c.strayTimes.length}` : ''])
    const more = cases.length > shown.length ? `\n... ${cases.length - shown.length} more` : ''
    return [{ type: 'text', text: `cases: ${v.count ?? cases.length}\n\n${fmtTable(['CASE', 'SOLVER', 'KIND', 'END', 'NOTE'], rows)}${more}` }]
  },
  openfoam_run_progress: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const rows = [
      ['state', v.state || '?'],
      ['time', v.time == null ? '?' : `${v.time}${v.endTime ? ' / ' + v.endTime : ''}`],
      ['steps', v.steps == null ? '?' : String(v.steps)],
      ['s/step', v.secondsPerStep == null ? '?' : v.secondsPerStep.toFixed(3)],
      ['ETA', v.eta || '-'],
      ['residual floor', v.residualFloor == null ? '?' : String(v.residualFloor)],
    ]
    return [{ type: 'text', text: `progress: ${v.state || '?'} (${v.decision || '?'})\n\n${fmtTable(['FIELD', 'VALUE'], rows)}` }]
  },
  openfoam_solve_verify: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const m = v.metrics || {}
    const rows = [
      ['state', v.state || (m.finished ? 'finished' : '?')],
      ['decision', v.decision || '?'],
      ['time', m.lastTime == null ? '?' : String(m.lastTime)],
      ['steps', m.timeSteps == null ? '?' : String(m.timeSteps)],
      ['residual floor', m.residualFloor == null ? '?' : String(m.residualFloor)],
      ['diverged', m.diverged ? 'yes' : 'no'],
      ['seconds/step', m.secondsPerStep == null ? '?' : Number(m.secondsPerStep).toFixed(3)],
      ['ETA', m.eta || '-'],
    ]
    const reasons = (v.reasons || []).length ? '\n\nreasons:\n' + v.reasons.map((r) => '  - ' + r).join('\n') : ''
    const errors = (m.errors || []).length ? '\n\nerrors:\n' + m.errors.map((e) => '  - ' + e).join('\n') : ''
    return [{ type: 'text', text: `${fmtTable(['FIELD', 'VALUE'], rows)}${reasons}${errors}` }]
  },
  openfoam_usage_report: (_args, v) => {
    if (!v || v.ok === false) return textOut(v)
    const called = Array.isArray(v.called) ? v.called : []
    const rows = called.slice(0, 30).map((c) => [c.name, String(c.count), c.failed ? String(c.failed) : ''])
    const head = `calls: ${v.calls ?? 0} | used: ${called.length} | unused: ${(v.unused || []).length}`
    if (!rows.length) return [{ type: 'text', text: head + '\n\n(nothing called yet)' }]
    return [{ type: 'text', text: `${head}\n\n${fmtTable(['TOOL', 'CALLS', 'FAILED'], rows)}` }]
  },
}

  return { attachImage, renderBlocks, renderCompare, RENDERS, fmtTable, fmtDuration }
}
