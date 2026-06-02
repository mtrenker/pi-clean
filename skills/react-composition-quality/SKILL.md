---
name: react-composition-quality
description: Use for React pages, components, features, props, and hooks. Guides composition, simple UI contracts, render-ready data, and maintainability without enforcing folder structure.
---

# React Composition Quality

No folder-structure doctrine. Preserve project conventions. Optimize for readable, owner-friendly React.

## Rules

- Pages = composition only: named features/components + minimal glue.
- Avoid page logic. Extract non-trivial conditionals, mapping, sorting, grouping, formatting, state flows into component/feature/hook.
- Page may compose many features and call many hooks if clearer.
- Feature = meaningful UI capability; may contain components, hooks, helpers, smaller features.
- Props = simple UI contracts: `string`, `number`, `boolean`, arrays of primitives, small UI-focused objects.
- Object props: explicit local type; no raw API/query/ORM/CMS/domain objects unless truly local and stable.
- Component interface describes render needs, not data source shape.
- Deep prop drilling = composition smell. Prefer sibling features, closer hook ownership, narrower boundary, or minimal render-ready values.
- Hooks return render-ready data when UI needs derivation. Keep mapping/sorting/grouping/filtering/labels out of render code.
- Raw query data may pass through only when no render prep needed.

## Review Heuristics

Ask:

- Page reads as composition, not implementation?
- Logic has a named home?
- Props small, native, UI-shaped?
- External data models hidden behind local types/hooks?
- No unused pass-through props across layers?
- Derived data prepared before render?
- Feature/component purpose obvious from name + interface?

## Refactor Bias

Small safe steps: name concept → extract boundary → move derivation near hook/feature → simplify props → avoid broad reorgs unless requested.
