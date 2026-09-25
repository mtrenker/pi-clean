import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

import { ANSWER_LIMITS, answerBody } from "./answer.js";
import type { CancelReason, QuestionNote, QuestionOutcome, QuestionState } from "./question.js";

/** Operator input for one question. Lives above the Plate editor so editor recreation cannot erase it. */
export type QuestionDraft = { choice?: string; answer: string; notes: QuestionNote[]; noteText: string };

export type QuestionDesk = {
  state: QuestionState;
  draft: QuestionDraft;
  selectedId?: string;
  sending: boolean;
  error?: string;
  hidden: boolean;
  update: (change: Partial<QuestionDraft>) => void;
  addNote: () => void;
  removeNote: (index: number) => void;
  submit: (outcome: QuestionOutcome) => void;
  hide: () => void;
};

const EMPTY_DRAFT: QuestionDraft = { answer: "", notes: [], noteText: "" };

/**
 * `ancestors` are the anchor's containers, outermost first; the last one hosts the card as a row
 * immediately after the anchor.
 */
export type QuestionPlacement = { desk?: QuestionDesk; ancestors: Set<string>; hostId?: string };

export const QuestionContext = createContext<QuestionPlacement>({ ancestors: new Set() });

export function useQuestionDesk(
  state: QuestionState | undefined,
  selectedId: string | undefined,
  post: (body: unknown) => Promise<void>,
): QuestionDesk | undefined {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [hiddenId, setHiddenId] = useState<string>();
  const requestId = state?.requestId;

  useEffect(() => setError(undefined), [requestId, state?.status]);

  const update = useCallback((change: Partial<QuestionDraft>) => {
    if (!requestId) return;
    setDrafts((all) => ({ ...all, [requestId]: { ...(all[requestId] ?? EMPTY_DRAFT), ...change } }));
  }, [requestId]);

  if (!state) return undefined;
  const draft = drafts[state.requestId] ?? EMPTY_DRAFT;

  return {
    state,
    draft,
    selectedId,
    sending,
    error,
    hidden: hiddenId === state.requestId,
    update,
    addNote() {
      const text = draft.noteText.trim();
      if (!selectedId || !text || draft.notes.length >= ANSWER_LIMITS.notes) return;
      update({ notes: [...draft.notes, { nodeId: selectedId, text }], noteText: "" });
    },
    removeNote(index) {
      update({ notes: draft.notes.filter((_, position) => position !== index) });
    },
    submit(outcome) {
      if (sending || state.status !== "waiting") return;
      setSending(true);
      setError(undefined);
      void post(answerBody(state, outcome, draft))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
        .finally(() => setSending(false));
    },
    hide() {
      setHiddenId(state.requestId);
    },
  };
}

/**
 * Inserts the card into the host's rendered children right after the anchor. Slate renders one
 * element per child when chunking is off; if that ever changes, the card falls back to the end.
 */
export function withQuestionRow(children: React.ReactNode, childIds: Array<string | undefined>, desk: QuestionDesk): React.ReactNode {
  const card = <EditorIsland key="visual-design-question"><QuestionCard desk={desk} /></EditorIsland>;
  if (!Array.isArray(children) || children.length !== childIds.length) return <>{children}{card}</>;
  const index = childIds.indexOf(desk.state.anchorId);
  return [...children.slice(0, index + 1), card, ...children.slice(index + 1)];
}

/**
 * Keeps the form's events away from the read-only Slate editor and the canvas selection handlers.
 * The native listener stops Slate's own `beforeinput` handler, which would otherwise route
 * textarea undo to the editor.
 */
function EditorIsland({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    const stop = (event: Event) => event.stopPropagation();
    element?.addEventListener("beforeinput", stop);
    return () => element?.removeEventListener("beforeinput", stop);
  }, []);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      ref={ref}
      className="question-island"
      contentEditable={false}
      suppressContentEditableWarning
      data-question-card
      onClick={stop}
      onMouseDown={stop}
      onKeyDown={stop}
      onKeyUp={stop}
      onInput={stop}
      onBeforeInput={stop}
      onFocus={stop}
      onBlur={stop}
      onCopy={stop}
      onCut={stop}
      onPaste={stop}
      onDragStart={stop}
      onDrop={stop}
      onCompositionStart={stop}
      onCompositionUpdate={stop}
      onCompositionEnd={stop}
    >
      {children}
    </div>
  );
}

function QuestionCard({ desk }: { desk: QuestionDesk }) {
  const id = useId();
  const { state } = desk;
  const waiting = state.status === "waiting";

  return (
    <section className={`question-card question-${waiting ? "waiting" : "closed"}`} aria-labelledby={`${id}-title`}>
      <div className="question-kicker">
        <span className="question-badge">{waiting ? "Pi is waiting for you" : "Question closed"}</span>
        <span>asked about <code>#{state.anchorId}</code></span>
      </div>
      <h2 id={`${id}-title`}>{state.question}</h2>
      {waiting ? <QuestionForm desk={desk} id={id} /> : <ClosedSummary desk={desk} />}
    </section>
  );
}

