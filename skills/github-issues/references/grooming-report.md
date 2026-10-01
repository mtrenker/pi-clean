# Grooming report format

Reference for [the issues skill](../SKILL.md), used when reporting a project grooming pass.

Make the report useful to someone who does not remember issue numbers. Never use a bare issue or
pull-request number as the primary description of work.

- On first mention, render a linked identifier and exact title, for example
  `[#64 — Add atomic Codex form command](URL)`. In a distant section, repeat the title rather than
  expecting the reader to recall it.
- Describe relationships in plain language: name both items, say which one blocks the other, and
  explain the practical consequence for the queue.
- Translate mechanical findings into workflow impact. “Structurally clean” must say what was
  checked and must not imply that scope, priority, or semantic readiness is sound.
- For every item needing attention, include **why it matters**, the **specific recommended change**,
  and the **resulting next state or next action**. If recommending a split, name the outcome retained
  by the current issue and the proposed sibling outcomes.
- Distinguish facts observed on GitHub from recommendations. Do not present a future gate date,
  readiness judgment, or proposed restructuring without explaining its source and consequence.
- Ask for the smallest decision needed from the operator. Phrase alternatives by outcome and title,
  not number alone, and recommend a default when the evidence supports one.

Lead with the update shape from the shared policy. **Result:** counts plus a one-sentence
interpretation of flow and capacity. **Check:** a link to the Project view. **Your turn:** the
decision. Then add these sections, omitting empty ones:

1. **Ready queue / active work:** one row per relevant item with linked title, priority/size/readiness,
   why it is or is not actionable, and the next move.
2. **Dependencies and review gates:** named relationships, failed checks, and when/how they clear.
3. **Attention and proposed changes:** concrete diagnosis, recommendation, and expected queue effect.

Do not enumerate every healthy backlog item merely for completeness. Do include every Ready,
In-progress, In-review, blocked-near-Ready, or otherwise actionable item; summarize the rest by count.
