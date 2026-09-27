import { ANSWER_LIMITS } from "./answer.ts";
import { findNode, type DesignDocument } from "./design.ts";

export const QUESTION_OUTCOMES = ["answered", "revise", "cancelled"] as const;
export type QuestionOutcome = (typeof QUESTION_OUTCOMES)[number];
export type CancelReason = "operator" | "document-changed" | "aborted" | "relay-stopped";

export type QuestionAsk = {
  question: string;
  anchorId: string;
  choices?: string[];
};

export type QuestionNote = { nodeId: string; text: string };

/** What the browser needs to render and answer a waiting question. */
export type PublicQuestion = {
  requestId: string;
  revision: string;
  anchorId: string;
  question: string;
  choices: string[];
};

export type QuestionResponse = {
  outcome: QuestionOutcome;
  reason?: CancelReason;
  choice?: string;
  answer?: string;
  notes: QuestionNote[];
};

/** Browser-visible state of the most recent question. */
export type QuestionState = PublicQuestion & (
  | { status: "waiting" }
  | { status: "closed"; response: QuestionResponse }
);

const CONTAINER_TYPES = new Set(["viewport", "section", "stack", "grid", "surface"]);

export function validateAsk(input: QuestionAsk, document: DesignDocument): Required<QuestionAsk> {
  const question = input.question.trim();
  if (!question || question.length > 500) throw new Error("question must be 1-500 characters");
  const anchor = findNode(document, input.anchorId);
  if (!anchor) throw new Error(`anchorId not found in the active design: ${input.anchorId}`);
  if (!CONTAINER_TYPES.has(anchor.node.type)) {
    throw new Error(`anchorId must reference a container (${[...CONTAINER_TYPES].join(", ")}), not ${anchor.node.type}`);
  }
  // The card renders as a row of the anchor's parent, so a root node cannot hold a question.
  if (!anchor.parent) throw new Error("anchorId must be nested inside another container, not a root node");
  const choices = (input.choices ?? []).map((choice) => choice.trim());
  if (choices.length > 0) {
    if (choices.length < 2 || choices.length > 6) throw new Error("choices must contain 2-6 labels");
    if (choices.some((choice) => !choice || choice.length > 120)) throw new Error("each choice must be 1-120 characters");
    if (new Set(choices).size !== choices.length) throw new Error("choices must be distinct");
  }
  return { question, anchorId: anchor.node.id, choices };
}

/**
 * Validates an untrusted browser submission against the waiting question. Identity checks
 * (requestId, revision) happen in the server so it can answer 409 rather than 400.
 */
export function parseResponse(
  body: Record<string, unknown>,
  question: PublicQuestion,
  document: DesignDocument,
): QuestionResponse {
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !(QUESTION_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`outcome must be one of: ${QUESTION_OUTCOMES.join(", ")}`);
  }
  // A dismissal ignores any draft fields, so an invalid or oversized draft cannot block it.
  if (outcome === "cancelled") return { outcome, reason: "operator", notes: [] };
  const answer = optionalText(body.answer, "answer", ANSWER_LIMITS.answer);
  const choice = optionalText(body.choice, "choice", 120);
  if (choice !== undefined && !question.choices.includes(choice)) throw new Error("choice is not one of the offered choices");
  const notes = parseNotes(body.notes, document);

  if (outcome === "answered" && choice === undefined && answer === undefined) {
    throw new Error("An answer needs a choice or answer text");
  }
  if (outcome === "revise" && answer === undefined && notes.length === 0) {
    throw new Error("A revision request needs guidance text or at least one note");
  }
  return {
    outcome: outcome as QuestionOutcome,
    ...(outcome === "answered" && choice !== undefined ? { choice } : {}),
    ...(answer !== undefined ? { answer } : {}),
    notes,
  };
}

/** Model-facing text. States plainly that this is not authorization and that cancellation is not agreement. */
export function describeResponse(question: PublicQuestion, response: QuestionResponse): string {
  const lines = [`Operator response to design question ${question.requestId} (revision ${question.revision}): ${response.outcome}.`];
  if (response.outcome === "cancelled") {
    lines.push(`No answer was given (reason: ${response.reason}). Do not treat this as agreement.`);
    if (response.reason === "document-changed") lines.push("The design changed while the question waited; re-read it before asking again.");
  }
  if (response.choice) lines.push(`Choice: ${response.choice}`);
  if (response.answer) lines.push(`${response.outcome === "revise" ? "Revision guidance" : "Answer"}: ${response.answer}`);
  if (response.notes.length > 0) {
    lines.push("Notes:");
    for (const note of response.notes) lines.push(`- #${note.nodeId}: ${note.text}`);
  }
  lines.push("This is design feedback for this question only. It is not authorization for any other action.");
  return lines.join("\n");
}

/** One-line timeline entry for the relay history. */
export function summarizeResponse(response: QuestionResponse): string {
  const notes = response.notes.length > 0 ? ` (${response.notes.length} note${response.notes.length === 1 ? "" : "s"})` : "";
  switch (response.outcome) {
    case "answered":
      return `Answered: ${[response.choice, response.answer].filter(Boolean).join(" — ")}${notes}`;
    case "revise":
      return `Asked for a revision${response.answer ? `: ${response.answer}` : ""}${notes}`;
    case "cancelled":
      return CANCEL_SUMMARIES[response.reason ?? "operator"];
  }
}

const CANCEL_SUMMARIES: Record<CancelReason, string> = {
  operator: "Dismissed the question without answering",
  "document-changed": "Question closed: the design changed while it waited",
  aborted: "Question closed: Pi stopped the request",
  "relay-stopped": "Question closed: the relay stopped",
};

function parseNotes(value: unknown, document: DesignDocument): QuestionNote[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ANSWER_LIMITS.notes) {
    throw new Error(`notes must be an array of at most ${ANSWER_LIMITS.notes}`);
  }
  return value.map((note, index) => {
    if (!note || typeof note !== "object") throw new Error(`notes[${index}] must be an object`);
    const { nodeId, text } = note as Record<string, unknown>;
    if (typeof nodeId !== "string" || !findNode(document, nodeId)) throw new Error(`notes[${index}].nodeId is not in the design`);
    const trimmed = optionalText(text, `notes[${index}].text`, ANSWER_LIMITS.noteText);
    if (trimmed === undefined) throw new Error(`notes[${index}].text must not be empty`);
    return { nodeId, text: trimmed };
  });
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`);
  return trimmed || undefined;
}
