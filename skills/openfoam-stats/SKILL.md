---
name: openfoam-stats
description: Numerical analysis patterns for OpenFOAM run outputs — Cf/Cp and wall-shear extraction, drag/lift, residual plateau, QoI drift, Richardson/GCI, two-extractor agreement, and the cross-case QoI table (trends, correlations, RMSE/MAE) — plus the anti-patterns that cause silent-zero results. Use when post-processing a run, judging convergence, or comparing a parameter sweep.
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
`openfoam_residual_series`, `openfoam_solve_verify`, `openfoam_render`; `bash` + `python3` for the snippets.

## Pattern N — several cases: the QoI table
Once single-case extraction works, a sweep is the same recipe per case plus one table.
1. **Collect**: for every case read the solver and parameters (`controlDict`, `0/`), and the run status — keep only runs whose log ends in `End` with no FATAL; record why a case was excluded.
2. **Pick 3–6 metrics** for the topic: BFS → `Cf`, `x_reattach`, `Cp`; channel → `Cf`, friction factor, centerline `U` RMSE; bluff body / airfoil → `Cd`, `Cl`, wake decay.
3. **Per-case values** from `postProcessing/*` (forces, wallShearStress, probes) and the boundary fields, using the patterns above.
4. **Table**: rows = cases, columns = metrics; write `metrics.csv` next to `analysis.json`.
5. **Trends**: sort by the sweep axis, note monotone trends, Pearson `r` against the sweep axis and against every other metric; keep `|r| ≥ 0.7` and `n ≥ 3`.
6. **Reference comparison** (only if real data exists): `RMSE = sqrt(mean((sim-ref)^2))`, `MAE = mean(|sim-ref|)`, Pearson `r`. Never invent reference data.
7. **Write `analysis.json`**: `{cases_included, cases_excluded, metrics, trends, correlations, conclusions, best_case}`.

Anti-hallucination: every metric carries units and `n_samples` (below ~5 it is invalid), and a case that failed or did not converge never enters a ranking.
