# Visual Design Relay (proof of concept)

A repo-native visual design experiment connecting Pi, a localhost server, a PlateJS renderer, and versioned JSON artifacts. It is deliberately a vertical slice rather than a general-purpose page editor.

## Start the relay

From a trusted repository containing a `*.design.json` file:

```text
/design designs/example.design.json
```

`/design` without arguments opens the included example. Pi reports a capability-bearing browser URL bound to `127.0.0.1`. Other commands:

```text
/design status
/design stop
```

The server starts only from the command, not extension initialization. `/reload`, session replacement, `/design stop`, and Pi shutdown close the HTTP server, SSE clients, watcher, timers, and active design state.

## Try the complete loop

1. Run `/design designs/example.design.json` and open the reported URL.
2. Select an outlined block. Its stable ID appears in the conversation rail.
3. Ask for a concrete change, such as “Make this headline shorter and move the action beneath the date card.” Choose **Queue next** or **Steer now** for an already-running agent.
4. Pi receives the instruction, repository-relative design path, selected node, and bounded ancestor/child/sibling summaries.
5. Pi uses `visual_design_mutate`; the single validated write path persists deterministic JSON and pushes the update to the browser.
6. Edit the JSON externally. A valid change appears live; malformed JSON produces a recoverable relay error and the last valid design remains visible.

## Artifact contract

The v1 document is Plate-compatible JSON:

```json
{
  "schemaVersion": 1,
  "title": "Example",
  "root": [
    {
      "id": "page-root",
      "type": "viewport",
      "children": [
        {
          "id": "intro-title",
          "type": "text",
          "variant": "display",
          "children": [{ "text": "A visible idea" }]
        }
      ]
    }
  ]
}
```

Addressable elements require unique stable IDs. Slate paths are never sent across the browser/agent boundary. The vocabulary is `viewport`, `section`, `stack`, `grid`, `surface`, `text`, and `button`; text and button children are Plate text leaves. Unknown node types, duplicate IDs, malformed leaves, unsupported class characters, and invalid post-mutation trees are rejected.

The renderer supports structural properties such as `tone`, `direction`, `columns`, and `variant`. Generic `className` is an escape hatch, not arbitrary CSS. Included utility classes are:

- layout: `align-center`, `align-end`, `justify-between`, `gap-sm`, `gap-lg`, `span-2`, `full-width`;
- spacing/measure: `pad-none`, `pad-lg`, `max-reading`;
- color: `text-signal`, `bg-paper`, `bg-ink`, `bg-gradient-ink-signal`.

## Mutation tool

`visual_design_mutate` supports one operation per call:

- `add`: insert a complete validated node under a stable parent ID;
- `move`: resolve a stable ID at call time and move it without allowing cycles;
- `remove`: remove a node, except the only root;
- `update_text`: replace the Plate text leaf of a text or button node;
- `update_properties`: merge non-structural properties; `null` removes one.

Mutations participate in Pi's per-file mutation queue so parallel built-in writes cannot race the tool's read/validate/write window.

## Security boundary

- The server listens on ephemeral port `127.0.0.1` only.
- Every page, asset, API, and SSE request requires a cryptographically random session capability.
- The active file must already exist, end in `.design.json`, and resolve inside the trusted current repository (including symlink resolution).
- Browser clients can request agent work but cannot directly mutate files.
- Request bodies and context depth are bounded; the server derives node context from its validated document rather than trusting browser-supplied JSON.
- The page uses a restrictive same-origin Content Security Policy.
- While the relay is open, its token-bearing tabs receive all Pi assistant status/output, not only turns initiated from the design browser. Close or stop the relay before unrelated sensitive work.

This is safe-localhost prototype behavior, not a production authentication or deployment model. Anyone who obtains the reported URL while the session is running has the session capability.

## Evaluation notes

### Observed strengths

- Stable IDs make “change this” concrete across selection, chat, mutations, and external file edits.
- A narrow mutation vocabulary produces reviewable diffs and preserves unrelated IDs more reliably than whole-file generation.
- The Plate/Slate tree maps naturally to approximate block composition while remaining plain repository JSON.
- SSE is enough for live file, status, and streamed-output feedback without adding a second socket protocol.
- The example remains recognizable at narrow widths because the artifact vocabulary expresses intent (grid, stack, section), not absolute coordinates.

### Friction

- The first `/design` call bundles the React/Plate client in memory, so cold start is noticeably heavier than serving handwritten JavaScript.
- Generic classes are useful only when agent and human know the relay's supported vocabulary. Agent mutations now reject unavailable names, while unknown classes in hand-edited files still have no visual effect.
- Plate is currently used as a read-only structured renderer. Recreating its editor for accepted external values is appropriate for this slice, but a future direct-manipulation editor would need operation-level synchronization to preserve selection and undo history.
- Conversation output survives browser reloads while the relay process is running, but it is not a durable per-node review thread and simultaneous tabs share one selection-independent Pi queue.

### Unresolved architecture questions

- Should an MVP compile a repository-owned token/class catalog into the prompt and browser instead of shipping fixed utility classes?
- Should browser selection and comments be session entries, sidecar files, or remain ephemeral?
- Can direct manipulation and Pi mutation share one Plate operation log without coupling artifact schema to editor internals?
- Is SSE plus HTTP sufficient for future multi-artifact sessions, or does operation acknowledgement justify a WebSocket protocol?
- How should large artifacts page or summarize context without losing the surrounding design argument?

## Recommendation

**Proceed, but revise before MVP.** The end-to-end loop is strong enough to justify a bounded follow-up: keep stable-ID artifacts, validated operations, and local capability security; next validate operation-level Plate synchronization and a repository-owned style catalog. Do not expand into production component mapping, drag-and-drop, durable review, or design-to-code until those two boundaries are proven.

## Validation

```bash
npm run test:visual-design
npm run test:extensions
npx tsc --noEmit
```
