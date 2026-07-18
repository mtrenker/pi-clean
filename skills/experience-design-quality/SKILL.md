---
name: experience-design-quality
description: Use when designing, implementing, or critiquing any user-facing digital experience, including product tools, flows, content, commerce, community, learning, care, marketing, and immersive work. Derives emotionally fitting, inviting, distinctive interface direction from context and carries it through responsive, accessible implementation.
---

# Experience Design Quality

Design the right experience, not a fashionable one. Emotion is a functional requirement: earn it through hierarchy, language, pacing, feedback, and recovery before decoration.

## 1. Read the situation

Inspect the product, real content/data, current UI, design tokens, components, technical constraints, and brand signals before proposing a direction. Preserve useful conventions; do not restyle the product by reflex.

Capture a compact experience brief:

- **Person and moment:** Who is here, in what environment, and what happened just before?
- **Job and content:** What must they understand, decide, create, or complete? At what volume and frequency?
- **Emotional arc:** What might they feel now, what should they feel next, and which feeling would be harmful?
- **Stakes and trust:** What is reversible, sensitive, consequential, or unfamiliar?
- **Constraints:** Existing brand/system, devices, accessibility needs, performance, localization, and implementation scope.
- **Success signal:** What observable outcome proves the experience helped?

Ask only about missing information that would materially change the design. Otherwise state the assumption and proceed.

## 2. Commit to an experience direction

Write a one-sentence thesis:

> This should feel **[qualities]**, because **[context]**, expressed through **[specific structural, visual, and behavioral moves]**.

For a new direction or substantial redesign, write a mini-constitution before interface code. For a bounded change, infer and restate the existing constitution first.

- **Emotional target:** two or three feelings plus an anti-feeling: “must not feel …”. Back every feeling with interaction evidence; reassurance might require visible status and recovery, not merely a calm color.
- **Center and intensity:** task, reading, conversation, transaction, progress, monitoring, or exploration; name where expression is welcome and where it must recede.
- **Constructive grammar:** surface strategy; chromatic budget and whether chrome or content carries color; type roles and emphasis mechanism; density; geometry; border/depth; imagery; motion; voice.
- **Signature:** two or three recurring moves and one memory hook tied to product content or behavior. In sensitive contexts, restraint, continuity, or unusually thoughtful language can be the signature.
- **Prohibitions:** at least one concrete visual or behavioral “never” in addition to the anti-feeling.

Example: “A medication-renewal flow should feel calm, capable, and human—never jaunty—because people may be unwell and uncertain. Use one stable warm-neutral surface, plain step language, visible save/status, and a restrained ink-and-teal palette; let typography and spacing carry hierarchy. No celebratory motion, surprise disclosure, or cute error copy.”

Do not average incompatible directions. Distinctiveness comes from a small coherent grammar, not maximum decoration. Before coding, apply the removal test: if the logo and nouns disappeared, would the direction still express something specific about this product? Read [the context playbook](references/context-playbook.md) whenever translating feelings or product context into that grammar.

## 3. Shape the experience before styling it

Model the path through the interface: entry → orientation → meaningful action or attention → feedback → continuation, exit, or recovery. Establish information hierarchy and interaction model before selecting surface treatments.

- Make the primary purpose legible in the first useful view.
- Reveal complexity in response to intent; do not merely hide it.
- Give every important action a clear consequence, status, and way back when possible.
- Design the whole state model: first use, empty, loading, partial, success, error, offline/stale, disabled, permission-limited, and destructive confirmation as relevant.
- Let content shape components. Test realistic long names, dense records, translations, missing media, and user-generated content.

## 4. Build a coherent language

Reuse the project's system first. When no system exists, define the smallest semantic foundation needed for consistency:

- **Typography:** roles and hierarchy, resilient fallback, and a readable measure (often 45–75 characters for sustained prose)—not font novelty alone.
- **Color:** surface, text, border, action, focus, and semantic status roles. Compute contrast for every pair and state; brand and status colors must not compete. If imagery or user content carries unpredictable color, make surrounding chrome quieter.
- **Space and density:** a rhythm matched to task frequency, content volume, and device; grouping should work without a border around everything.
- **Geometry and material:** corners, borders, depth, texture, and imagery should tell one material story.
- **Motion:** causal feedback, orientation, continuity, or reward. Settle timing and choreography as a system, with a reduced-motion equivalent.
- **Voice:** labels and messages should carry the same emotional posture as the visuals, especially in empty, waiting, error, and destructive states.
- **Modes:** explicitly support, derive, or decline dark/high-contrast modes based on product requirements; never apply a mechanical color inversion.

Make tokens encode the thesis rather than contradict it: opposed directions should produce meaningfully different color, type, radius, border, depth, and motion decisions. Tokens create consistency; they do not create direction by themselves.

## 5. Implement a complete vertical slice

Prefer one coherent, working slice over many polished fragments.

- Use semantic structure and native controls before custom behavior.
- Make keyboard, pointer, touch, screen-reader, zoom, and reduced-motion experiences first-class.
- Treat responsive design as reprioritization and reflow, not a shrunken desktop. Preserve the core job; change navigation, density, grouping, and disclosure when needed.
- Use real or representative content. Do not rely on lorem ipsum, fake testimonials, meaningless metrics, or ideal-length labels.
- Keep all interactive states visually and behaviorally related.
- Spend expression where attention is welcome; keep frequent or high-stakes operations calm and fast.
- If implementing in an existing codebase, respect its architecture and components. Improve nearby inconsistencies without broad unrelated rewrites.

## 6. Critique, then refine

Review in three passes:

1. **Usefulness:** Is the next meaningful step obvious? Are hierarchy, labels, feedback, and recovery clear?
2. **Emotional fit:** Does the experience create the intended feeling at the right moment? Is delight earned? Do the stakes feel respected?
3. **Coherence and resilience:** Do the signature moves recur with discipline? Does the design survive real content, states, input modes, and viewports?

When browser tools are available, inspect and interact at narrow, medium, and wide viewports. Navigate by keyboard, zoom text, trigger non-happy states, and check motion preferences. Without a browser, walk the state model in prose, test representative content lengths, verify token/contrast math, and inspect semantic and focus behavior in code. Fix the highest-impact mismatch, then repeat. Use [the quality review](references/quality-review.md) before calling the work complete.

## Avoid generic design by reflex

- Do not default to a giant hero, gradient headline, bento grid, glass cards, pill-shaped everything, or dashboard shell unless the content and task earn it.
- Do not turn every group into a floating card or every empty space into decoration.
- Do not mistake warm colors and rounded corners for empathy, dark glass for sophistication, or motion for delight.
- Do not copy a named visual style without translating it through this product's audience, content, and stakes.
- Do not let a memorable surface compete with reading, comparison, data entry, or urgent decisions.
- Do not ship hover-only affordances, color-only meaning, invisible focus, surprise motion, or inaccessible custom controls.

## Working output

For design guidance, communicate the brief, thesis, experience structure, signature system, key states, and risks. For implementation tasks, keep that reasoning compact and build; summarize the consequential choices and validation afterward rather than producing a long speculative design document.
