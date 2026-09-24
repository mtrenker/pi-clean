# Model selection

Design owner: Claude Opus 5, recorded 2026-09-24 for issue #45. This is the durable direction for
which models this repository pins, why, and what the evidence behind that choice does not show.
[Agent launch profiles](agent-launch-profiles.md) remains the design for how launches are rendered;
this document decides only which model each profile names and states the revision policy for the
pinned model policy.

Ownership recorded here is historical, not retroactive. Earlier documents keep the model that wrote
them; from this revision on, the design-owner model is Claude Opus 5.5.

## Problem

The pinned models had fallen a generation behind. `scripts/agent-profiles.mjs` named
`claude-opus-5` and `gpt-5.6-sol`, while Anthropic now lists `claude-opus-5-5` and OpenAI recommends
`gpt-6-sol` for Codex. Nothing in the repository recorded why Sol is the Codex worker rather than
OpenAI's most capable model, so the choice read as an oversight rather than a decision. Nothing
recorded the evidence behind any pin, so a later reader could not tell which claims were measured,
at which effort, and which were assumed.

## Direction

1. Refresh the existing pins in place. `claude-opus` names `claude-opus-5-5`; `codex-sol-write` and
   `codex-sol-read` name `gpt-6-sol`. Profile IDs, agent routing, default efforts, sandbox and
   permission settings, and the native-delegation controls do not change.
2. Keep `claude-fable` on `claude-fable-5-1`. Fable stays the coordinator, reachable through
   `launch-command` only, and no helper command routes coding or design to it.
3. Add exactly one opt-in Astra profile, `codex-astra-write`, on `gpt-6-astra`. It is reachable
   through `launch-command` only, and it is not the default for anything.
4. Record the evidence, its effort levels, and its limits here, so a later refresh argues with dated
   sources rather than with impressions.

### Why Sol stays the Codex default

OpenAI's Codex model page recommends Sol for complex coding and agentic workflows and Astra for the
hardest end-to-end work across code, apps, and research. Our Codex profiles do bounded work inside
an approved design: implementation, independent review, and read-only investigation. That is Sol's
described range, and Artificial Analysis measured GPT-6 Sol at max effort gaining 2 points of
Coding Agent Index over GPT-5.6 Sol at roughly half the cost per task, in OpenAI's own Codex
harness. Nothing in the evidence shows a coding-agent deficit that a default change would fix.

The binding constraint on this repository is Martin's repair time, not model throughput. Changing
the default worker changes every managed `--agent codex` launch at once, so it needs evidence at the
efforts we actually run. We do not have that.

### Why Astra gets a profile rather than a paragraph

`scripts/agent-profiles.mjs` is the only place allowed to spell a model name, and a recipe that
hand-writes `claude --model ...` is a defect. Documenting Astra as an available choice without a
profile would therefore describe something an operator cannot launch through the sanctioned path,
and the documented workaround would be the defect. One profile costs one table row and one test
assertion, and it keeps the single-source rule intact.

`codex-astra-write` is deliberately narrow:

- It is absent from `AGENT_PROFILE_IDS`, so `start-issue --agent codex` and `review-pr --reviewer
  codex` still resolve to Sol. Reaching Astra is a typed, visible decision.
- There is no `codex-astra-read`. Read-only investigation is Sol's job at `medium`, and an unused
  profile is a maintenance cost with no evidence behind it. Add one when a real read-only task needs
  Astra, not before.
- Its default effort is `medium`, not `high`. OpenAI states that reasoning efforts do not map
  exactly between model generations, and names Astra's recommended starting effort as Light, `low`
  in configuration, against Medium for Sol. The Codex write profile already sits one step above the
  vendor's starting effort and the read profile sits at it, so the same rule puts Astra at `medium`.
  Copying the literal word `high` across generations would apply the rule the vendor warns against.

Astra is an escalation for a task Sol has already failed or is plainly unsuited to, chosen per
launch with `--profile codex-astra-write`. It is not a capability tier the repository defaults into.

### Why Opus 5.5 is a straight replacement

Anthropic's models overview tells readers to start with Claude Opus 5.5 for most workloads, and
lists it at $4/$20 per 1M input/output tokens with a 1M-token context window. The comparison with
Opus 5 comes from Artificial Analysis, not that table: it reports the price cut from $5/$25 and an
unchanged context window, and measures Opus 5.5 at the top of its Intelligence Index at max effort.

Opus 5.5 occupies the same role in this repository as Opus 5 did: design owner, default issue
author, and default reviewer. Nothing about the role changes, so nothing but the model ID changes.

The `claude-opus` default effort stays `high`, one step above the `medium` that Anthropic lists as
Opus 5.5's own default. This is the current profile's setting, carried over unchanged; it is not a
claim about what any earlier pin was one step above.

## Evidence

Fetched 2026-09-24. Artificial Analysis articles are dated 2026-09-22.

Vendor documentation:

