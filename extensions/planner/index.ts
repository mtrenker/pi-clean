/**
 * Planner extension — interactive interview → draft → challenge → PLAN.md flow.
 *
 * Registers /planner command. Produces fleet-compatible PLAN.md output and
 * runs fleet validation after finalization.
 *
 * State machine:
 *   [idle]
 *     → /planner invoked
 *       → goal collected (inline or via editor)
 *       → topic classified (heuristic)
 *       → depth selected (ctx.ui.select)
 *       → interview questionnaire (ctx.ui.custom tab-bar)
 *         → [drafting] LLM turn for draft plan
 *           → agent_end: send challenge prompt → [challenging]
 *             → agent_end: show review menu
 *               → "Finalize" → write PLAN.md → [done]
 *               → "Refine"   → editor → [drafting] (loop)
 *               → "Challenge harder" → [challenging] (loop)
 *               → "Start over" → depth + interview → [drafting]
 *               → "Cancel" → [cancelled]
 */

import fs from "fs/promises";
import path from "path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@mariozechner/pi-coding-agent";
import { getInterviewQuestions, runInterview } from "./interview.js";
import { loadValidatedPlan } from "../fleet/plan.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type PlannerTopic =
  | "feature"
  | "refactor"
  | "migration"
  | "bug"
  | "infra"
  | "security"
  | "spike";

type PlannerDepth = "spike" | "mvp" | "internal" | "production" | "security";

/**
 * "draft"       — waiting for the LLM to produce the first draft plan.
 * "challenge"   — draft received; waiting for the challenge/critique turn.
 * null          — not waiting for any LLM response (review menu is active or session idle).
 */
type AwaitingResponse = "draft" | "challenge" | null;

interface PlannerSession {
  phase: "active" | "done" | "cancelled";
  awaitingResponse: AwaitingResponse;
  goal: string;
  topic: PlannerTopic;
  depth: PlannerDepth;
  answers: Record<string, string>;
  refinementRound: number;
}

// ── Module-level state ─────────────────────────────────────────────────────────

/** The in-progress planner session, if any. Survives soft reloads. */
let plannerSession: PlannerSession | null = null;

/** One-shot validation marker set when finalization asks the LLM to write PLAN.md. */
let pendingPlanValidation: { cwd: string } | null = null;

/** Cached content of skills/fleet-planner/SKILL.md. Loaded lazily on first active turn. */
let plannerSkillCache: string | null = null;

// ── Depth taxonomy ─────────────────────────────────────────────────────────────

const DEPTH_KEYS: PlannerDepth[] = ["spike", "mvp", "internal", "production", "security"];

const DEPTH_LABELS: Record<PlannerDepth, string> = {
  spike: "Spike / Explore",
  mvp: "MVP / Ship Fast",
  internal: "Internal Tool",
  production: "Production Ready",
  security: "Security-Hardened",
};

