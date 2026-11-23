---
name: openfoam-paper-reproduction
description: Reproduce a paper or implant its algorithm in OpenFOAM — extract the algorithm contract, probe the case, audit mismatches, then implement. Use for "reproduce this paper", "implant this algorithm", "add the drag model from the paper".
---

# openfoam-paper-reproduction

## When to use
- paper reproduction, algorithm implantation, adding a model from literature

## Four-step method (mandatory)
1. `openfoam_algo_extract_contract(source_file, algorithm_name)` — inputs/outputs/
   equations/governing_type/assumptions. **No** `write` of new source before this.
2. `openfoam_case_probe_facts(case_path)` — real facts: solver, phases, turbulence,
   dimensions, patches, fields. **No** BC/property edits before this.
3. `openfoam_algo_case_audit(contract, case_facts)` — mismatches. Non-empty → stop
   and resolve or report; do not proceed.
4. Controlled implantation: find reference → read → clone/write → compile.

## Verify (before calling it a reproduction)
- `openfoam_solver_build` exits 0 and a short run reaches `End` (no FATAL);
- the step-4 audit still passes — a non-empty mismatch list means **not done**;
- a QoI from the paper matches within its stated tolerance, or the delta is reported;
- `openfoam_render` the result and judge it with `read_image`.

## Literature workflow
1. `openfoam_paper_search` → the user picks a number.
2. `openfoam_paper_fetch(id, download=true)` → PDF.
3. `openfoam_read_paper(path, focus=...)` → sections.
4. `read_image` for figures/tables/formulas that carry numbers.
5. Split into 5–15 todo items, then implement.

## Pitfalls
- Writing new source without the contract → rework.
- Editing BCs without probing the case → wrong physics.
- Proceeding while the audit says pass:false.