- OpenAI, Codex models (https://developers.openai.com/codex/models). `gpt-6-sol` is "Built for
  complex coding and agentic workflows"; `gpt-6-astra` is "Our most capable model for complex work
  across code, apps, and research"; `gpt-6-luna` is the efficient model for high-volume tasks.
  Recommended starting efforts are Medium for Sol, High for Luna, and Light for Astra, where Light
  is `low` in configuration. The page states that reasoning efforts do not map exactly between model
  generations. GPT-5.6 Sol, Terra, and Luna remain available during the rollout, and selecting a new
  model does not grant access to it.
- Anthropic, Models overview
  (https://platform.claude.com/docs/en/about-claude/models/overview). `claude-opus-5-5` is the
  recommended starting model, $4/$20 per 1M tokens, 1M-token context, default effort `medium`,
  retirement not sooner than 2027-09-22. `claude-fable-5-1` is for demanding reasoning and
  long-horizon agentic work at $10/$50, default effort `high`.

Artificial Analysis, all figures at max effort unless the source states otherwise:

- Claude Opus 5.5 (https://artificialanalysis.ai/articles/claude-opus-5-5). Intelligence Index 58,
  the highest measured, leading six of ten component evaluations. Terminal-Bench 4.0 59.6%, level
  with GPT-6 Astra at xhigh and 11 points over Opus 5. AA-Briefcase v1.1 1,822 Elo, 143 over Fable
  5.1. Reported regressions and gaps: still behind on CritPt, AA-LCR, and GDP.pdf, and it uses about
  119k output tokens per Intelligence Index task against about 73k for Opus 5, so cost per task is
  level only because the price fell.
- GPT-6 Sol and Luna (https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier).
  GPT-6 Sol scores 57 on the Coding Agent Index in OpenAI's Codex harness, 2 points over GPT-5.6
  Sol, with Terminal-Bench 4.0 43% against 37% and SWE-Atlas-QnA 58% against 54%, at $2.99 per
  task, which Artificial Analysis reports as about half the cost of GPT-5.6 Sol at max. Reported
  regressions: GDPval-AA v2.1 drops about 100 Elo; AA-Omniscience accuracy
  falls from 59% to 54% because Sol now attempts 83% of questions instead of 99%, which is also what
  cuts its hallucination rate from 92% to 60%. AA-Briefcase v1.1 is level.

### What this evidence does not establish

- Every Artificial Analysis figure above is a max-effort result, except the GPT-6 Astra
  Terminal-Bench comparison, which the source gives at xhigh. This repository runs `high` for write
  profiles and `medium` for read profiles. Opus 5.5's medium, high, and xhigh efforts are
  reported on the Intelligence-versus-cost frontier, which is a cost-efficiency claim, not a score
  at our settings. No Sol figure at `high` is available to us.
- Benchmark scores are not local behaviour. None of these evaluations ran on this repository's
  tasks, prompts, worktree layout, or review contract.
- Account access is unverified. The refresh changes the strings the CLIs receive; whether
  `claude-opus-5-5`, `gpt-6-sol`, and `gpt-6-astra` are available on Martin's plan and sign-in is
  not observed by any check in this repository. OpenAI states availability depends on rollout,
  sign-in method, and client. A model an account cannot reach fails at launch, visibly, with the
  vendor's own error.
- End-to-end behaviour is unverified. No managed session was run against the new pins as part of
  this change.
- The GDPval-AA and AA-Briefcase regressions are knowledge-work findings driven by presentation
  quality and omitted rubric elements. Sol's role here is bounded implementation and review under an
  approved design, so the exposure is narrower than the headline, but it is not zero: a Codex
  reviewer writes a report a human reads.

### Known conflict: Codex `ultra` and native delegation

OpenAI now documents `ultra` as "Maximum reasoning with automatic task delegation", which runs
subagents. Every Codex profile here disables native delegation with `--disable multi_agent`, so
launching a Codex profile at `ultra` either wastes the effort level or contradicts the policy,
depending on which the CLI honours. Behaviour is unchanged in this revision: `ultra` remains a
validated effort, because removing it is a control change rather than a model refresh. Do not select
`ultra` for a profile whose delegation is disabled, and resolve the contradiction in its own issue.

## Non-goals

No default promotion of Astra, Luna, Terra, or Sonnet. No automatic or adaptive model selection. No
paid benchmark campaign or smoke run to prove account access. No new coordinator, and no change to
the rule that Fable does not write code by default. No read-only Astra profile. No change to
personal settings, external skills, effort ranges, sandbox and permission settings, delegation
controls, or authorization boundaries.

## Acceptance criteria

1. `scripts/agent-profiles.mjs` is the only file naming a model ID for execution, and it names
   `claude-opus-5-5`, `claude-fable-5-1`, `gpt-6-sol`, and `gpt-6-astra`.
2. `AGENT_PROFILE_IDS`, `DEFAULT_ISSUE_AGENT`, `DEFAULT_REVIEWER`, every default effort, every
   execution value, and every `nativeDelegation` value are unchanged from the previous revision.
3. `codex-astra-write` renders a command carrying `gpt-6-astra`, `model_reasoning_effort="medium"`,
   `--disable multi_agent`, and `--sandbox workspace-write`, asserted by test at every supported
   effort, and no agent name resolves to it.
4. Active guidance names Claude Opus 5.5 as the design owner. Documents recording an earlier design
   keep the model that owned them.
5. This document cites each source with its fetch date and separates measured results from what they
   do not establish, including unverified account access and end-to-end behaviour.

## Revising this document

Revisit when a vendor ships a model that changes a profile's role, retires a pinned model, or
publishes evaluation results at the efforts this repository runs. A refresh updates the pins, the
evidence section with new fetch dates, and this document's recorded owner and date. It does not
rewrite an earlier revision's attribution.

These files carry an active model reference, so a refresh checks each one:

- `scripts/agent-profiles.mjs`, the only file naming a model ID for execution
- `scripts/github-work.mjs` and `scripts/github-work.test.mjs`, for the managed prompts and the
  assertions that pin them
- `AGENTS.md`, `README.md`, `docs/agent-launch-profiles.md`, `docs/github-workflow.md`
- `skills/_shared/github-workflow.md` and the `SKILL.md` of `github-issues`, `github-pull-requests`,
  `interactive-agent-sessions`, `experience-design-quality`, and `react-composition-quality`

A model name inside a recorded design, a dated evidence citation, or a problem statement about an
earlier state is history and stays as written. Grepping this list for `Opus`, `Sol`, `claude-`, and
`gpt-` finds both kinds, so read the sentence to tell them apart.