/** Topic-adapted depth descriptions, keyed by depth then topic (or "default"). */
const DEPTH_DESCRIPTIONS: Record<PlannerDepth, Record<string, string>> = {
  spike: {
    feature: "Spike the concept — prove feasibility in the least time possible",
    refactor: "Exploratory refactor — try the approach, validate it works",
    migration: "Spike migration path — find the least-effort route",
    bug: "Isolate the bug — reproduce reliably, identify root cause",
    infra: "PoC infra — get something running somewhere",
    security: "⚠ not recommended — auto-elevating to Internal for security work",
    spike: "Spike only — minimal path to a learning",
    default: "Prove a concept in minimal time. Production concerns out of scope. 2–5 tasks.",
  },
  mvp: {
    feature: "Ship the v1 — working feature with deliberate shortcuts",
    refactor: "Pragmatic cleanup — improve quality without gold-plating",
    migration: "Fast migration — move the thing, basic rollback",
    bug: "Fix and ship — solve it, add a basic regression test",
    infra: "Quick infra setup — running and accessible",
    security: "⚠ not recommended — auto-elevating to Internal for security work",
    spike: "N/A — spike work at MVP scope is contradictory",
    default: "Ship to real users fast. Deliberate shortcuts are named and accepted. 4–10 tasks.",
  },
  internal: {
    feature: "Internal feature — reliable for team use, full error handling",
    refactor: "Internal quality — good enough for the team to maintain",
    migration: "Low-risk migration — rollback tested, documented for operators",
    bug: "Fix thoroughly — fix + tests + known edge cases covered",
    infra: "Internal infra — reliable, operator-documented",
    security: "Baseline security — internal threat model, basic hardening",
    spike: "N/A — internal scope defeats the spike's purpose",
    default: "Built for a known set of users. Reliability matters. 6–15 tasks.",
  },
  production: {
    feature: "Production feature — full observability, auth, rollback plan",
    refactor: "Safe refactor — tests, gradual rollout, rollback monitoring",
    migration: "Full migration — zero-downtime, rollback, monitoring",
    bug: "Fix + regression suite — root cause, tests, monitoring alert",
    infra: "Production infra — resilient, observable, on-call runbook",
    security: "Production security — threat model, auditing, compliance baseline",
    spike: "N/A — production depth defeats the spike's purpose",
    default: "Serves external users at scale. All engineering best practices. 10–25 tasks.",
  },
  security: {
    feature: "Security-critical feature — zero-trust, threat model, compliance",
    refactor: "Hardened refactor — security review at every trust boundary",
    migration: "Compliance migration — audit trail, data classification",
    bug: "Security patch — CVE severity, coordinated disclosure plan",
    infra: "Hardened infra — least-privilege, audit logging, secrets management",
    security: "Full hardening — STRIDE threat model, compliance checkpoint",
    spike: "N/A — security work at spike depth creates vulnerabilities",
    default: "Handles sensitive data or high-value attack paths. Zero-trust, compliance-first. 15–35 tasks.",
  },
};

/** Build the display strings for the depth selector. */
function depthOptions(topic: PlannerTopic): string[] {
  return DEPTH_KEYS.map((key) => {
    const label = DEPTH_LABELS[key];
    const desc =
      DEPTH_DESCRIPTIONS[key][topic] ?? DEPTH_DESCRIPTIONS[key]["default"]!;
    return `${label} — ${desc}`;
  });
}

/** Extract the PlannerDepth key given the index in the depthOptions() array. */
function extractDepthKey(idx: number): PlannerDepth {
  return DEPTH_KEYS[idx] ?? "internal";
}

/** Human-readable depth definition for the draft prompt. */
function depthDefinition(depth: PlannerDepth): string {
  const defs: Record<PlannerDepth, string> = {
    spike: "Prove a concept in minimal time. Production concerns explicitly out of scope. 2–5 tasks.",
    mvp: "Ship to real users fast. Deliberate shortcuts are named and accepted. 4–10 tasks.",
    internal: "Built for a known set of users. Reliability matters. 6–15 tasks.",
    production: "Serves external users at scale. All engineering best practices apply. 10–25 tasks.",
    security:
      "Handles sensitive data or high-value attack paths. Zero-trust, compliance-first. 15–35 tasks.",
  };
  return defs[depth];
}

// ── Topic classification ───────────────────────────────────────────────────────

/**
 * Classify the goal text into a topic using keyword heuristics.
 * No LLM call — fast and deterministic.
 */
function classifyTopic(goal: string): PlannerTopic {
  const s = goal.toLowerCase();

  if (/\b(fix|bug|crash|error|broken|not working|issue|regression|defect|intermittent)\b/.test(s))
    return "bug";

  if (
    /\b(auth|security|cve|gdpr|compliance|audit|pentest|zero.?trust|vulnerability|threat|exploit|breach|pii|encrypt)\b/.test(
      s,
    )
  )
    return "security";

  if (
    /\b(explore|spike|prototype|proof.?of.?concept|experiment|poc|feasibility|investigate|research)\b/.test(
      s,
    )
  )
    return "spike";

  if (
    /\b(migrat|upgrade|move.?from|replace.?\w+.?with|transition|port\b|migrate)\b/.test(s)
  )
    return "migration";

  if (
    /\b(refactor|rewrite|clean.?up|extract|split|restructure|rename|reorganize|decouple|modularize)\b/.test(
      s,
    )
  )
    return "refactor";

  if (
    /\b(deploy|infra|terraform|kubernetes|docker|ci|pipeline|devops|helm|k8s|ansible|nginx|cdn|dns|vpc|subnet|cluster)\b/.test(
      s,
    )
  )
    return "infra";

  return "feature";
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}

