---
name: agile-engineering
description: >-
  Use when planning, implementing, testing, reviewing, or writing software issues
  and docs. Build the smallest useful increment, get feedback early, and scale
  rigor to real risk. Keep code, tests, plans, docs and issues as small as possible
  and as complete as needed. Agile engineering, not Scrum or ceremonies.
---

# Agile engineering

Working software over comprehensive documentation. Feedback over big plans.
Iterate rather than trying to get everything perfect the first time. Optimize for
what the user can try, learn or decide, not how much work the agent can produce.

## Build the next useful thing

- Identify the current need and the smallest end-to-end change that serves it.
  For obvious work, do it; a formal plan is not a prerequisite.
- Plan only to the next useful feedback point. Later possibilities can stay one
  sentence, not phases, speculative child issues or a production roadmap.
- Resolve uncertainty with a small experiment, not an architecture for every
  possible answer. Ask about consequential choices; make reversible routine
  choices within the agreed direction without another approval loop.
- Show working behavior early enough to change direction cheaply. Stop at the
  agreed outcome. Feedback decides the next increment; momentum does not.

## Match effort to consequences

These are judgments, not modes to declare or forms to fill out.

- A prototype answers a question. Hardcoded values, fixtures and manual checks
  are fine when they answer it honestly. State what is fake or unsupported; stop
  with the result. Do not silently add deployment, generalization or hardening.
  Keeping it as product code is the user's decision, not an automatic rewrite.
- A durable increment solves today's need with code the owner can understand and
  change. Reuse existing patterns; prefer direct code over speculative layers,
  configuration and extension points. Refactor when a current need justifies it.
- Increase rigor where failure has real consequences: lost data, exposed secrets,
  broken authorization, hard-to-reverse changes or reachable concurrency failures.
  Investigate and check those paths. Record recovery steps when undoing is not
  trivial. A small diff can be risky; a large prototype need not be production work.

## Test what earns its place

- Choose checks by changed behavior and credible failure, not a coverage quota.
  Be able to say what regression or risk each new test catches; no separate test
  justification document is needed.
- For durable bug fixes, add a focused regression test. Cover the important user
  path and meaningful failure boundaries, rather than every helper or permutation.
- Prefer the cheapest reliable evidence: a focused unit test, integration check
  or hands-on run, depending on the uncertainty. Prototype checks must establish
  whether its answer can be trusted, not cover code that will be discarded.
- Avoid assertions that merely restate implementation, duplicate the same evidence
  at every layer, or test framework behavior. Do not build a test framework for a
  small change. Run required repository checks and report failures honestly.

## Write for the person who must act

- An issue needs the behavior or problem, the next deliverable, how to check it,
  and where it stops. Put the point first. Link context instead of repeating it.
- Aim for one screen, not a word quota. Keep constraints, blockers and acceptance
  details that change the work. Omit empty sections and boilerplate unless the
  repository requires them. A cold agent needs actionable context, not a transcript.
- Split issues only when work is independently deliverable or genuinely blocking.
  Do not manufacture a parent and children for one small change.
- Docs explain use, non-obvious decisions and operational facts a future reader
  needs. Do not narrate code, duplicate evidence or create a report to prove effort.

A small issue can be four lines; use repository-required headings where applicable:

> Show failed check names in `status` so I do not have to open CI logs.
> Add names to the existing output; no rerun command or new UI.
> Check with a failing PR: failed names appear; passing checks are not listed.
> Stop when that output works. Context: link the existing CI discussion.

## Notice when the work grows

A one-caller abstraction, tests dwarfing the behavior, or an issue nobody wants to
read is a reason to ask: "Which current need does this serve?" It is not an automatic
ban. Simplify what adds no value. Reviewers must name a reachable failure or current
maintenance cost, not turn hypothetical future needs into blockers.

Required checks, security, privacy, independent review and authorization still
apply. This skill scales optional work; it does not waive repository rules. Follow
[the shared workflow policy](../_shared/github-workflow.md) for GitHub delivery.
