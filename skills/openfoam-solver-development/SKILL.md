---
name: openfoam-solver-development
description: Clone, modify, build and smoke-test an OpenFOAM solver — copy a native solver into the workspace, rewrite Make/files to EXE, inspect the main loop, build with wmake and validate with -help. Use when the user wants a custom solver or to change a solver main loop.
---

# openfoam-solver-development

## When to use
- "new solver", "clone solver", "modify the main loop", "change UEqn/pEqn"
- keys: CreateFields, UEqn, pEqn, simpleControl/pimpleControl, CorrectPhi, Make/files, EXE

## OpenFOAM.org vs OpenFOAM.com — check this first

`openfoam_version_info` and `openfoam_list_solvers` report the distribution.

**OpenFOAM.org (v10+): modular solvers.** The solver is a *class* selected in
`system/controlDict` by `solver <name>;` and run by `foamRun` (single region) or
`foamMultiRun` (multi-region / CHT). There is no `simpleFoam`/`interFoam`
executable. Customisation paths: implement a model as a case-local library (see
`openfoam-code-modify`), subclass a module (e.g. `incompressibleFluid`) under
`applications/modules/<name>`, or write a new module — build with `wmake libso`.
Supersession map (old → modular): `simpleFoam`/`pisoFoam`/`pimpleFoam` →
`incompressibleFluid`; `reactingFoam`/`buoyantReactingFoam` → `multicomponentFluid`;
`rhoSimpleFoam`/`rhoPimpleFoam`/`buoyantFoam` → `fluid`; `multiphaseEulerFoam` →
`multiphaseEuler`; `interFoam` → `incompressibleVoF`; `compressibleInterFoam`/
`cavitatingFoam` → `compressibleVoF`; `rhoCentralFoam` → `shockFluid`;
`XiFoam` → `XiFluid`.

**OpenFOAM.com (ESI): application solvers.** Each solver is a standalone
executable selected by `application <name>;` in `system/controlDict`. Clone the
solver source and build with `wmake` (EXE target).

Never mix the two: a `.org` case with `solver incompressibleFluid` will not run on
`.com`, and `simpleFoam` is not an executable on `.org` v10+.

## Recipe
1. `openfoam_find_source(query, kind="solver")` — find the closest native solver in the same family.
2. `openfoam_read_source` — read the main `.C`, `createFields.H`, `Make/files`, `Make/options`.
3. `openfoam_clone_solver(source, dest, new_name)` — copy into the workspace; never edit `$FOAM_APP`/`$FOAM_SRC`.
4. Check `Make/files`: exactly one main `.C` and `EXE = $(FOAM_USER_APPBIN)/<name>`.
5. Inventory `createFields.H`, IOobject flags, thermo/turbulence, `fvModels`/`fvConstraints`.
6. Map the loop: `UEqn`/`pEqn`, `simpleControl`/`pimpleControl`, `nOuterCorrectors`, `CorrectPhi`, all `solve()`s.
7. `openfoam_solver_build(modulePath, dryRun: true)` for the first error, then a full build.
8. `openfoam_solver_build(modulePath, smoke: true)` — `-help`, then a short copied case.

## Key parameters
- EXE target: `EXE = $(FOAM_USER_APPBIN)/<name>`
- build: `wmake -j` for an EXE, `wmake libso` only for a LIB target
- source access: `openfoam_read_source` (not `read` — the general tool cannot see `/opt/openfoam*`)

## Pitfalls
- `wmake libso` builds a library, not a solver executable.
- Leaving `EXE = $(FOAM_APPBIN)/...` writes into the system installation.
- Editing `/opt/openfoam*` in place breaks rollback — copy first.
- `.org` vs `.com` differ in headers/APIs — check the installed version first.

## Verify
- `dryRun` success and a full `wmake -j` exit 0
- `<name> -help` starts without missing-library errors
- `ldd` resolves custom libraries from the user directory
- cloned tutorial: blockMesh → checkMesh → solver completes
