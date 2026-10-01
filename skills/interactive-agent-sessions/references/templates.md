# Handoff and completion templates

Used by [the interactive agent sessions skill](../SKILL.md) and its coordinated-task prompt.

A delegated session starts and ends in writing. Fill in every field; write "none" rather than leaving one out.

Handoff, sent as part of the delegate's initial prompt:

```text
Task: <one sentence>
Repository and revision: <owner/repo> at <git SHA>, branch <branch>, worktree <path>
Write scope: <paths you may change>. You are the only writer in this worktree while you run. Do not touch <paths off limits>.
Design: <approved Opus direction and where it is recorded> | <none; stop and request an Opus handoff if design is needed>
Tests to run: <exact commands>
Acceptance criteria: <numbered, testable>
Stop when: <the end of this increment: show it and wait> | <the whole task is done, when Martin asked for it to be finished>
Risks and known traps: <what has already gone wrong here>
Report back: <none; the parent watches this pane> | <the block `github-work.mjs callback-handoff` prints; send at most one callback for this assignment>
Escalation: stop and report if <condition>. Do not push, publish, approve, merge, or delete anything. Do not spawn native subagents; ask for a visible Herdr pane instead.
```

Completion, required back from the delegate before its work is accepted:

```text
Result: <what now exists or was found, in plain words>
Check: <how to see it: command, route, file, or link>
Your turn: <the decision needed, and each push, publication, merge, or deletion awaiting authorization; or nothing>
Revision: <git SHA or "working tree only">, branch <branch>
Checks run: <command → result, including failures and skips>
Acceptance criteria: <each criterion in words → met, partially met with reason, or not met>
Limitations and accepted risks: <what this does not cover>
```

Keep it within one screen and link evidence instead of pasting it. The coordinator verifies the claims rather than relaying them: re-run the checks, read the diff, and reconcile disagreements between delegates. Its own report to Martin uses the same shape and states what it concluded, not the delegates' blocks again.

## Freeze and lift notices

A coordinator holding a preview still for Martin's review sends the freeze to every delegate that
shares the worktree, and lifts it explicitly when Martin has answered. Silence never lifts it.

```text
PREVIEW FROZEN for Martin's review of <issue or PR>. Until I lift it: no file edits, creates, or deletes; no installs, builds, or restarts; no branch switch, rebase, merge, reset, or checkout; no tests or tools that write. Reads and read-only checks are fine. Reply "frozen" and wait.
```

```text
PREVIEW LIFTED for <issue or PR>. Martin's answer: <verbatim>. Re-check the worktree state before continuing, and continue only with <the authorized next increment>.
```
