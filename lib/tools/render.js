import { resolveCase, textOut } from '../runtime.js'
import { doRender, renderBlocks } from '../presentation.js'

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
  ]
}
