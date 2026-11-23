---
name: openfoam-stats
description: Numerical analysis patterns for OpenFOAM run outputs — Cf/Cp and wall-shear extraction, drag/lift, residual plateau, QoI drift, Richardson/GCI, two-extractor agreement — plus the anti-patterns that cause silent-zero results. Use when post-processing a run or judging convergence.
---

# openfoam-stats

A reference of compact patterns. Compose them into a `python3` snippet, run via `bash`, and persist the result as JSON next to the case. Requires only `numpy`/`scipy`.

## Pattern 1 — Cf from wallShearStress
Source: `postProcessing/wallShearStress/<time>/wallShearStress.dat` (function object). `Cf = |tau_w| / (0.5 * rho * U_inf^2)`. Do **not** finite-difference cell-center fields.

## Pattern 2 — Drag / lift from forceCoeffs
Source: `postProcessing/forceCoeffs/<time>/forceCoeffs.dat` (columns: Time Cd Cs Cl Cm...). Time-average the last 30% (post-transient); report `Cd_mean/std`, `Cl_mean/std`, Strouhal if the Cl FFT is meaningful.

## Pattern 3 — Residual plateau
Parse `Solving for <field>, Initial residual = …, Final residual = …`. Tail 10%: converged if `(max-min)/max < 0.05`. Report `final`, `tail_max`, `tail_min`.

## Pattern 4 — QoI drift (transient)
Last 10% of a QoI history: `drift = (q[-1]-q[0]) / mean(|q|)`; converged if `|drift| < 5%` (1% for strict steady-state).

## Pattern 5 — Richardson / GCI (3 meshes)
```
r = (cells_fine/cells_coarse) ** (1/N_dim)
p = log((f_med - f_coarse)/(f_fine - f_med)) / log(r)
f_exact = f_fine + (f_fine - f_med)/(r**p - 1)
GCI_fine = 1.25 * |(f_fine - f_med)/f_fine| / (r**p - 1)
```
Accept `GCI_fine < 5%` (validation) / `< 10%` (exploratory). Reference: ASME V&V 20 / Roache / Celik.

## Pattern 6 — Two-extractor agreement
Compare two independent reads (log parse vs function-object / PyVista): `rel = |A-B|/max(|A|,|B|,eps)`; bind the comparator only if `rel < 0.5`. Catches gross blind spots, tolerates methodological differences.

## Anti-patterns (silent zeros)
- `cloudOutputProperties.massInjected` — cumulative bookkeeping, constant by design → ratio metrics ~0/1. Use the live droplet mass from `log.<solver>` (`Current mass in system`).
- `cloud:rhoTrans_*` — transient source written sparsely; often zero at write times. Use live mass or integrated species mass.
- Cell-center finite-difference for `wallShearStress` — poor accuracy; use the function object.
- Reading `0/<field>` as "the latest" — read the largest non-zero time directory.
- Treating any cumulative bookkeeping field as a per-step measurement.

## Anti-hallucination
- Every result carries explicit units and `n_samples`; below the threshold (typically 5) it is invalid — don't rank on it.
- If a snippet fails or returns NaN/inf, write `<pattern>_failed.json` with the error, never a fake number.

## Tools
`openfoam_residual_series`, `openfoam_log`, `openfoam_post_verify`, `openfoam_render`; `bash` + `python3` for the snippets.
