# Issue 41, review round 1 dispositions

Reviewer: GPT-5.6 Sol, independent read-only issue-diff review against `87a837f`, in the issue
worktree while its author was idle. This was not a detached PR review. The coordinator supplied
additional evidence checks for findings 7 and 8. Author: Claude Opus 5.
Every finding was reproduced or checked against a primary source before it was acted on. All eight
were confirmed; none was rejected or deferred as design-dependent.

| # | Finding | Disposition | Correction |
| --- | --- | --- | --- |
| 1 | A prompt starting with a dash is read as an option | Confirmed, blocker | Every template ends its options with `--` |
| 2 | "Every profile disables spawning" is wrong for Pi | Confirmed | Pi reports `uncontrolled`; wording split per vendor |
| 3 | Version-drift claim overstated | Confirmed | Qualified to the checks that exist |
| 4 | Metadata is not the renderer's source | Confirmed | Renderer reads `execution` and `nativeDelegation`; test asserts both directions |
| 5 | Criterion banned naming obsolete commands | Confirmed | Reworded to "no active recipe or launch path invokes" |
| 6 | Unsupported cost comparison | Confirmed | Comparison removed, rationale kept |
| 7 | Boundary missing from ad-hoc launches | Confirmed | `launchCommand` appends it to every prompt |
| 8 | Wrong rationale about deny rules under bypass | Confirmed | Switched to the documented `--disallowed-tools Task` |

## Evidence and detail

1. Reproduced: `codex --model gpt-5.6-sol ... --sandbox workspace-write '-h'` printed the Codex help
   and exited 0. `--` fixes it, and each CLI was checked: Codex reached its TTY check instead of
   printing help, Pi and Claude took `-h` as prompt text. Pi documents `--` in `pi --help`.
   Regression tests cover the rendered string and the argv a real shell produces.
2. Pi has no built-in sub-agents, but it loads extensions from personal settings and its own docs
   list a `subagent/` extension that spawns them. `pi-ambient` now reports `nativeDelegation:
   "uncontrolled"`, and `AGENTS.md`, both skills, and both docs say the flags are Claude and Codex
   controls with Pi's extension surface outside them.
3. What fails visibly is bounded: a removed CLI flag is an unknown argument, an unknown Codex feature
   name exits non-zero, and a deny rule naming no known tool warns at startup. A renamed tool or a
   silently accepted setting is not covered. The document now says that and asks for a re-check on
   CLI updates.
4. `--permission-mode` and the delegation flags were hard-coded while `profiles` reported them as
   data. The renderer now takes the permission mode and sandbox from `execution` and adds the
   delegation flag only when `nativeDelegation` is `disabled`. The test asserts the rendered command
   contains the reported execution value, contains the control when the metadata claims it, and does
   not when it does not. No indirection beyond that.
5. Acceptance criterion 3 now reads "no active recipe or launch path invokes", matching the issue.
6. The previous Pi default's provider, model, and effort come from personal settings, so no cost
   comparison is available. The default stays Opus for reproducibility and design ownership.
7. Correct: `launchCommand` rendered only the caller's prompt, so `launch-command` output and the
   short skill recipes carried no boundary. The instruction now lives in `agent-profiles.mjs` as
   `DELEGATION_BOUNDARY` and is appended by `launchCommand`, once, for every profile including
   `pi-ambient`. The duplicate copies in `issueAgentPrompt` and `reviewAgentPrompt` were removed, so
   there is one definition and one insertion point.
8. Correct, and my earlier rationale was wrong. Claude's permissions documentation states that rules
   evaluate deny first and that a bare tool name in a deny rule removes the tool from the model's
   context entirely, which is removal rather than a prompt `bypassPermissions` skips. The profiles
   now pass `--disallowed-tools Task`, a documented mechanism that also warns at startup when the
   tool name is unknown, and the undocumented `disabledBuiltinTools` settings key is gone. No new
   permission architecture, and whether the tool is actually absent is still unverified. One rendered
   command was run against the live CLI: the prompt reached the model, the variadic flag did not
   swallow `--`, and no unknown-tool warning appeared.

## Not done

No opt-out for the appended boundary, no second Claude mechanism alongside the deny rule, and no
change to the profile set, defaults, or the one-source direction.
