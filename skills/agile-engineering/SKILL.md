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

Required checks, security, privacy, independent review and authorization still
apply. This skill scales optional work; it does not waive repository rules. Follow
[the shared workflow policy](../_shared/github-workflow.md) for GitHub delivery.

## Build the next useful thing

- Identify the current need and the smallest complete end-to-end change that serves it.
  Include affected callers, tests, fixtures and configuration. These complete the
  agreed behavior; speculative features expand it. For obvious work, do it; a
  formal plan is not a prerequisite.
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
  Before database, service or shared-environment writes, the writer follows the
  [effective-target check](../_shared/github-workflow.md#safety) in its own execution context.

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

Before adding, keeping or asking for a test, ask:

- **Can it fail?** It must fail when the behavior it promises breaks. A test whose
  setup never reaches the guarded path is not evidence, nor is one a no-op would
  pass when the promised behavior is a change. See a regression or risk test fail
  once against the broken behavior.
- **Is the pinned detail depended on?** Assert what users, callers, stored data or
  other components rely on. Persisted and wire formats, authorization and security
  decisions, ids or attributes that other code or assistive technology reads, and
  stated properties are contracts: test them directly. An encoding or call order
  that nothing consumes is not.
- **Does the boundary under test match production?** A unit test may stub what
  lies outside its boundary. Inside it, the plugins, configuration and
  serialization that shape what the test checks must be the ones production uses.
- **Would sharpening an existing test do?** Prefer a sharper assertion, or a case
  for a distinct failure mechanism, over more inputs of the same kind.

No new test, a sharper existing assertion, and removing a test whose failure
another test still catches are normal outcomes. When changed behavior gets no new
test, name the existing evidence in the pull request's validation notes. Reviewers
ask the same questions: a request for a test names the failure it would catch, and
a finding against a test names its concrete defect or cost, such as that it cannot
fail, pins nothing depended on, or duplicates other evidence. Neither is a default
finding.

## Write for the person who must act

- An issue explains who needs the change and why, the intended outcome, how to
  check it, and where it stops. A user story communicates value, not a walkthrough
  or implementation plan. Link supporting agent context instead of repeating it.
- A pull request explains the delivered outcome, meaningful deviations from the
  linked issue, validation and limitations. Do not retell the specification or
  report every action taken.
- Aim for one screen, not a word quota. Keep constraints, blockers and acceptance
  details that change the work. Omit empty sections and boilerplate unless the
  repository requires them. A cold agent needs actionable context, not a transcript.
- Split issues only when work is independently deliverable or genuinely blocking.
  Do not manufacture a parent and children for one small change.
- Docs explain use, non-obvious decisions and operational facts a future reader
  needs. Do not narrate code, duplicate evidence or create a report to prove effort.
- When unfinished work will continue in another session, use [resume notes](../interactive-agent-sessions/references/templates.md#resume-notes)
  to preserve decisions and pending work without copying completed artifacts.

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

## When guidance fails repeatedly

Start with an observed failure and check whether the relevant guidance was available
and followed. Repair missing access or conflicting instructions before adding rules.
Prefer an existing deterministic check for a mechanical failure; add a focused check
when the risk warrants it. Put judgment about scope and outcome clarity in the parent
or independent review. Replace ineffective or duplicate instructions rather than
append another warning. Judge the change on subsequent work, not on the presence of
new guidance.
