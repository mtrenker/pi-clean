// Browser-safe: bundled into the client, so it must not import Node modules.
import type { PublicQuestion, QuestionNote, QuestionOutcome } from "./question.ts";

/** Field limits shared by the browser form and the server so drafts stay within what is accepted. */
export const ANSWER_LIMITS = { answer: 4_000, noteText: 1_000, notes: 10 } as const;

/** The browser's answer request. A dismissal carries only identity and outcome, never the draft. */
export function answerBody(
  question: PublicQuestion,
  outcome: QuestionOutcome,
  draft: { choice?: string; answer: string; notes: QuestionNote[] },
): Record<string, unknown> {
  const identity = { requestId: question.requestId, revision: question.revision, outcome };
  if (outcome === "cancelled") return identity;
  return { ...identity, choice: draft.choice, answer: draft.answer, notes: draft.notes };
}
