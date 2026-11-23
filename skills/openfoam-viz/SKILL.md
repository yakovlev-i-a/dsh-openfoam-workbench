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

## Styling (publication quality)
- horizontal colorbar: `position_y ≈ 0.05`, `height ≈ 0.04`, `width ≈ 0.5` — never vertical/default.
- fonts: title ≥ 16, labels/ticks ≥ 14.
- window: `(1600, 900)` for wide/channel geometry, `(1600, 1200)` for tall/square.
- zoomed-feature plots: `camera.zoom(1.5–2.5)` after setting the view.
- one colormap per field across the whole set, and identical `clim` across cases in one comparison panel.

## Data hygiene
- plot the latest **non-zero** time, not `0/`.
- decimate very large meshes for visualization only (never for QoIs).
- never plot a field that does not exist at that time.
- never invent reference data — skip the comparison series if no reference exists.

## Tools
`openfoam_render` (pvpython), `openfoam_residual_series`, `openfoam_log`, `bash` + `python3` (matplotlib/numpy), `read_image` to judge the rendered PNGs.