function QuestionForm({ desk, id }: { desk: QuestionDesk; id: string }) {
  const { state, draft, sending, error, update } = desk;
  const canAnswer = !!draft.choice || !!draft.answer.trim();
  const canRevise = !!draft.answer.trim() || draft.notes.length > 0;

  return (
    <form
      className="question-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canAnswer) desk.submit("answered");
      }}
    >
      {state.choices.length > 0 && (
        <fieldset className="question-choices">
          <legend>Choose one</legend>
          {state.choices.map((choice) => (
            <label key={choice} className="question-choice">
              <input
                type="radio"
                name={`${id}-choice`}
                value={choice}
                checked={draft.choice === choice}
                onChange={() => update({ choice })}
              />
              <span>{choice}</span>
            </label>
          ))}
        </fieldset>
      )}

      <label className="question-label" htmlFor={`${id}-answer`}>
        {state.choices.length > 0 ? "Anything to add? (optional)" : "Your answer"}
      </label>
      <textarea
        id={`${id}-answer`}
        rows={3}
        maxLength={ANSWER_LIMITS.answer}
        value={draft.answer}
        onChange={(event) => update({ answer: event.target.value })}
      />

      <NoteComposer desk={desk} id={id} />

      <div className="question-actions">
        <button type="submit" className="question-primary" disabled={!canAnswer || sending}>
          {sending ? "Sending…" : "Send answer"}
        </button>
        <button type="button" disabled={!canRevise || sending} onClick={() => desk.submit("revise")}>
          Ask for a revision
        </button>
        <button type="button" className="question-quiet" disabled={sending} onClick={() => desk.submit("cancelled")}>
          Dismiss
        </button>
      </div>
      <p className="question-status" role="status" aria-live="polite">
        {error ? <span className="question-error">{error}</span> : null}
      </p>
      <p className="question-meta">
        Goes only to this Pi call, not into the design file. Not an approval of anything else.
        <span> Revision <code>{state.revision.slice(0, 8)}</code></span>
      </p>
    </form>
  );
}

function NoteComposer({ desk, id }: { desk: QuestionDesk; id: string }) {
  const { draft, selectedId, update } = desk;
  return (
    <div className="question-notes">
      {draft.notes.length > 0 && (
        <ul aria-label="Notes to send">
          {draft.notes.map((note, index) => (
            <li key={`${note.nodeId}-${index}`}>
              <code>#{note.nodeId}</code>
              <span>{note.text}</span>
              <button type="button" className="question-quiet" onClick={() => desk.removeNote(index)} aria-label={`Remove note on ${note.nodeId}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="question-label" htmlFor={`${id}-note`}>
        {selectedId ? <>Note on <code>#{selectedId}</code></> : "Note on a block"}
      </label>
      <div className="question-note-row">
        <input
          id={`${id}-note`}
          type="text"
          maxLength={ANSWER_LIMITS.noteText}
          value={draft.noteText}
          disabled={!selectedId}
          placeholder={selectedId ? "What should change here?" : "Select a block on the canvas first"}
          onChange={(event) => update({ noteText: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              desk.addNote();
            }
          }}
        />
        <button type="button" disabled={!selectedId || !draft.noteText.trim()} onClick={desk.addNote}>
          Add note
        </button>
      </div>
    </div>
  );
}

function ClosedSummary({ desk }: { desk: QuestionDesk }) {
  const { state, draft } = desk;
  if (state.status !== "closed") return null;
  const { response } = state;
  const unsent = response.outcome === "cancelled" && response.reason !== "operator" && (draft.answer.trim() || draft.notes.length > 0);
  return (
    <div className="question-closed-body">
      <p role="status">{closedLabel(response.outcome, response.reason)}</p>
      {response.choice && <p><strong>Choice:</strong> {response.choice}</p>}
      {response.answer && <p className="question-sent-text">{response.answer}</p>}
      {response.notes.length > 0 && (
        <ul aria-label="Notes sent">
          {response.notes.map((note, index) => <li key={index}><code>#{note.nodeId}</code> <span>{note.text}</span></li>)}
        </ul>
      )}
      {unsent && (
        <p className="question-unsent">
          Your unsent draft: {draft.answer.trim()}
          {draft.notes.map((note) => ` · #${note.nodeId}: ${note.text}`).join("")}
        </p>
      )}
      <button type="button" className="question-quiet" onClick={desk.hide}>Hide</button>
    </div>
  );
}

function closedLabel(outcome: QuestionOutcome, reason?: CancelReason): string {
  if (outcome === "answered") return "You answered. Pi is continuing.";
  if (outcome === "revise") return "You asked for a revision. Pi is continuing.";
  switch (reason) {
    case "document-changed": return "Closed without an answer: the design changed while it waited.";
    case "aborted": return "Closed without an answer: Pi stopped the request.";
    case "relay-stopped": return "Closed without an answer: the relay stopped.";
    default: return "You dismissed this question. Pi was told there is no answer.";
  }
}
