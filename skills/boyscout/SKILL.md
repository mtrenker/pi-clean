---
name: boyscout
description: >-
  Explicitly invoked cleanup of one related finding from the current repository's
  boyscout.md during an authorized task, without a separate ticket. Never invoke
  automatically or merely because a cleanup opportunity exists.
disable-model-invocation: true
---

# Boy Scout cleanup

Use only when the user explicitly invokes this skill, in Pi with `/skill:boyscout`.
Reading, discussing or linking this file or `boyscout.md` is not invocation. A
coordinator may pass the user's explicit grant to the task's one writer as described
in the shared policy linked below. Other agents must honor the explicit-only boundary even
if their harness does not support the frontmatter flag.

Follow the [ticketless cleanup exception](../_shared/github-workflow.md#opt-in-boy-scout-cleanup).
It permits at most one coherent cleanup for the current authorized task and its PR;
zero is fine. Repeating the command, changing sessions or adding PR layers does not
reset that allowance. It does not carry into another task. Corrections necessary
for the main task are already in scope, not incidental cleanup.

## Fix one related finding

1. Confirm the current authorized task and read the target repository's instructions.
   Without an active task, stop; this is not a standalone cleanup assignment. Keep
   its readiness gates, worktree or branch, and review requirements. Stricter local
   rules win; do not silently bypass a separate-ticket requirement. Check the task's
   branch commits, current diff and PR descriptions, including earlier layers, for
   a prior cleanup. If the allowance is already used, report no cleanup. If that
   history is unavailable or ambiguous, ask rather than assume a fresh allowance.
2. Read `boyscout.md` at that repository's root, not in the skill's checkout. If it
   is missing, empty or has no suitable candidate, report no cleanup and continue
   the main task. Do not create a list, hunt for findings or invent work on invocation.
3. Recheck a listed finding against current code. Choose one concrete problem near
   code, tests or docs already being changed, with a small, low-risk fix and a focused
   check. An explicitly named candidate must meet the same conditions. Leave stale
   or already-fixed entries unchanged and report them rather than claiming a fix.
4. Keep the change easy to review. A small bug fix is allowed when intended behavior
   is clear and a focused regression check can establish it. Leave out unrelated
   refactors, formatting sweeps, speculative improvements and work needing redesign,
   broader investigation or consequential decisions. If it grows, stop that cleanup
   and report why; do not automatically create an issue or widen the task.
5. Validate with the cheapest reliable evidence and all required repository checks.
   For a durable bug fix, follow [regression testing](../agile-engineering/SKILL.md#test-what-earns-its-place).
   Test cleanup must preserve regression detection and isolation; fewer lines or
   faster execution alone are not evidence. Failed or inconclusive validation means
   the finding stays on the list and the cleanup is not reported as complete. Keep
   unfinished cleanup out of the delivered increment; preserve unrelated work.
6. Remove only the resolved finding in the same commit as its validated fix. Briefly
   name the cleanup and its validation in the task's PR, without a new checklist
   or separate ticket. Commit and publication follow the host task's authorization;
   invoking this skill adds no merge, deployment or destructive-operation permission.

## Keep findings local

Each consuming repository owns its root `boyscout.md`. When the user asks to capture
findings, keep entries short: the concrete problem, affected paths and a useful
validation check. No priorities, statuses, assignees or ticket IDs are required.
For example:

```markdown
# Boy Scout findings

- `src/search/query.ts`: whitespace-only input is sent as a search query.
  Check: a focused regression test treats it like empty input; ordinary queries still work.
```

The list records candidates, not verified diagnoses or authorization. Keep larger
work in the repository's normal planning workflow; do not turn this list into a
second backlog or copy one project's findings into the shared skill.
