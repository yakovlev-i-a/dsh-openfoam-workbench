---
name: openfoam-viz
description: Generate diagnostic and publication figures from an OpenFOAM case — mesh overview, |U|/p contours, streamlines, y+ map, residual/probe histories — with publication styling (horizontal colorbar, readable fonts, aspect, zoom). Use when you need to see or present a run's flow field.
---

# openfoam-viz

## Figures to make (per case)
- mesh overview (full domain + zoomed near-wall)
- `|U|` contour and `p` contour at the latest non-zero time
- streamlines on a midplane
- y+ map on no-slip walls
- residual history (matplotlib)
- probe/line traces or forceCoeffs history, if configured

## Key rule: what needs GL
- **No GL needed**: residual history, probe/forceCoeffs/QoI history → `python3` + `matplotlib`/`numpy` on `log.<solver>` and `postProcessing/*`. Always available, even headless.
- **Needs GL**: field contours, streamlines, mesh views → `openfoam_render` (pvpython). ParaView 6.x renders off-screen headless (no DISPLAY); legacy 5.x GLX builds need xvfb or an OSMesa/EGL build.
- Fallback when GL is unavailable: `foamToVTK` the case and hand the VTK files to the user, or plot line/probe data with matplotlib.

## Camera: a plate is not a 3D box
`openfoam_render` has a `view` preset, and for thin domains it is the difference
between a picture and a line:

- `view: "xy" | "xz" | "yz"` — orthographic, looking down the remaining axis,
  fitted to the frame. This is what a 2D/plate case needs (0.2 mm thick and
  58 mm long: perspective plus a fitted camera renders it as a 300 px strip).
- `view: "auto"` (default) — picks the orthographic preset when the mesh is a
  plate (smallest extent ≤ 2 % of the largest) and perspective otherwise.
- `view: "custom"`, or any non-zero `azimuth`/`elevation` — perspective,
  rotated around the fitted frame. `azimuth` spins around the up-axis,
  `elevation` tilts up/down.
- `zoom` multiplies the camera distance **after** the fit: 1 shows the whole
  mesh, 2 twice as large, 0.5 twice as far. It is not a field-of-view angle, and
  values above ~8 clip the domain.
- multi-region cases: `region="fluid"` renders one region, otherwise every
  region is drawn; a solid and a fluid at different scales need separate
  renders, not one frame.

## Styling (publication quality)
- horizontal colorbar: `position_y ≈ 0.05`, `height ≈ 0.04`, `width ≈ 0.5` — never vertical/default.
- fonts: title ≥ 16, labels/ticks ≥ 14.
- window: `(1600, 900)` for wide/channel geometry, `(1600, 1200)` for tall/square.
- zoomed-feature plots: `zoom 1.5–2.5` after the fit (`openfoam_render`).
- one colormap per field across the whole set, and identical `clim` across cases in one comparison panel.

## Data hygiene
- plot the latest **non-zero** time, not `0/`.
- decimate very large meshes for visualization only (never for QoIs).
- never plot a field that does not exist at that time.
- never invent reference data — skip the comparison series if no reference exists.

## Before you believe a blank or squashed image
- A single row of pixels usually means the camera looks edge-on at a plate — set
  `view` to the plane you care about instead of tilting the perspective camera.
- An empty frame usually means the time step has no field, the field name is
  wrong, or the region was not written — the tool says which, read the message.

## Tools
`openfoam_render` (pvpython), `openfoam_residual_series`, `openfoam_log`, `bash` + `python3` (matplotlib/numpy), `read_image` to judge the rendered PNGs.
