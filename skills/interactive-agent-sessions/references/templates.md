# Handoff and completion templates

Used by [the interactive agent sessions skill](../SKILL.md) and its coordinated-task prompt.

A delegated session starts and ends in writing. Fill in every field; use "none" only where allowed.
`Report back` must choose a [completion path](../SKILL.md#completion-ownership), never bare "none".
For a callback, replace that entire line with the full block generated in the parent's shell, not
just the command name. A follow-up gets a fresh block or an active wait.

Handoff, sent as part of the delegate's initial prompt:

```text
Task: <the intended outcome and why it matters; link the issue or brief for scope>
Repository and revision: <owner/repo> at <git SHA>, branch <branch>, worktree <path>
Write scope: <paths you may change>. You are the only writer in this worktree while you run. Do not touch <paths off limits>.
Write targets: <authorized database, service or environment and read-only identity check; verify in your own execution context before writes> | <none>
Design: <approved Opus direction and where it is recorded> | <none; stop and request an Opus handoff if design is needed>
Tests to run: <exact commands>
Acceptance criteria: <numbered, testable>
Stop when: <the end of this increment: its pull request is open, or its report is written> | <the whole task is done, when Martin asked for it to be finished>
Risks and known traps: <what has already gone wrong here>
Report back: <watch; the parent will wait, collect the result, and continue authorized work> | <replace this line with the full block `github-work.mjs callback-handoff` prints> | <user takeover; Martin explicitly requested direct coordination, with this remaining work: ...>
Publication: <routine delivery: commit, push <branch>, and open its pull request> | <commits only; the parent publishes> | <none: read-only task>
Escalation: stop and report if <condition>. Do not merge, approve, force-push, publish a review, or delete anything beyond what Publication names. Do not spawn native subagents; ask for a visible Herdr pane instead.
```

Completion, required back from the delegate before its work is accepted:

```text
Result: <what now exists or was found, in plain words>
Check: <how to see it: command, route, file, or link>
Your turn: <the decision needed, and each action the handoff did not grant that now awaits authorization; or nothing>
Revision: <git SHA or "working tree only">, branch <branch>
Checks run: <command → result, including failures and skips>
Acceptance criteria: <each criterion in words → met, partially met with reason, or not met>
Limitations and accepted risks: <what this does not cover>
```

Keep it within one screen and link evidence instead of pasting it. The coordinator follows
[completion ownership](../SKILL.md#completion-ownership): inspect relevant evidence, verify claims
needed for the next action, and reconcile disagreements. Required checks still apply; unchanged
validation is not repeated merely because it crossed an agent boundary. Its own report to Martin
uses the same shape and states its conclusions, not the delegates' blocks again.

## Resume notes

When unfinished work will continue in another session, update one compact resume note before a
planned handoff, session end or compaction. A routine checkpoint in the same session needs no new
file. Use the task's existing brief or session-note location outside the source checkout unless
the task names an in-repo record, and give its path. Publishing still needs the applicable
authorization.

Keep the broader goal and decisions that still constrain the work, including their reasons.
State the verified current state, next action, unresolved decisions and pending authorizations.
Name active delegates and who owns collecting them; preserve a live completion path or arrange a
fresh one when the parent session changes.

Reference completed issues, commits, checks and other artifacts instead of copying them. Keep
secrets out. On pickup, read the note and references needed for the next action, recheck live state
and effective targets, and verify inherited claims needed for that action. Do not repeat completed
work merely to reconstruct context.

## Freeze and lift notices

A coordinator holding a preview still for Martin's review sends the freeze to every delegate that
shares the worktree, and lifts it explicitly when Martin has answered. Silence never lifts it.

```text
PREVIEW FROZEN for Martin's review of <issue or PR>. Until I lift it: no file edits, creates, or deletes; no installs, builds, or restarts; no branch switch, rebase, merge, reset, or checkout; no tests or tools that write. Reads and read-only checks are fine. Reply "frozen" and wait.
```

```text
PREVIEW LIFTED for <issue or PR>. Martin's answer: <verbatim>. Re-check the worktree state before continuing, and continue only with <the authorized next increment>.
```
