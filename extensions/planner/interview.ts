/**
 * Planner interview TUI — multi-step questionnaire for the interview phase.
 *
 * Implements a tab-bar questionnaire using the pi-tui custom component pattern.
 * Questions are selected based on (topic, depth) at call time.
 */

import { Editor, type EditorTheme, Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface InterviewQuestion {
  /** Unique identifier for this question (used as answer map key). */
  id: string;
  /** Short label shown in the tab bar (e.g. "Scope", "Users"). */
  label: string;
  /** Full question text displayed to the user. */
  prompt: string;
  /** Selectable options (a "Type something…" option is always appended). */
  options: string[];
}

// ── Universal questions (all topics, all depths) ───────────────────────────────

const UNIVERSAL_QUESTIONS: InterviewQuestion[] = [
  {
    id: "scope",
    label: "Scope",
    prompt: "What is in scope for this plan?",
    options: [
      "Start from scratch",
      "Extend existing code",
      "Replace existing system",
      "Unclear",
    ],
  },
  {
    id: "users",
    label: "Users",
    prompt: "Who are the direct users of the output?",
    options: [
      "Just me",
      "My team",
      "Internal org",
      "External customers",
      "Automated systems only",
    ],
  },
  {
    id: "timeline",
    label: "Timeline",
    prompt: "What's the delivery horizon?",
    options: [
      "Days (< 1 week)",
      "Weeks (1–4 weeks)",
      "Months (> 1 month)",
      "No deadline",
    ],
  },
  {
    id: "codebase",
    label: "Codebase",
    prompt: "How mature is the existing codebase?",
    options: [
      "New / greenfield",
      "Active / well-structured",
      "Legacy / tech debt",
      "External dependency",
    ],
  },
];

// ── Topic-specific question banks ──────────────────────────────────────────────

const TOPIC_QUESTIONS: Record<string, InterviewQuestion[]> = {
  feature: [
    {
      id: "ux_surface",
      label: "UX surface",
      prompt: "Where does the feature live?",
      options: ["API only", "Web UI", "Mobile", "CLI", "Background job", "Multiple surfaces"],
    },
    {
      id: "data",
      label: "Data",
      prompt: "Does this feature introduce new persistent state?",
      options: ["Yes — new schema", "Yes — extends schema", "No new state", "Unclear"],
    },
    {
      id: "auth",
      label: "Auth",
      prompt: "What's the auth model for this feature?",
      options: ["Public (no auth)", "Authenticated users", "Role-based", "Service-to-service", "TBD"],
    },
    {
      id: "integrations",
      label: "Integrations",
      prompt: "Does this depend on external services?",
      options: ["Yes — 3rd-party API", "Yes — internal service", "Yes — both", "No", "Unknown"],
    },
  ],

  refactor: [
    {
      id: "refactor_scope",
      label: "Width",
      prompt: "How wide is the refactor?",
      options: ["Single file", "Single module", "Multiple modules", "Cross-service"],
    },
    {
      id: "risk",
      label: "Risk",
      prompt: "Is the code under test?",
      options: ["Full test coverage", "Partial coverage", "Minimal coverage", "No tests"],
    },
    {
      id: "behavior",
      label: "Behavior",
      prompt: "Should behavior change?",
      options: ["Strictly no behavior change", "Minor improvements allowed", "Open to behavior changes"],
    },
    {
      id: "rollout",
      label: "Rollout",
      prompt: "How is this deployed?",
      options: ["One-shot migration", "Feature-flagged", "Parallel run", "Gradual rollout"],
    },
  ],

  migration: [
    {
      id: "migration_type",
      label: "Type",
      prompt: "What is being migrated?",
      options: ["Database schema", "Infrastructure", "Framework/library", "Data (bulk records)", "Auth system"],
    },
    {
      id: "volume",
      label: "Volume",
      prompt: "What is the data/traffic volume?",
      options: ["Small (< 10k records)", "Medium (10k–1M records)", "Large (> 1M records)", "No persistent data"],
    },
    {
      id: "downtime",
      label: "Downtime",
      prompt: "Is downtime acceptable?",
      options: ["Yes, full downtime window", "Short window only", "Zero downtime required", "Unknown"],
    },
    {
      id: "rollback",
      label: "Rollback",
      prompt: "Is rollback required?",
      options: ["Yes, full rollback plan", "Partial rollback", "Rollback not required"],
    },
  ],

  bug: [
    {
      id: "severity",
      label: "Severity",
      prompt: "How severe is the bug?",
      options: ["P0 (production down)", "P1 (significant user impact)", "P2 (notable but limited)", "P3 (minor)"],
    },
    {
      id: "reproduction",
      label: "Repro",
      prompt: "Can it be reproduced reliably?",
      options: ["Yes, always", "Yes, sometimes", "Only in production", "Not yet reproducible"],
    },
    {
      id: "root_cause",
      label: "Root cause",
      prompt: "Is the root cause known?",
      options: ["Yes, confirmed", "Suspected", "Unknown"],
    },
    {
      id: "regression",
      label: "Regression",
      prompt: "Is there a risk of regression?",
      options: ["High", "Medium", "Low", "Unknown"],
    },
  ],

  infra: [
    {
      id: "cloud",
      label: "Cloud",
      prompt: "What is the deployment target?",
      options: ["AWS", "GCP", "Azure", "Self-hosted", "Multi-cloud", "Unknown"],
    },
    {
      id: "state",
      label: "State",
      prompt: "Is this stateful infrastructure?",
      options: ["Yes — managed database", "Yes — persistent volumes", "No — stateless", "Mixed"],
    },
    {
      id: "traffic",
      label: "Traffic",
      prompt: "Expected traffic level?",
      options: ["Low (< 100 rps)", "Medium (100–10k rps)", "High (> 10k rps)", "Batch only"],
    },
    {
      id: "iac",
      label: "IaC",
      prompt: "Is infrastructure-as-code in use?",
      options: ["Yes — Terraform", "Yes — Pulumi", "Yes — CDK", "No", "Starting from scratch"],
    },
  ],

  security: [
    {
      id: "sec_category",
      label: "Category",
      prompt: "What type of security work?",
      options: [
        "Auth/identity",
        "Access control",
        "Data encryption",
        "Compliance",
        "Vulnerability fix",
        "Threat modeling",
      ],
    },
    {
      id: "compliance",
      label: "Compliance",
      prompt: "Which standards apply?",
      options: ["None", "SOC 2", "HIPAA", "PCI-DSS", "GDPR", "ISO 27001", "Multiple"],
    },
    {
      id: "attack_surface",
      label: "Surface",
      prompt: "What is the attack surface?",
      options: ["Internal only", "Internet-facing API", "Browser/client-side", "Mobile", "Mixed"],
    },
    {
      id: "sensitivity",
      label: "Sensitivity",
      prompt: "What data is involved?",
      options: ["None", "PII", "Financial", "Healthcare", "Credentials/secrets", "Multiple"],
    },
  ],

  spike: [
    {
      id: "spike_surface",
      label: "Surface",
      prompt: "Where does this spike live?",
      options: ["API/backend", "Web UI", "CLI/tooling", "Data/ML", "Infrastructure", "Multiple"],
    },
    {
      id: "exit_criterion",
      label: "Exit criteria",
      prompt: "What does 'spike complete' look like?",
      options: [
        "Proof of concept running",
        "Performance benchmark done",
        "API integration verified",
        "Architecture decision made",
        "Other",
      ],
    },
    {
      id: "risk_area",
      label: "Risk area",
      prompt: "What's the primary technical risk being explored?",
      options: [
        "Feasibility unknown",
        "Performance concern",
        "Third-party API viability",
        "Scalability question",
        "Security model",
        "Other",
      ],
    },
    {
      id: "throwaway",
      label: "Throwaway?",
      prompt: "Will the spike code be discarded?",
      options: ["Yes, fully throwaway", "Some parts reusable", "Plan to evolve it", "Unclear"],
    },
  ],
};

// ── Depth-conditional extra questions ──────────────────────────────────────────

/** Extra questions for production depth. */
const PRODUCTION_CONDITIONAL: InterviewQuestion[] = [
  {
    id: "observability",
    label: "Observability",
    prompt: "What observability is required?",
    options: ["Basic logging only", "Structured logs + metrics", "Full traces + alerting", "Already have it"],
  },
  {
    id: "failure_modes",
    label: "Failure modes",
    prompt: "What's the fallback when this fails?",
    options: ["Users see an error", "Graceful degradation", "Silent failure ok", "Not yet defined"],
  },
  {
    id: "rollback_plan",
    label: "Rollback",
    prompt: "What's the rollback plan?",
    options: ["Revert deploy", "Feature flag off", "Database rollback", "No plan yet"],
  },
];

/** Extra questions for security depth (overrides production variants). */
const SECURITY_CONDITIONAL: InterviewQuestion[] = [
  {
    id: "observability",
    label: "Observability",
    prompt: "What observability is required?",
    options: ["Full audit trail", "SIEM integration", "Real-time alerting", "Existing SOC"],
  },
  {
    id: "failure_modes",
    label: "Failure modes",
    prompt: "What's the fallback when this fails?",
    options: ["Fail-closed (deny by default)", "Fail-open acceptable", "Defined incident plan"],
  },
  {
    id: "rollback_plan",
    label: "Rollback",
    prompt: "What's the rollback plan?",
    options: ["Immediate rollback + audit event", "Staged rollback", "Forensic preservation needed"],
  },
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the interview question list for a given topic + depth combination.
 * Always includes universal questions, then topic-specific ones,
 * then depth-conditional extras for production/security depth.
 */
export function getInterviewQuestions(topic: string, depth: string): InterviewQuestion[] {
  const topicQs = TOPIC_QUESTIONS[topic] ?? TOPIC_QUESTIONS["feature"]!;
  const questions: InterviewQuestion[] = [...UNIVERSAL_QUESTIONS, ...topicQs];

  if (depth === "production") {
    questions.push(...PRODUCTION_CONDITIONAL);
  } else if (depth === "security") {
    questions.push(...SECURITY_CONDITIONAL);
  }

  return questions;
}

/**
 * Run the interview questionnaire TUI. Returns a map of questionId → answer string,
 * or null if the user cancelled.
 *
 * @param ui - The ExtensionUIContext from the current command/event context.
 * @param questions - The questions to ask (from getInterviewQuestions()).
 * @param previousAnswers - Optional pre-filled answers (for "Start over" flow).
 */
export async function runInterview(
  ui: ExtensionUIContext,
  questions: InterviewQuestion[],
  previousAnswers?: Record<string, string>,
): Promise<Record<string, string> | null> {
  const totalTabs = questions.length + 1; // questions + Submit tab

  const result = await ui.custom<{ answers: Record<string, string>; cancelled: boolean }>(
    (tui, theme, _kb, done) => {
      // ── State ──────────────────────────────────────────────────────────────
      let currentTab = 0;
      let optionIndex = 0;
      let inputMode = false;
      let inputQuestionId: string | null = null;
      let cachedLines: string[] | undefined;

      // Pre-fill from previous answers
      const answers = new Map<string, string>(Object.entries(previousAnswers ?? {}));

      // Pre-set option cursor for pre-filled questions
      function initOptionIndex() {
        const q = questions[currentTab];
        if (!q) return;
        const prev = answers.get(q.id);
        if (prev) {
          const idx = q.options.indexOf(prev);
          optionIndex = idx >= 0 ? idx : 0;
        } else {
          optionIndex = 0;
        }
      }
      initOptionIndex();

      // ── Editor for "Type something…" ───────────────────────────────────────
      const editorTheme: EditorTheme = {
        borderColor: (s) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        },
      };
      const editor = new Editor(tui, editorTheme);

      // ── Helpers ────────────────────────────────────────────────────────────
      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function submit(cancelled: boolean) {
        const ans: Record<string, string> = {};
        for (const [k, v] of answers) ans[k] = v;
        done({ answers: ans, cancelled });
      }

      function currentQuestion(): InterviewQuestion | undefined {
        return questions[currentTab];
      }

      /** Options for the current tab, with "Type something…" appended. */
      function currentOptions(): string[] {
        const q = currentQuestion();
        if (!q) return [];
        return [...q.options, "Type something…"];
      }

      function allAnswered(): boolean {
        return questions.every((q) => answers.has(q.id));
      }

      function advanceTab() {
        if (currentTab < questions.length - 1) {
          currentTab++;
        } else {
          currentTab = questions.length; // Submit tab
        }
        initOptionIndex();
        refresh();
      }

      // ── Editor submit ──────────────────────────────────────────────────────
      editor.onSubmit = (value) => {
        if (!inputQuestionId) return;
        const trimmed = value.trim() || "(no response)";
        answers.set(inputQuestionId, trimmed);
        inputMode = false;
        inputQuestionId = null;
        editor.setText("");
        advanceTab();
      };

      // ── Input handler ──────────────────────────────────────────────────────
      function handleInput(data: string) {
        // Route to editor when in input mode
        if (inputMode) {
          if (matchesKey(data, Key.escape)) {
            inputMode = false;
            inputQuestionId = null;
            editor.setText("");
            refresh();
            return;
          }
          editor.handleInput(data);
          refresh();
          return;
        }

        // Tab navigation
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
          currentTab = (currentTab + 1) % totalTabs;
          initOptionIndex();
          refresh();
          return;
        }
        if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
          currentTab = (currentTab - 1 + totalTabs) % totalTabs;
          initOptionIndex();
          refresh();
          return;
        }

        // Submit tab behaviour
        if (currentTab === questions.length) {
          if (matchesKey(data, Key.enter) && allAnswered()) {
            submit(false);
          } else if (matchesKey(data, Key.escape)) {
            submit(true);
          }
          return;
        }

        const opts = currentOptions();

        // Option navigation
        if (matchesKey(data, Key.up)) {
          optionIndex = Math.max(0, optionIndex - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          optionIndex = Math.min(opts.length - 1, optionIndex + 1);
          refresh();
          return;
        }

        // Select option on Enter
        const q = currentQuestion();
        if (matchesKey(data, Key.enter) && q) {
          const isTypeOther = optionIndex === opts.length - 1;
          if (isTypeOther) {
            // "Type something…"
            inputMode = true;
            inputQuestionId = q.id;
            editor.setText(answers.get(q.id) ?? "");
            refresh();
            return;
          }
          answers.set(q.id, opts[optionIndex]!);
          advanceTab();
          return;
        }

        // Cancel on Escape
        if (matchesKey(data, Key.escape)) {
          submit(true);
        }
      }

      // ── Renderer ───────────────────────────────────────────────────────────
      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const q = currentQuestion();
        const opts = currentOptions();
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));

        // Tab bar
        const tabParts: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const isActive = i === currentTab;
          const isAnswered = answers.has(questions[i]!.id);
          const lbl = questions[i]!.label;
          const box = isAnswered ? "■" : "□";
          const colorKey = isAnswered ? "success" : "muted";
          const text = ` ${box} ${lbl} `;
          const styled = isActive
            ? theme.bg("selectedBg", theme.fg("text", text))
            : theme.fg(colorKey, text);
          tabParts.push(`${styled} `);
        }
        const isSubmitTab = currentTab === questions.length;
        const canSubmit = allAnswered();
        const submitText = " ✓ Submit ";
        const submitStyled = isSubmitTab
          ? theme.bg("selectedBg", theme.fg("text", submitText))
          : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabParts.push(`${submitStyled} →`);
        add(` ${tabParts.join("")}`);
        lines.push("");

        // Content area
        if (inputMode && q) {
          // Free-text entry mode
          add(theme.fg("text", ` ${q.prompt}`));
          lines.push("");
          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i]!;
            const isSelected = i === optionIndex;
            const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
            const label =
              i === opts.length - 1 && inputMode
                ? theme.fg("accent", `${i + 1}. ${opt} ✎`)
                : theme.fg(isSelected ? "accent" : "muted", `${i + 1}. ${opt}`);
            add(prefix + label);
          }
          lines.push("");
          add(theme.fg("muted", " Your answer:"));
          for (const line of editor.render(width - 2)) {
            add(` ${line}`);
          }
          lines.push("");
          add(theme.fg("dim", " Enter to submit • Esc to cancel"));
        } else if (isSubmitTab) {
          // Review / submit screen
          add(theme.fg("accent", theme.bold(" Review your answers")));
          lines.push("");
          for (const question of questions) {
            const answer = answers.get(question.id);
            if (answer) {
              add(
                `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", answer)}`,
              );
            } else {
              add(
                `${theme.fg("muted", ` ${question.label}: `)}${theme.fg("warning", "(not answered)")}`,
              );
            }
          }
          lines.push("");
          if (canSubmit) {
            add(theme.fg("success", " Press Enter to submit"));
          } else {
            const missing = questions
              .filter((qs) => !answers.has(qs.id))
              .map((qs) => qs.label)
              .join(", ");
            add(theme.fg("warning", ` Still needed: ${missing}`));
          }
        } else if (q) {
          // Question screen
          add(theme.fg("text", ` ${q.prompt}`));
          lines.push("");
          for (let i = 0; i < opts.length; i++) {
            const opt = opts[i]!;
            const isSelected = i === optionIndex;
            const isTypeOther = i === opts.length - 1;
            const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
            const colorKey = isSelected ? "accent" : isTypeOther ? "muted" : "text";
            add(prefix + theme.fg(colorKey, `${i + 1}. ${opt}`));
          }
          // Show previously selected answer as a hint
          const prev = answers.get(q.id);
          if (prev) {
            lines.push("");
            add(theme.fg("dim", `   Currently: ${prev}`));
          }
        }

        lines.push("");
        if (!inputMode) {
          add(theme.fg("dim", " Tab/←→ navigate tabs • ↑↓ select option • Enter confirm • Esc cancel"));
        }
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate() {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
  );

  if (result.cancelled) return null;
  return result.answers;
}
