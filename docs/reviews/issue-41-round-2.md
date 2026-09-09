# Issue 41, review round 2 dispositions

Reviewer: GPT-5.6 Sol, independent read-only issue-diff review against `c25d56a`, in the issue
worktree while its author was idle. Author: Claude Opus 5. The reviewer verified the round 1
corrections for findings 1 through 7 and reported one narrow blocker. It stated that this correction
needs no convergence pass and that no other findings or scope growth were found.

| # | Finding | Disposition | Correction |
| --- | --- | --- | --- |
| 9 | The deny rule named `Task`, not the documented canonical tool `Agent` | Confirmed, blocker | Claude profiles deny `Agent,Workflow` |

## Evidence and detail

The tools reference states that its tool names "are the exact strings you use in permission rules"
and lists `Agent` as the tool that spawns a subagent. The permissions documentation matches: it
documents `Agent(Explore)` style rules, and says permission rules match the canonical name only and
to use the names in the tools reference. `Task` in that reference is the task-list family
(`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, `TaskStop`, `TaskOutput`), not the subagent tool.
The mechanism from round 1 was right and the name was wrong.

Round 1 cited the absence of an unknown-tool startup warning as evidence for `Task`. That evidence
was weak and is now withdrawn: the installed build carries a known-tool list containing `Agent`,
`Task`, and `Workflow`, so a legacy name can be known to the warning check without being the name a
permission rule matches. Documentation, not the absence of a warning, settles the name.

The same tools reference lists `Workflow` as a tool that "orchestrates many subagents in the
background and returns one consolidated result". That is the second documented path to native worker
spawning, so the profiles deny it alongside `Agent` rather than describing a control that misses it.
The scope stays as it was: the two documented spawning tools. Messaging tools such as `SendMessage`
and `ListAgents` reach agents and sessions that already exist and are outside this control; the
limits section now says so. No general capability audit was performed and none is claimed.

The rendered Claude command is now
`claude --model <model> --effort <level> --disallowed-tools Agent,Workflow --permission-mode bypassPermissions -- '<prompt>'`.
The comma form keeps the list to one argument. This round used documentation only: no live session
was started to probe behavior, so whether the tools are actually absent remains unverified, as
stated in the enforcement limits.

## Not done

No change to the profile set, defaults, prompt boundary, effort handling, or the one-source
direction. No new control, no new mechanism, and no audit of tools beyond the spawning pair.
