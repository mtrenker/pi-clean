# Experience quality review

Review the implemented experience, not only its ideal screenshot. Record concrete failures and fix the highest-impact ones first.

## Start with contrast cases

A robust direction should produce materially different answers to these cases:

1. **Benefits application:** calm, dignified, linear, resumable, and plain-language; visible document requirements and help. No celebratory friction or playful errors.
2. **Children's science exhibit:** exploratory and sensory with a safe first interaction, strong wayfinding, robust touch and keyboard alternatives, captions, and reduced-motion mode.
3. **Language practice:** encouraging but not childish; short practice loops, specific corrective feedback, meaningful progress, and opt-in reward intensity.
4. **Incident response tool:** dense and restrained; anomaly and chronology dominate, with fast keyboard action, provenance, acknowledgment, and protection from destructive changes.
5. **Long-form investigation:** editorial pacing, comfortable measure, evidence and provenance, persistent place, annotations, and quiet navigation rather than card grids.

If typography, palette, layout, or interaction could move between all five with minor token swaps, the direction is too generic.

## Purpose and invitation

- A new user can tell what this is, what matters now, and what they can do next.
- In marketing/reading hybrids, headings plus one visual cue per section communicate the argument at skim speed; deeper reading adds substance rather than basic orientation.
- The first commitment is proportionate to the value already shown.
- Primary and secondary actions are distinguishable by more than location.
- Navigation, cancellation, and recovery match the consequence of the task.
- Copy names the user's outcome rather than the interface mechanism when possible.

## Emotional fit and trust

- The emotional thesis is evident in behavior and content, not only palette or corner radius.
- Every feeling in the constitution has visible evidence; its anti-feeling is absent.
- The posture changes appropriately across exploration, action, waiting, success, failure, and destructive moments.
- Sensitive steps explain consequences before commitment and avoid pressure, shame, cuteness, or false urgency.
- Feedback is timely and proportionate. Delight follows value rather than interrupting it.
- Prices, limits, uncertainty, system status, authorship, and data use are represented honestly.

## Structure and content

- Hierarchy follows task and content priority rather than component availability.
- At thumbnail zoom, the full experience has a deliberate silhouette: identifiable peaks, rests, density changes, and emphasis where the argument or task needs it.
- Repeated sections do not collapse into one uniform texture; restraint still produces rhythm and a clear visual center of gravity.
- Related content groups without requiring a card for every section; reading order remains semantic.
- Content-derived diagrams, specimens, and annotations clarify or prove the thesis rather than restating it decoratively.
- Realistic short, long, missing, translated, messy-image, and user-generated content does not break the design.
- Dense information supports scan, compare, filter, and drill-down; prose supports measure, rhythm, and return paths.
- Empty states explain why they exist and offer a meaningful next step when available.

## System coherence and distinctiveness

- Typography, color, space, geometry, depth, imagery, voice, and motion support one constitution.
- Every named typeface is actually loaded or the design has been reviewed against its first guaranteed fallback.
- Repeated micro-labels remain legible in the rendered interface; avoid depending on sub-12px text, especially with tracked capitals or audiences likely to benefit from larger type.
- Tokens encode the prose: surface strategy, chromatic budget, emphasis, radius, border, and depth do not revert to framework defaults.
- Contrast is computed for actual color pairs and states, not asserted from token names.
- Brand/action/status colors remain distinguishable; content-carried color has quiet enough chrome.
- Signature moves recur with discipline. One-off values are eliminated or justified by meaning.
- Removing branding does not reduce the result to an interchangeable template.
- Decoration can disappear without losing affordances; removing an affordance is never mistaken for minimalism.

## States and interaction

Exercise what applies: default, hover, focus-visible, pressed, selected/current, disabled/read-only, first use, empty, loading/progress, partial/stale/offline, validation, blocking error/retry, success/undo, permission limits, destructive confirmation, timeout, autosave, optimistic updates, and concurrent changes.

- Focus remains visible and logical through overlays, menus, dynamic updates, errors, and routes.
- Feedback does not depend on hover, motion, color, or sound alone.
- Forms keep persistent labels, associate instructions/errors programmatically, summarize errors in long flows, and preserve input after failure.
- Consequential actions explain impact and support cancel, undo, or recovery where possible.

## Responsive resilience

Inspect narrow, medium, wide, short, and zoomed viewports.

- Reflow by priority; do not compress the desktop arrangement or merely serialize it into a rhythmically flat stack.
- The core action remains reachable without obscuring content or requiring precision.
- Navigation changes deliberately and retains orientation.
- Tables, diagrams, timelines, signature compositions, and toolbars have an intentional narrow strategy: reframe, scroll with cues, disclose, simplify, or provide an equivalent view. Shrinking until labels or meaning weaken is a failure, not a responsive strategy.
- Touch targets meet WCAG 2.2 AA's 24×24 CSS-pixel minimum or documented exceptions; prefer about 44×44 for touch-primary controls.
- Text enlarges to 200% without loss; reflow works at 400% zoom where applicable.
- Virtual keyboards, safe areas, orientation, sticky regions, and long pages do not trap or obscure controls.

## Accessibility and inclusion

Use WCAG 2.2 AA as a baseline, adjusted upward for audience and risk.

- Semantic HTML/native controls, names, roles, states, relationships, landmarks, headings, and table structure are correct.
- Keyboard order is logical, focus visible, useful skip paths exist, and no interaction traps users.
- Text and meaningful non-text contrast pass in every state; meaning has a non-color cue.
- Images and media have appropriate alternatives, captions/transcripts, and controllable playback.
- Dynamic status is announced without noise; focus moves only to improve orientation.
- Reduced motion preserves meaning. Avoid or control flashing, parallax, autoplay, and vestibular effects.
- Language is plain and non-blaming. Dates, names, addresses, numbers, text expansion, RTL, and formats do not assume one locale or identity.
- Timeouts, authentication, drag/drop, and complex gestures have accessible alternatives.

Automated checks help but do not replace keyboard use, screen-reader spot checks, zoom/reflow inspection, and contrast testing.

## Performance and implementation

- The useful view appears promptly and stays stable; fonts, imagery, motion, and effects justify their cost.
- Loading communicates actual progress without fabricating certainty.
- Components use project primitives and semantic tokens; abstractions follow repeated meaning rather than visual coincidence.
- Responsive and state behavior sits near the component that owns it.
- Platform behavior replaces fragile timing or layout measurement where possible.
- Console errors, broken links, overflow, clipped focus rings, layout shifts, and dark/high-contrast mode defects are resolved.
