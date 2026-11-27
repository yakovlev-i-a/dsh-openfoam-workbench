# Security model

The plugin **runs local OpenFOAM programs with the privileges of your OS user** and
is **not a sandbox**: a solver or `wmake` call has the same access as a shell you
start yourself.

What it does anyway: only whitelisted applications run (`BASE_APPS` plus the
`extraCommands` config), and a command containing shell metacharacters (`;`, `|`,
`$()`, backticks, newlines) is refused before anything is spawned; the shell is
always a **static script** — bashrc, working directory, log path and command
arrive as argv / positional parameters, never as text spliced into the script, so
a path with quotes or backticks cannot become shell code; children get `stdin:
ignore`; the source tools only read the OpenFOAM installation.

## What these gates do not cover

The write policy applies to *this plugin's tools*. An agent with generic
shell/file tools can change a case without them —
`bash -c 'echo … >> system/controlDict'` never reaches `dict_set`, its impact
classification or its approval request. So treat these gates as **defense in
depth**, not as the barrier:

- the effective boundary is the DSH sandbox and permission mode (for example
  `workspace-write`) plus the approval answerer for what you choose to review;
- `enforceToolRouting` (`off` / `warn` / `deny` / `strict`, default `warn`) watches
  DSH's `tools/pre-execute` seam: a `bash`/`write`/`edit` call that writes a case
  dictionary is recorded, refused (`deny`) or refused-unless-escalated (`strict`);
- `strict` has an audited way out: `openfoam_escalate({target, toolsTried, why})`
  grants one single-use 10-minute token for that target, only when the named plugin
  tools really were called and failed within the last 15 minutes — the call history
  is the evidence. `escalationAuthority` decides who issues it: `auto` (the plugin,
  recorded in `openfoam_usage_report`) or `ask` (the DSH approval answerer,
  fail-closed without it). Text matching on shell commands is evadable, so the
  guard is a strong deterrent plus a signal, not a proof;
- when a case matters, review what the agent actually ran: `openfoam_run_list`, the
  change journal (`.openfoam-changes/`, `changeId`, `afterHash`) and `git diff`.

No credentials ship with this repo. Put API keys in DSH's `credentials` service,
never in `settings.json` or in the bundle.
