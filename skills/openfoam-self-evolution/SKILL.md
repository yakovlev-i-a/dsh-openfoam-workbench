---
name: openfoam-self-evolution
description: After a verified OpenFOAM task, distil the reusable lesson into an experience card; before a long task, recall verified recipes. Use to grow the local experience library and avoid repeating known mistakes.
---

# openfoam-self-evolution

## When to use
- before a long task: `openfoam_experience_recall(query)`
- after a task passed its `*_verify`: propose `openfoam_experience_save(...)`

## Rules
- Only save verified work (a `*_verify` pass or a clean run). Do not save unverified.
- Card = recipe (3–10 steps) + key_params + pitfalls + triggers.
- `openfoam_experience_export` / `openfoam_experience_import` to share.
- Distillation (`analyzeTrajectory`/`draftFromTrajectory`) turns a verified
  trajectory into a draft skill; the user reviews before it joins `skills/`.

## Pitfalls
- Saving noise (failed/aborted runs) pollutes the library.
- Dedup is by `content_hash`; resaving the same recipe bumps hits, not files.
