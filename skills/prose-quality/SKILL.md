---
name: prose-quality
description: >-
  Use for human-facing prose: replies, commits, PRs, issues, reviews, docs, and
  drafts. Apply without loading: answer directly; cut
  chat filler, praise, stock AI words, stacked hedges, decorative metaphors,
  formulaic contrasts, forced threes, generic conclusions, em dashes, decorative
  emoji, and needless bolding; prefer plain precise words, active voice, and
  concrete facts. Use sentence case headings and straight quotes. Never announce
  the edit; cut knowledge-cutoff disclaimers. Preserve technical terms, exact
  claims, real uncertainty, accessibility, quotes, and the operator's voice. Load
  for editing passes or externally published prose.
license: MIT
metadata:
  upstream: https://github.com/cursor/plugins/blob/99559f2f52047978602ef365589275831e76af07/pstack/skills/unslop/SKILL.md
  upstream-commit: 99559f2f52047978602ef365589275831e76af07
  retrieved: 2026-08-25
---

# Prose quality

## Apply

Use for prose. Never rewrite code, strings, logs, errors, commands, config, fixtures,
quotes, licenses, third-party or unrequested human text. Do not sweep files.

Match the artifact: replies answer first; commits are terse and factual; PRs and reviews lead
with changes and evidence; issues state outcomes and tests; docs are concrete and runnable;
social drafts use the operator's voice, never an invented persona.

Apply the rules, then verify each claim, qualifier, number, command, and path.

## Rules

1. **Answer directly.** Cut praise and chat furniture like "Great question", "Certainly",
   "I hope this helps", and "Let me know if".
2. **Use plain words.** Prefer use over utilize, help over facilitate, and is or has over
   "serves as" or boasts. Cut crucial, robust, seamless, pivotal, tapestry, and delve.
3. **Name evidence.** Replace broad significance and feelings with the command, file,
   mechanism, source, or number. Cut sentences that fit any project unchanged.
4. **Avoid formulas.** No forced groups of three, "not just X, but Y", false ranges, generic
   conclusions, or empty tails such as "ensuring reliability".
5. **Cut filler, not uncertainty.** Reduce stacked hedges to one accurate qualifier. Keep
   uncertainty that changes the claim and explain its cause.
6. **Prefer active, readable sentences.** Name the actor when relevant. Keep one main idea
   per sentence. Replace weak adverbs with a stronger verb or measurement.
7. **Use real vocabulary.** Prefer plain mechanism names over decorative metaphors. Keep
   established project terms such as harness, gate, control plane, and worktree.
8. **Keep typography quiet.** Use sentence case and straight quotes. Avoid em dashes,
   decorative emoji, and repeated bolding. Keep accessible structure and labels.
9. **Attribute claims.** Replace "experts suggest" with a named source, concrete output,
   or nothing.
10. **Be natural, not fake.** Vary sentence length and recommend a direction when evidence
    supports it. Never invent opinions, anecdotes, or fake experience.

## Guardrails

Accuracy outranks style. Never weaken precision, alter a command or identifier, hide a failed
check, or turn uncertainty into certainty. Keep precise terms, accessibility, quoted text,
and the operator's established voice.

## Reference

Read the [pattern catalog](references/pattern-catalog.md) for a cleanup pass or when
a rule's call is unclear.

## Credit

Adapted from Lauren Tan's MIT-licensed `unslop` skill in pstack. See
[NOTICE.md](NOTICE.md).
