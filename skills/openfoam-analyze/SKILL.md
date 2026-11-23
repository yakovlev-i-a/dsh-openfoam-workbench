---
name: openfoam-analyze
description: Cross-case quantitative analysis — collect case results, build a QoI table (cases × metrics), find trends and correlations, compute RMSE/MAE against reference data, and write an analysis JSON. Use when comparing a parameter sweep or several cases.
---

# openfoam-analyze

## When to use
- a parameter sweep / several cases
- "which case is best?", "does the QoI trend with Re / expansion ratio?"
- comparing against DNS or experimental reference

## Recipe
1. **Collect cases**: for each case dir read the solver/params (`controlDict`, `0/`, `postProcessing/`) and the run status (log reaches `End`, no FATAL). Exclude failed / REVISE cases and record the reason.
2. **Pick 3–6 metrics** for the topic: BFS → `Cf`, `x_reattach`, `Cp`; channel → `Cf`, friction factor, centerline `U` RMSE; bluff body / airfoil → `Cd`, `Cl`, wake decay.
3. **Compute per-case values** from `postProcessing/*` (forces, wallShearStress, probes) and boundary fields (see `openfoam-stats` for the extraction patterns).
4. **QoI table**: rows = cases, columns = metrics; optionally write `metrics.csv`.
5. **Trends**: sort by the sweep axis; note monotone trends; Pearson `r` with the sweep axis and with every other metric; keep `|r| ≥ 0.7` and `n ≥ 3`.
6. **Reference comparison** (if available): `RMSE = sqrt(mean((sim-ref)^2))`, `MAE = mean(|sim-ref|)`, Pearson `r`. Never invent reference data.
7. **Write `analysis.json`**: `{cases_included, cases_excluded, metrics, trends, correlations, conclusions, best_case}`.

## Tools
`openfoam_residual_series`, `openfoam_log`, `openfoam_patch_diff`, `openfoam_run`, `bash` + `python3` (numpy/pandas/scipy). See `openfoam-stats` for Cf/Cp/force extraction.

## Anti-hallucination
- every metric carries units and `n_samples`; below the threshold (typically 5) it is invalid.
- never rank on a metric computed from a failed or non-converged case.
