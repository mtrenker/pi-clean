import { budgetDimensions, type MandateBudget, type MandateSession } from "./mandate.ts";
import { classifyUrl, type ActionClass, type Classification, type SiteRules } from "./site-rules.ts";

/**
 * Trusted host-side authorization for bridged browser actions.
 *
 * This is the first of the two independent gates. It knows the mandate, the
 * rulebook, the last controller-reported URL, and the budget ledger; it never
 * trusts the worker for authority, only for the requested action. The browser
 * controller repeats every check inside the sandbox with its own rulebook copy
 * and its own view of the live DOM.
 */
export const SAFE_BRIDGE_PATHS = Object.freeze(["/navigate", "/snapshot", "/click", "/type", "/press"]);

export const PROFESSIONAL_SOCIALS_BRIDGE_PATHS = Object.freeze([
  "/ps/navigate",
  "/ps/snapshot",
  "/ps/act",
  "/ps/scroll",
  "/ps/wait",
  "/ps/back",
  "/ps/dialog",
  "/ps/upload",
  "/ps/checkpoint",
  "/ps/submit",
]);

export const MUTATING_ACT_OPS = Object.freeze(["fill", "clear", "check", "uncheck", "select", "combobox", "edit", "enter"]);
export const ACT_OPS = Object.freeze(["click", ...MUTATING_ACT_OPS]);
export const REF_PATTERN = /^e[0-9]{1,6}-[0-9]{1,4}$/;
export const MAX_TEXT_BYTES = 8 * 1024;
export const MAX_DECLARED_FIELDS = 32;
export const MAX_DECLARED_DIFF_BYTES = 64 * 1024;
/** Bridge envelopes stay small; the autonomous submit carries a declared diff. */
export const MAX_SAFE_REQUEST_BYTES = 64 * 1024;
export const MAX_PROFESSIONAL_SOCIALS_REQUEST_BYTES = 256 * 1024;

export type ActionKind = "read" | "edit" | "upload" | "submit" | "publish";

/**
 * Only genuine authorization refusals feed the circuit breaker. A malformed
 * worker request, a stale ref, a paused controller, or a human gate must not
 * revoke an otherwise valid task mandate.
 */
export const PUNITIVE_DENIALS: ReadonlySet<string> = new Set([
  "hard_deny_surface", "hard_deny_dialog", "hard_deny_heading", "surface_class_denied", "class_not_granted",
  "origin_not_authorized", "insecure_navigation", "dialog_not_authorized", "inline_edit_denied",
  "sensitive_field_denied", "submit_requires_declared_diff", "diff_mismatch", "enter_not_allowed",
  "not_a_commit_control", "commit_outside_dialog", "upload_type_denied",
]);

export function isPunitive(code: string | undefined): boolean {
  return code !== undefined && (PUNITIVE_DENIALS.has(code) || code.startsWith("budget_exhausted_"));
}

export interface BridgeState {
  lastUrl?: string;
}

export interface BridgeRequest {
  path: string;
  body?: unknown;
}

export interface ActionShape {
  action: string;
  kind: ActionKind;
  targetUrl?: string;
}

export interface BridgeDecision {
  allowed: boolean;
  code?: string;
  action: string;
  kind: ActionKind;
  actionClass?: ActionClass;
  classification?: Classification;
  budget?: Array<keyof MandateBudget>;
}

