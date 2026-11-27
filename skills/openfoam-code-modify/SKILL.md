---
name: openfoam-code-modify
description: Implement a small custom OpenFOAM model (viscosity/turbulence/source/fvOption) as a case-local compiled library under customModels/<Class>, built with wmake libso and activated by case dictionaries. Use for "implement a model", "add a source term", "custom viscosity".
---

# openfoam-code-modify

## When to use
- "implement a turbulence/viscosity model", "add a source term", "custom fvOption"
- **Not** for new transported fields or solver edits — those are out of scope; return to the user.

## Hard rules
- Never edit `$WM_PROJECT_DIR`, `$FOAM_SRC`, or any installation directory.
- All code goes in `<case>/customModels/<ClassName>/`.
- Build case-local: `wmake libso` with `LIB = lib<ClassName>` (bare relative name, so the `.so` lands inside the case).
- Activate via `system/controlDict` `libs ("customModels/<ClassName>/lib<ClassName>.so");`
  plus one dictionary: `constant/momentumTransport` or `constant/fvModels`.

## Recipe
1. `openfoam_inspect_case` — solver, fields, model, cell zones.
2. `openfoam_read_source` — pull the parent class header/signatures (never guess the API).
3. Write `<Class>.H`, `<Class>.C`, `Make/files`, `Make/options`.
4. `wmake libso`; on failure read the **tail** of `build.log`, fix the specific line, retry.
5. Activate, then smoke: `openfoam_solver_build` with `dryRun: true` / a short run, verify the log ends in `End`.

## Pitfalls
- A bare `lib<Class>.so` in `controlDict.libs` resolves through the global search path — the case becomes non-portable. Use the case-relative path.
- Copying a `.so` from another case breaks reproducibility.
- Over-scoping (new field, solver edit) — stop and return to the user.

## Verify
- `lib<Class>.so` exists **and** the case application reaches `End`
