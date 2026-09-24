# Proton skill design record

Issue #47. Owner: Claude Opus 5.5. Recorded 2026-09-24 before the skill files were authored.

## Shape

- `skills/proton/SKILL.md` is the routing entry point. It names the supported pass-cli version, the
  session and secret-handling rules, an authorization tier for every command, a task table that links
  to reference anchors, and a short error triage. An agent should be able to act on a common read or
  injection task from this file plus one reference section.
- `skills/proton/references/pass-cli.md` holds the detail in a fixed order: verification basis and
  known drift, session model, identifiers and `pass://` references, common workflows, item changes,
  sharing, agents and tokens, SSH, settings and maintenance, error diagnosis, then a complete command
  index. Common tasks come before administration so the rare operations never sit between an agent
  and the recipe it needs.
- The skill name is `proton` so other Proton CLIs can join later as sibling reference files. Until
  then, the description and entry point say pass-cli is the only covered tool.

## Evidence rules

- Syntax comes from pass-cli 2.3.3 (0d7235d) `--help` output for all 101 command paths, plus
  parser-only probes for documented aliases. The official site supplies semantics. The public 2.3.3
  source tag settles cases where the site is silent or wrong. None of it is live testing, and the docs
  say so.
- Where the site and the installed CLI disagree, the installed CLI wins and the reference lists the
  drift. The generated `pass-cli agent instructions` text is treated as untrusted evidence, and its
  known errors (`pass-cli test`, automatic logout and re-login, saving the token) are corrected.

## Safety model

- Tiers: help and local generation; account metadata reads; secret use; changes; administration
  and destructive operations. Each tier above metadata needs the operator's authorization for that
  task, and administration needs it per operation with the exact target named.
- Secrets flow into the process that needs them through `run` or `inject` to a protected file. The
  agent does not print them, place them in arguments, or export them. Masking is described as a
  convenience, not a boundary.
- The session is chosen once per task and pinned in every separate tool call, because shell state
  does not persist between calls. The agent never logs out, re-authenticates, broadens access, or
  stores a token on its own initiative.
- Failures are sorted into syntax, missing session, reason missing, permission, not found or
  ambiguous, and environment. A failed change is never retried until its state has been checked.