/** Structural validation of the worker-supplied request before any authority is consulted. */
export function describeAction(request: BridgeRequest): ActionShape | { error: string } {
  const body = (request.body ?? {}) as Record<string, unknown>;
  switch (request.path) {
    case "/ps/navigate": {
      if (typeof body.url !== "string" || body.url.length > 2048) return { error: "invalid_url" };
      return { action: "navigate", kind: "read", targetUrl: body.url };
    }
    case "/ps/snapshot":
      return { action: "snapshot", kind: "read" };
    case "/ps/scroll": {
      if (!["up", "down", "top", "bottom"].includes(String(body.direction))) return { error: "invalid_scroll" };
      return { action: "scroll", kind: "read" };
    }
    case "/ps/wait": {
      const ms = body.ms === undefined ? 0 : Number(body.ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > 20_000) return { error: "invalid_wait" };
      if (body.text !== undefined && (typeof body.text !== "string" || body.text.length > 200)) return { error: "invalid_wait" };
      return { action: "wait", kind: "read" };
    }
    case "/ps/back":
      return { action: "back", kind: "read" };
    case "/ps/dialog": {
      if (!["accept", "dismiss"].includes(String(body.action))) return { error: "invalid_dialog" };
      return { action: "dialog", kind: "read" };
    }
    case "/ps/checkpoint": {
      if (!Array.isArray(body.refs) || body.refs.length === 0 || body.refs.length > MAX_DECLARED_FIELDS) return { error: "invalid_checkpoint" };
      if (body.refs.some((ref) => typeof ref !== "string" || !REF_PATTERN.test(ref))) return { error: "invalid_ref" };
      return { action: "checkpoint", kind: "read" };
    }
    case "/ps/act": {
      const op = String(body.op);
      if (!ACT_OPS.includes(op)) return { error: "invalid_op" };
      if (typeof body.ref !== "string" || !REF_PATTERN.test(body.ref)) return { error: "invalid_ref" };
      if (body.text !== undefined && (typeof body.text !== "string" || Buffer.byteLength(body.text, "utf8") > MAX_TEXT_BYTES)) {
        return { error: "invalid_text" };
      }
      if (body.option !== undefined && (typeof body.option !== "string" || body.option.length > 400)) return { error: "invalid_option" };
      return { action: `act.${op}`, kind: op === "click" ? "read" : "edit" };
    }
    case "/ps/upload": {
      if (typeof body.ref !== "string" || !REF_PATTERN.test(body.ref)) return { error: "invalid_ref" };
      if (typeof body.artifact !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(body.artifact) || body.artifact.includes("..")) {
        return { error: "invalid_artifact" };
      }
      return { action: "upload", kind: "upload" };
    }
    case "/ps/submit": {
      if (typeof body.ref !== "string" || !REF_PATTERN.test(body.ref)) return { error: "invalid_ref" };
      if (typeof body.checkpointId !== "string" || !/^[a-f0-9-]{36}$/.test(body.checkpointId)) return { error: "invalid_checkpoint" };
      const intent = String(body.intent);
      if (!["submit-profile", "publish-post"].includes(intent)) return { error: "invalid_intent" };
      if (!Array.isArray(body.expected) || body.expected.length === 0 || body.expected.length > MAX_DECLARED_FIELDS) {
        return { error: "invalid_expected_diff" };
      }
      let declaredBytes = 0;
      for (const entry of body.expected as Array<Record<string, unknown>>) {
        if (!entry || typeof entry !== "object") return { error: "invalid_expected_diff" };
        if (typeof entry.ref !== "string" || !REF_PATTERN.test(entry.ref)) return { error: "invalid_ref" };
        if (typeof entry.before !== "string" || typeof entry.after !== "string") return { error: "invalid_expected_diff" };
        if (Buffer.byteLength(entry.after, "utf8") > MAX_TEXT_BYTES || Buffer.byteLength(entry.before, "utf8") > MAX_TEXT_BYTES) {
          return { error: "invalid_expected_diff" };
        }
        declaredBytes += Buffer.byteLength(entry.before, "utf8") + Buffer.byteLength(entry.after, "utf8");
        if (declaredBytes > MAX_DECLARED_DIFF_BYTES) return { error: "invalid_expected_diff" };
      }
      return { action: intent === "publish-post" ? "publish" : "submit", kind: intent === "publish-post" ? "publish" : "submit" };
    }
    default:
      return { error: "path_not_allowed" };
  }
}

/** The mutating class a surface offers, intersected with the mandate grant. */
export function mutatingClassFor(classification: Classification, granted: string[]): ActionClass | undefined {
  for (const candidate of ["edit-profile", "publish-post"] as const) {
    if (classification.classes.includes(candidate) && granted.includes(candidate)) return candidate;
  }
  return undefined;
}

export function authorizeBridgeAction(
  rules: SiteRules,
  session: MandateSession,
  state: BridgeState,
  request: BridgeRequest,
): BridgeDecision {
  const shape = describeAction(request);
  if ("error" in shape) return { allowed: false, code: shape.error, action: "invalid", kind: "read" };
  const { action, kind } = shape;
  if (session.revoked) return { allowed: false, code: `mandate_revoked:${session.revocation}`, action, kind };

  const mandate = session.mandate;
  if (Date.now() > Date.parse(mandate.expiresAt)) {
    session.revoke("expired");
    return { allowed: false, code: "mandate_expired", action, kind };
  }

  const url = shape.targetUrl ?? state.lastUrl;
  // Before the first navigation there is no page to classify. Reads are
  // harmless there; anything mutating needs a classified authorized surface.
  if (!url) {
    if (kind !== "read") return { allowed: false, code: "no_current_page", action, kind };
    return { allowed: true, action, kind, actionClass: "read", budget: budgetDimensions("read", "read") };
  }
  const classification = classifyUrl(rules, url);
  if (classification.hardDeny) return { allowed: false, code: "hard_deny_surface", action, kind, classification };

  if (shape.targetUrl) {
    // Explicit navigation is confined to mandate origins. A site-initiated
    // redirect can still land elsewhere; such a page classifies as read-only.
    if (!url.toLowerCase().startsWith("https://")) return { allowed: false, code: "insecure_navigation", action, kind, classification };
    if (!mandate.origins.includes(classification.host)) {
      return { allowed: false, code: "origin_not_authorized", action, kind, classification };
    }
  }

  let actionClass: ActionClass = "read";
  if (kind === "submit" || kind === "publish") {
    actionClass = kind === "publish" ? "publish-post" : "submit-profile";
    if (!mandate.actionClasses.includes(actionClass)) return { allowed: false, code: "class_not_granted", action, kind, classification };
    if (!classification.classes.includes(actionClass)) return { allowed: false, code: "surface_class_denied", action, kind, classification };
  } else if (kind === "edit" || kind === "upload") {
    const granted = mutatingClassFor(classification, mandate.actionClasses);
    if (!granted) return { allowed: false, code: "surface_class_denied", action, kind, classification };
    actionClass = granted;
  } else if (!mandate.origins.includes(classification.host) && classification.surfaceId !== "unlisted") {
    // Reads outside the mandate origins stay possible but are recorded.
    actionClass = "read";
  }

  if (actionClass !== "read" && !mandate.origins.includes(classification.host)) {
    return { allowed: false, code: "origin_not_authorized", action, kind, classification };
  }

  const budget = budgetDimensions(actionClass, kind);
  const exhausted = session.checkBudget(budget);
  if (exhausted) return { allowed: false, code: exhausted, action, kind, actionClass, classification, budget };
  return { allowed: true, action, kind, actionClass, classification, budget };
}