// ── Prompt builders ────────────────────────────────────────────────────────────

function buildDraftPrompt(session: PlannerSession): string {
  const answerBlock = Object.entries(session.answers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");

  return `[PLANNER CONTEXT — Round ${session.refinementRound + 1}]
Goal: ${session.goal}
Topic: ${session.topic}
Depth: ${DEPTH_LABELS[session.depth]} — ${depthDefinition(session.depth)}

Interview answers:
${answerBlock}

Please produce a draft PLAN.md in the fleet task format. The plan must include:
- A "# Plan: <title>" header
- A "## Overview" section (2–4 paragraphs: goal, approach, key decisions, scope boundaries)
- A "## Tasks" section with "### Task NNN: <name>" entries

Scope and task count must match the ${DEPTH_LABELS[session.depth]} depth profile.
See the planner doctrine in your system prompt for quality standards and output format.

Do NOT write the file yet — output the plan as markdown in your response.`;
}

function buildChallengePrompt(abbreviate: boolean): string {
  if (abbreviate) {
    return `[PLANNER CHALLENGE PASS — abbreviated for ${abbreviate ? "spike/mvp" : ""} depth]

Review the draft plan you just produced. For each point below, be specific and name
actual tasks or sections by number:

1. List any implicit scale assumptions (e.g. "this works at 100 users but not at 100k")
4. Identify the top 3 tradeoffs the user should consciously acknowledge before proceeding

Then re-output the complete, final plan as markdown (without the challenge commentary
mixed in — put the "## Challenges & Tradeoffs" section at the very end after ## Tasks).`;
  }

  return `[PLANNER CHALLENGE PASS]

Review the draft plan you just produced. For each point below, be specific and name
actual tasks or sections by number:

1. List any implicit scale assumptions (e.g. "this works at 100 users but may not at 100k")
2. List any security assumptions that may be wrong (e.g. "the API is assumed to receive trusted input")
3. List any dependency assumptions that could block delivery (e.g. "assumes the third-party API has the needed endpoint")
4. Identify the top 3 tradeoffs the user should be aware of
5. Flag any tasks that look underspecified or likely to expand in scope

Then re-output the complete, final plan as markdown. Structure the response as:
1. The full updated "# Plan: ..." with all sections (## Overview, ## Tasks)
2. Then a "## Challenges & Tradeoffs" section with your analysis

The plan should incorporate any fixes suggested by your challenge analysis.`;
}

function buildDeeperChallengePrompt(depth: PlannerDepth): string {
  return `[PLANNER DEEPER CHALLENGE]

Act as a senior engineer reviewing this plan with genuine skepticism. Go further:
- What's the single most likely way this plan fails in production?
- What did we forget to ask during requirements gathering?
- Are there tasks that are missing entirely — ones that will surprise the team mid-execution?
- Is the dependency ordering correct, or will tasks block each other unnecessarily?
- For the ${DEPTH_LABELS[depth]} depth profile: what quality shortcuts have been made that we should name explicitly so the team can revisit them?

Output your analysis, then output a fully updated plan draft that addresses any issues you found.
Structure as: full updated plan first, then "## Challenges & Tradeoffs" analysis.`;
}

// ── Skill content loading ──────────────────────────────────────────────────────

async function loadPlannerSkill(cwd: string): Promise<string> {
  if (plannerSkillCache !== null) return plannerSkillCache;

  const skillPath = path.join(cwd, "skills", "fleet-planner", "SKILL.md");
  const raw = await fs.readFile(skillPath, "utf-8");
  // Strip YAML frontmatter if present
  plannerSkillCache = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
  return plannerSkillCache;
}

// ── Review menu ────────────────────────────────────────────────────────────────

/**
 * Show the post-draft review menu and handle the user's choice.
 * Called from the agent_end handler after the challenge turn completes.
 */
async function showReviewMenu(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: PlannerSession,
): Promise<void> {
  const choice = await ctx.ui.select("Plan draft ready — what next?", [
    "Finalize and write PLAN.md",
    "Refine — add more context or change scope",
    "Challenge harder — poke more holes",
    "Start over with different depth",
    "Cancel",
  ]);

  if (!choice || choice === "Cancel") {
    session.phase = "cancelled";
    plannerSession = null;
    ctx.ui.notify("Planner session cancelled. Run /planner to start again.", "info");
    pi.appendEntry("planner-state", { phase: "cancelled", goal: session.goal });
    return;
  }

  // ── Finalize ─────────────────────────────────────────────────────────────────
  if (choice === "Finalize and write PLAN.md") {
    await runFinalization(pi, ctx, session);
    return;
  }

  // ── Refine ───────────────────────────────────────────────────────────────────
  if (choice === "Refine — add more context or change scope") {
    const refinementText = await ctx.ui.editor(
      "Add context, adjust scope, or provide feedback on the draft:",
      "",
    );
    if (!refinementText?.trim()) {
      ctx.ui.notify("No refinement text entered. Run /planner to return to the review menu.", "info");
      return;
    }
    session.awaitingResponse = "draft";
    session.refinementRound++;
    pi.appendEntry("planner-state", { ...session });
    pi.sendUserMessage(refinementText.trim());
    return;
  }

  // ── Challenge harder ──────────────────────────────────────────────────────────
  if (choice === "Challenge harder — poke more holes") {
    session.awaitingResponse = "challenge";
    pi.appendEntry("planner-state", { ...session });
    pi.sendUserMessage(buildDeeperChallengePrompt(session.depth));
    return;
  }

  // ── Start over with different depth ──────────────────────────────────────────
  if (choice === "Start over with different depth") {
    const depthChoices = depthOptions(session.topic);
    const newDepthChoice = await ctx.ui.select(
      `Choose new planning depth for: "${truncate(session.goal, 55)}"`,
      depthChoices,
    );
    if (!newDepthChoice) {
      ctx.ui.notify("Depth selection cancelled.", "info");
      return;
    }

    const newDepthIdx = depthChoices.indexOf(newDepthChoice);
    const newDepth = extractDepthKey(newDepthIdx);

    // Security-topic safety check
    if (session.topic === "security" && (newDepth === "spike" || newDepth === "mvp")) {
      const proceed = await ctx.ui.confirm(
        "Depth warning",
        `Security work at ${DEPTH_LABELS[newDepth]} depth often creates technical debt that becomes a vulnerability. Continue anyway?`,
      );
      if (!proceed) return;
    }

    session.depth = newDepth;

    // Re-run interview with previous answers pre-filled
    const questions = getInterviewQuestions(session.topic, newDepth);
    ctx.ui.notify(`Restarting interview with ${DEPTH_LABELS[newDepth]} depth…`, "info");
    const newAnswers = await runInterview(ctx.ui, questions, session.answers);
    if (!newAnswers) {
      ctx.ui.notify("Interview cancelled.", "info");
      return;
    }

    session.answers = newAnswers;
    session.awaitingResponse = "draft";
    session.refinementRound++;
    pi.appendEntry("planner-state", { ...session });
    pi.sendUserMessage(buildDraftPrompt(session));
    return;
  }
}

// ── Finalization ───────────────────────────────────────────────────────────────

/**
 * Confirm with the user, then instruct the LLM to write PLAN.md using its write tool.
 * This is more reliable than extracting the plan text from the conversation since
 * the LLM has the full plan in context and knows exactly what to write.
 */
async function runFinalization(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  session: PlannerSession,
): Promise<void> {
  ctx.ui.notify("Plan draft is shown above. Confirm to write PLAN.md.", "info");

  const planPath = path.join(ctx.cwd, "PLAN.md");
  let overwriteNote = "";
  try {
    await fs.access(planPath);
    overwriteNote = " This will overwrite the existing PLAN.md.";
  } catch {
    // File doesn't exist — no overwrite warning needed
  }

  const confirmed = await ctx.ui.confirm(
    "Write PLAN.md?",
    `Write the finalized plan to ${planPath}?${overwriteNote}`,
  );

  if (!confirmed) {
    // Return to review menu
    ctx.ui.notify("Write cancelled. Returning to review menu.", "info");
    await showReviewMenu(pi, ctx, session);
    return;
  }

  // Mark session done before triggering the LLM turn
  session.phase = "done";
  plannerSession = null;
  pi.appendEntry("planner-state", { phase: "done", goal: session.goal });

  // Ask the LLM to write the file. The LLM has the full plan in context.
  pi.sendUserMessage(
    `Please write the final PLAN.md to ${planPath} now using the write file tool.\n\n` +
      `Write the plan content only (# Plan: header, ## Overview, ## Tasks sections). ` +
      `Do not include the Challenges & Tradeoffs analysis in the file — that was ` +
      `for our review only.\n\n` +
      `After writing, report the task count and suggest running /fleet:split to create task folders.`,
  );

  pendingPlanValidation = { cwd: ctx.cwd };
  ctx.ui.notify("Writing PLAN.md…", "info");
}

// ── Extension factory ──────────────────────────────────────────────────────────

const plannerExtension: ExtensionFactory = (pi) => {
  // ── session_start: offer resume ─────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    if (!plannerSession || plannerSession.phase !== "active") return;
    if (!ctx.hasUI) return;

    const resume = await ctx.ui.select(
      `Planner session in progress: "${truncate(plannerSession.goal, 50)}"`,
      ["Resume from where I left off", "Abandon session", "Cancel"],
    );

    if (!resume || resume === "Cancel") return;

    if (resume === "Abandon session") {
      plannerSession = null;
      ctx.ui.notify("Previous planner session discarded.", "info");
    }
    // "Resume" — session already in memory; agent_end handler will pick it up
    // on the next LLM turn if awaitingResponse is set, or user can /planner to
    // manually trigger the review menu.
  });

  // ── before_agent_start: inject planner skill into system prompt ────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (!plannerSession || plannerSession.phase !== "active") return;

    const skillContent = await loadPlannerSkill(ctx.cwd);

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n---\n\n## Active Planner Session\n\n" +
        skillContent,
    };
  });

  // ── agent_end: challenge pass + review menu ────────────────────────────────

  pi.on("agent_end", async (_event, ctx) => {
    if (pendingPlanValidation && pendingPlanValidation.cwd === ctx.cwd) {
      pendingPlanValidation = null;
      try {
        const validatedPlan = await loadValidatedPlan(ctx.cwd);
        if (validatedPlan.normalizedContent.trim() !== validatedPlan.sourceContent.trim()) {
          await fs.writeFile(validatedPlan.planPath, validatedPlan.normalizedContent, "utf-8");
          ctx.ui.notify("PLAN.md validated and normalized to fleet format.", "info");
        } else {
          ctx.ui.notify("PLAN.md validated and is fleet-compatible.", "info");
        }
        ctx.ui.notify(
          `Finalized ${validatedPlan.document.tasks.length} task(s). Next step: run /fleet:split.`,
          "info",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `PLAN.md validation failed after write: ${message}. Refine and rewrite the plan before splitting.`,
          "error",
        );
      }
      return;
    }

    if (!plannerSession || plannerSession.phase !== "active") return;

    if (plannerSession.awaitingResponse === "draft") {
      // Draft turn finished — run the challenge pass
      const abbreviate =
        plannerSession.depth === "spike" || plannerSession.depth === "mvp";
      const challengePrompt = buildChallengePrompt(abbreviate);
      plannerSession.awaitingResponse = "challenge";
      pi.appendEntry("planner-state", { ...plannerSession });
      pi.sendUserMessage(challengePrompt);
      return;
    }

    if (plannerSession.awaitingResponse === "challenge") {
      // Challenge turn finished — show review menu
      plannerSession.awaitingResponse = null;
      pi.appendEntry("planner-state", { ...plannerSession });
      await showReviewMenu(pi, ctx, plannerSession);
      return;
    }
  });

  // ── /planner command ────────────────────────────────────────────────────────

  pi.registerCommand("planner", {
    description:
      "Interactive planning assistant: guided interview → draft plan → challenge → PLAN.md",

    async handler(args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "/planner requires an interactive UI session (not available in RPC/print mode).",
          "error",
        );
        return;
      }

      // ── Resume check ────────────────────────────────────────────────────────
      if (plannerSession?.phase === "active") {
        const resume = await ctx.ui.select(
          `Planner session in progress: "${truncate(plannerSession.goal, 50)}"`,
          ["Resume from where I left off", "Start a new plan", "Cancel"],
        );

        if (!resume || resume === "Cancel") return;

        if (resume === "Resume from where I left off") {
          const round = plannerSession.refinementRound;
          ctx.ui.notify(
            `Resuming planner session (${DEPTH_LABELS[plannerSession.depth]}, round ${round + 1})`,
            "info",
          );
          return;
        }

        // "Start a new plan" — discard old session and fall through
        plannerSession = null;
      }

      // ── Goal collection ─────────────────────────────────────────────────────
      let goal = args.trim();

      if (!goal) {
        const goalText = await ctx.ui.editor(
          "Describe what you want to build or change.\n" +
            "Be as brief or detailed as you like — the interview will fill in the details.",
          "",
        );
        if (!goalText?.trim()) {
          ctx.ui.notify("No goal provided. Planner cancelled.", "info");
          return;
        }
        goal = goalText.trim();
      }

      // ── Topic classification ────────────────────────────────────────────────
      const topic = classifyTopic(goal);

      // ── Depth selection — THE first explicit interaction ────────────────────
      const depthChoices = depthOptions(topic);
      const depthChoice = await ctx.ui.select(
        `Planning depth for: "${truncate(goal, 60)}"`,
        depthChoices,
      );

      if (!depthChoice) {
        ctx.ui.notify("No depth selected. Planner cancelled.", "info");
        return;
      }

      const depthIdx = depthChoices.indexOf(depthChoice);
      let depth = extractDepthKey(depthIdx);

      // Security-topic auto-elevation warning
      if (topic === "security" && (depth === "spike" || depth === "mvp")) {
        const proceed = await ctx.ui.confirm(
          "Depth warning for security work",
          `Security work at ${DEPTH_LABELS[depth]} depth often creates technical debt that ` +
            `later becomes a vulnerability. Are you sure you want ${DEPTH_LABELS[depth]}? ` +
            `(Select No to go back and pick Internal or higher.)`,
        );
        if (!proceed) {
          ctx.ui.notify(
            "Consider Internal, Production Ready, or Security-Hardened for security work.",
            "warning",
          );
          return;
        }
      }

      // ── Interview questionnaire ─────────────────────────────────────────────
      ctx.ui.notify(
        `Depth: ${DEPTH_LABELS[depth]}. Starting interview…`,
        "info",
      );

      const questions = getInterviewQuestions(topic, depth);
      const answers = await runInterview(ctx.ui, questions);

      if (!answers) {
        ctx.ui.notify("Interview cancelled. Planner cancelled.", "info");
        return;
      }

      // ── Initialize planner session ──────────────────────────────────────────
      plannerSession = {
        phase: "active",
        awaitingResponse: "draft",
        goal,
        topic,
        depth,
        answers,
        refinementRound: 0,
      };

      pi.appendEntry("planner-state", { ...plannerSession });

      const answeredCount = Object.keys(answers).length;
      ctx.ui.notify(
        `Interview complete (${answeredCount} questions answered). Generating draft plan…`,
        "info",
      );

      // ── Trigger draft generation turn ───────────────────────────────────────
      pi.sendUserMessage(buildDraftPrompt(plannerSession));
    },
  });
};

export default plannerExtension;
