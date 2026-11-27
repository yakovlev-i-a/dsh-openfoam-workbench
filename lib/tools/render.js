import { existsSync, readFileSync } from 'node:fs'
import { resolveCase, textOut } from '../runtime.js'
import { doRender, renderBlocks, renderCompare } from '../presentation.js'

export default function renderTools({ cfg, attachImage }) {
  return [
  // --- tool: render a case (pvpython) ---
  {
    name: 'openfoam_render',
    description: 'Off-screen render one frame of a case with pvpython to PNG (ParaView 6.x renders headless without a display; legacy 5.x GLX builds fall back to xvfb). Optional field colors it, time_step picks a step; multi-region cases render every region (or pass region="fluid"). The camera defaults to an orthographic view along the normal of a plate-like mesh (a 2.8 x 58.2 x 0.2 mm domain is otherwise rendered as a line) and to perspective fitted to the bounds otherwise; view/azimuth/elevation/zoom override it. Fails loudly on an empty scene or an unknown field instead of returning a blank PNG.',
    parameters: {
      type: 'object',
      properties: {
        case_path: { type: 'string' },
        field: { type: 'string', description: 'Cell/point field to color by (e.g. T / U / p). Unknown fields return the list of available ones.' },
        region: { type: 'string', description: 'Render one mesh region of a multi-region case (e.g. fluid); by default all regions are shown.' },
        time_step: { type: 'number', description: '0-based step index, or -1 for the last.' },
        view: { type: 'string', description: 'Camera preset. "xy" / "xz" / "yz" looks orthographically down the remaining axis and fits the frame; "auto" (default) picks that preset when the mesh is a plate (one extent under 2 % of the largest) and perspective otherwise; "custom" forces perspective and honours azimuth/elevation.' },
        azimuth: { type: 'number', description: 'Rotate the camera around its up-axis, in degrees. With view="custom" (or "auto" on a non-plate mesh) only; an explicit non-zero value disables the preset.' },
        elevation: { type: 'number', description: 'Tilt the camera up or down, in degrees. Same rule as azimuth.' },
        zoom: { type: 'number', description: 'Multiplier for the camera distance after the fit: 1 shows the whole mesh, 2 shows it twice as large, 0.5 twice as far. Values above ~8 clip the domain.' },
      },
      required: ['case_path'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => renderBlocks(v) },
    timeoutMs: 360000,
    isConcurrencySafe: () => false,
    execute: async (args) => attachImage(await doRender(cfg, args)),
  },
  // --- tool: compare two renders ---
  {
    name: 'openfoam_compare_render',
    description: 'Render the same field at the same step from two cases, returning both image paths for a side-by-side comparison.',
    parameters: {
      type: 'object',
      properties: {
        case_a: { type: 'string' },
        case_b: { type: 'string' },
        field: { type: 'string' },
        region: { type: 'string', description: 'Mesh region to render from both cases (multi-region).' },
        time_step: { type: 'number' },
        view: { type: 'string', description: 'Camera preset for both renders: "xy" / "xz" / "yz" / "auto" / "custom".' },
        azimuth: { type: 'number', description: 'Rotate the camera around its up-axis, degrees (perspective only).' },
        elevation: { type: 'number', description: 'Tilt the camera up or down, degrees (perspective only).' },
      },
      required: ['case_a', 'case_b'],
    },
    output: { schema: { type: 'object' }, render: (_a, v) => renderCompare(v) },
    timeoutMs: 600000,
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const a = await attachImage(await doRender(cfg, { ...args, case_path: args.case_a }))
      const b = await attachImage(await doRender(cfg, { ...args, case_path: args.case_b }))
      return { ok: a.ok && b.ok, a, b }
    },
  },
  // --- tool: post verify ---
  {
    name: 'openfoam_post_verify',
    description: 'Checklist for post-processing review: confirm renders exist and an expectation was stated; the physical judgement is done by the agent with read_image.',
    parameters: {
      type: 'object',
      properties: { images: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' } },
    },
    output: { schema: { type: 'object' }, render: (_a, v) => textOut(v) },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const images = Array.isArray(args.images) ? args.images : []
      const checks = []
      checks.push({ name: 'renders provided', pass: images.length > 0, detail: `${images.length} image(s)` })
      checks.push({ name: 'expectation stated', pass: !!args.expected, detail: args.expected || '(none)' })
      const missing = []
      const invalid = []
      const tooSmall = []
      for (const raw of images) {
        const p = resolveCase(cfg, raw)
        if (!p || !existsSync(p)) { missing.push(raw); continue }
        try {
          const buf = readFileSync(p)
          const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
          const isJpg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
          if (!isPng && !isJpg) invalid.push(raw)
          else if (buf.length < 20 * 1024) tooSmall.push(`${raw} (${buf.length} B)`)
        } catch (e) {
          invalid.push(raw)
        }
      }
      checks.push({ name: 'all images exist', pass: missing.length === 0, detail: missing.join(', ') || 'ok' })
      checks.push({ name: 'valid image format', pass: invalid.length === 0, detail: invalid.join(', ') || 'ok' })
      checks.push({ name: 'non-trivial image size (>=20 KB)', pass: tooSmall.length === 0, detail: tooSmall.join(', ') || 'ok' })
      return { ok: true, pass: checks.every((c) => c.pass), checks, note: 'open the images with read_image and judge divergence, symmetry and units' }
    },
  },
  ]
}
