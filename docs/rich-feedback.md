# Inline browser questions for visual design

Issue [#49](https://github.com/mtrenker/pi-clean/issues/49) adds one awaited question round trip to
the existing `/design` relay. This record is the bounded contract for the first slice. It evolves
`extensions/visual-design` additively: no parallel questionnaire app, editor rewrite, or new store.

## Contract

The agent calls `visual_design_ask` while `/design` is running:

| Parameter | Rule |
| --- | --- |
| `question` | 1–500 characters, rendered as plain text. |
| `anchorId` | Existing nested container node (`viewport`, `section`, `stack`, `grid`, `surface`) holding the proposal. Root nodes are rejected. The question renders immediately after the anchor as a full-width row of its parent. |
| `choices` | Optional, 2–6 distinct labels of at most 120 characters each. |

The call blocks until one outcome, then returns it to that exact tool call:

| Outcome | Meaning |
| --- | --- |
| `answered` | The operator picked a choice or wrote an answer, possibly with notes. |
| `revise` | The operator asks for the proposal to change first. Guidance text or at least one note is required. |
| `cancelled` | No answer. `reason` is `operator`, `document-changed`, `aborted`, or `relay-stopped`. |

An answer is at most 4,000 characters. Notes are `{ nodeId, text }` pairs, at most 10 of 1,000
characters each, anchored to a node the operator selected on the canvas. The browser inputs enforce
the same limits. A dismissal sends only `requestId`, `revision`, and `outcome`. The server ignores
any draft fields on a dismissal, so an oversized or invalid draft cannot block it. The result `details` record `requestId`, `toolCallId`,
`sessionId`, `leafId`, `revision`, `anchorId`, the question, choices, outcome, and response. The
model-facing text states that the response is design feedback for this question only and is not
authorization for any other action. A cancelled result says no answer was given.

## Binding and invalidation

- **One pending question per relay.** A second ask while one waits fails. The tool runs sequentially.
- **Request identity.** The server generates a random `requestId`. An answer must quote it and the
  question's `revision`, the SHA-256 prefix of the canonical serialized document.
- **Revision.** Any accepted document change (a `visual_design_mutate` call or an external edit)
  and any rejected malformed edit to the file cancels the pending question with
  `document-changed`. A stale or duplicate submission gets HTTP 409 and never becomes an answer.
  Re-serializing identical content does not change the revision.
- **Session and branch.** `/tree` is refused while a question waits, with a notice to answer or
  dismiss it, or stop Pi, first. Pi moves the leaf and replaces the agent's messages before
  `session_tree` fires, so cancelling there would put the tool result and the continued turn on the
  new branch. The veto uses `session_before_tree` instead. This replaces the first slice's
  `branch-changed` cancellation. Session switch, fork, reload, and quit already stop the relay,
  which cancels with `relay-stopped`, as do `/design stop` and opening another design file. Tool
  abort cancels with `aborted`.
- **Single resolution.** The server clears the pending question before resolving, so a retry or
  second tab gets 409.

## Where answers live

Answers are never written to the `.design.json` file, which the agent can edit. They exist only as
the tool result in the Pi session branch, plus a relay timeline entry for replay while the relay
runs. Choices are labels, not approval buttons. A skipped question or a note is not agreement.

## HTTP boundary

`POST /api/answer` reuses the loopback bind, capability token, 16 KiB body limit, and CSP. It also
requires `Content-Type: application/json`, a `Host` of the relay's own `127.0.0.1:<port>`, and an
`Origin` equal to the relay origin. `POST /api/chat` now also rejects a mismatched `Host` or a
present, mismatched `Origin`. Node IDs in notes are checked against the server's current document.

## Browser behavior

- **Placement (accepted by Martin at the checkpoint):** the card renders immediately after the
  proposal as a full-width row of the surrounding layout. In a grid it spans all columns and the
  grid packs densely, so it follows the proposal's row without splitting that row. The anchor keeps
  its own layout and gets an outline tying it to the card, which hovering does not replace. The first checkpoint put the card inside
  the anchor, which squeezed a 265px column and distorted the proposal being judged.
- The card is a `contentEditable={false}` island that stops editor event propagation, so Slate
  never sees its input.
- The anchor's ancestors, which contain the card, switch from `role="button"` to `role="group"`, so
  the form is never nested in button semantics. They remain clickable and keyboard-selectable, and
  the anchor itself stays a button. Keyboard selection ignores bubbled events, which fixes Enter
  selecting the outermost ancestor.
- Draft answer, choice, and notes live in App state keyed by `requestId`, above the Plate editor,
  so document re-renders and editor recreation do not erase typing. A page reload discards drafts.
- While a question waits, the chat composer is paused with a pointer to the card: a queued chat
  message cannot resolve a waiting tool call.
- The relay panel states that the page mirrors all output of the hosting Pi session.

## Tradeoffs

- **Inline row after the proposal, not inside it or in a "Needs you" rail.** Keeps the question next
  to the proposal without distorting it. It costs anchor-type restrictions (no text, button, or
  root anchors) and a role change on the anchor's ancestors.
- **Any document change invalidates.** This is simpler and safer than diffing whether the change
  touched the anchor, at the price of occasionally re-asking.
- **Refuse `/tree` rather than cancel around it.** Cancelling in `session_before_tree` and letting
  navigation continue would race the tool result against the leaf move. Refusing keeps the result
  on the asking branch, at the cost of making the operator answer, dismiss, or stop Pi first.
- **In-memory pending state.** A Pi restart loses the question; the tool call is gone then too.

## Deferred

Diagrams, embedded previews, multi-question sheets, direct document editing, approval buttons,
draft persistence across reloads, TUI fallback answers, cross-agent adapters, and durable threads.
