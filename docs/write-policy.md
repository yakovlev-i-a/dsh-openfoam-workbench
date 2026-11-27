# Write policy

Every mutating tool decides by **impact**, judged by the entry rather than the
file — a wrong `0/U` inlet or `fvSchemes` term converges to a plausible but wrong
answer, so neither is "safe":

| tool / change | default | why |
|---|---|---|
| `clean` | dry run | deletion cannot be undone |
| `case_scaffold` | writes only missing files (`force: true` to overwrite) | an existing setup is the user's |
| `dict_set` on `controlDict` output keys (`writeInterval`, `writeFormat`, …) | applies | organisational, visible in the log |
| `dict_set` on `purgeWrite` | low for `0`, **preview** above 0 | it deletes older time directories |
| `dict_set` on `0/*`, `fvSchemes`, `fvSolution`, `constant/*`, `deltaT`, `application`, anything unknown | **preview** (`applied: false`) until `apply: true` | can change physics or numerics |
| `dict_set` on `controlDict` `libs` / `functions` | **approval** through the DSH user-approval seam, always (no config switch), fail-closed without an agent identity or an answerer | can execute code |

`writeMode: impact | apply | preview` (Settings) overrides the default globally.
`dict_set` edits **single-line top-level entries**; a sub-dictionary (`functions`,
`boundaryField`) is refused with an explicit error rather than half-edited.
`expect: "<current value>"` refuses a write on top of a value you did not see, and
every applied change returns a `changeId` plus an `afterHash`;
`openfoam_dict_undo` reverts it and refuses when the file changed after that edit.
