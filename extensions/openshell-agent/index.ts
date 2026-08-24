import {
  getMarkdownTheme,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { listAudits, readAudit, renderReport } from "./audit.ts";
import { browserControlPacket } from "./mandate.ts";
import { OpenShellAgentOrchestrator, AgentFailure, type MandateAuthorizationRequest } from "./orchestrator.ts";
import { loadProfiles, validateTrustDomain } from "./profile.ts";
import type { BrowserWorkspaceRecord, OpenShellAgentDetails, PolicyProposal, WorkspaceRecord } from "./types.ts";
import type { ForwardHandle } from "./cli.ts";

export { browserControlPacket };

const parameters = Type.Object({
  task: Type.String({ description: "Bounded one-shot task. Sent through sandbox stdin, never a host process argument." }),
  profile: Type.String({ description: "Operator-owned execution profile name, such as web-research or development" }),
  trustDomain: Type.String({ description: "Mandatory isolation domain, for example personal, project-foo, or client-a" }),
  repository: Type.Optional(Type.Object({
    url: Type.String({ description: "Repository URL cloned from inside the sandbox; embedded credentials are forbidden" }),
    baseBranch: Type.Optional(Type.String({ description: "Remote base branch (default from profile, usually main)" })),
  })),
  browserProfile: Type.Optional(Type.String({ description: "Persistent browser workspace name; isolated together with trustDomain" })),
  professionalSocials: Type.Optional(Type.Object({
    sites: Type.Array(Type.String(), { description: "Rulebook site ids: linkedin, xing, freelance-de, freelancermap, gulp, malt" }),
    allow: Type.Array(Type.String(), { description: "Action classes beyond read: edit-profile, publish-post" }),
    budget: Type.Optional(Type.Object({
      actions: Type.Optional(Type.Number()),
      edits: Type.Optional(Type.Number()),
      submits: Type.Optional(Type.Number()),
      publishes: Type.Optional(Type.Number()),
      uploads: Type.Optional(Type.Number()),
    }, { description: "Optional tighter bounds; the built-in maximum always applies" })),
    ttlMinutes: Type.Optional(Type.Number({ description: "Mandate lifetime in minutes, at most 120" })),
  }, { description: "Required by the professional-socials profile. The operator authorizes this scope once; the run then proceeds without per-action prompts." })),
});

const openshellAgentExtension: ExtensionFactory = (pi) => {
  const orchestrator = new OpenShellAgentOrchestrator();
  const forwards = new Map<string, ForwardHandle>();

  pi.registerTool({
    name: "openshell_agent",
    label: "OpenShell Agent",
    description:
      "Run one bounded autonomous Pi worker entirely inside an OpenShell sandbox. " +
      "Only TUI mode is supported because the untrusted worker answer is rendered from details and the terminating model-visible result contains trusted metadata only. " +
      "Use as the final and only tool call in a batch.",
    promptSnippet: "Delegate an untrusted research or development job to a bounded autonomous agent inside OpenShell",
    promptGuidelines: [
      "Use openshell_agent for untrusted web research or isolated sandbox-side development instead of exposing web content or a repository to host tools.",
      "Call openshell_agent as the final and only tool call in its batch; its terminating result prevents a subsequent host-model turn.",
      "Never place credential values in openshell_agent inputs; profiles contain provider names only.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (ctx.mode !== "tui") {
        return terminatingFailure("unsupported_mode", "openshell_agent is disabled outside TUI mode because this transport cannot preserve the untrusted-result boundary.");
      }
      try {
        const profiles = await loadProfiles({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
        const profile = profiles[params.profile];
        if (!profile) return terminatingFailure("unknown_profile", `Unknown OpenShell profile: ${params.profile}`);
        const trustDomain = validateTrustDomain(params.trustDomain);
        const details = await orchestrator.run(profile, {
          task: params.task,
          profile: profile.name,
          trustDomain,
          repository: params.repository,
          browserProfile: params.browserProfile,
          professionalSocials: params.professionalSocials,
        }, signal, {
          confirmRecreate: (record, next) => ctx.ui.confirm(
            "Recreate persistent OpenShell workspace?",
            [
              `Current sandbox: ${record.sandboxName}`,
              `Replacement: ${next}`,
              `Trust domain: ${record.trustDomain}`,
              "Static image/filesystem/process policy changed.",
              "Recreation permanently deletes this sandbox's checkout, caches, artifacts, and browser state.",
            ].join("\n"),
          ),
          confirmBrowserRecreate: (record) => ctx.ui.confirm(
            "Recreate the persistent browser workspace?",
            [
              `Browser sandbox: ${record.sandboxName}`,
              `Trust domain: ${record.trustDomain} · browser profile: ${record.browserProfile}`,
              "The browser image or its static policy changed.",
              "Recreation permanently deletes cookies, local storage, history, and every logged-in session in this browser workspace.",
              "You will have to log in again through /openshell takeover.",
            ].join("\n"),
          ),
          authorizeMandate: (request) => authorizeMandate(ctx, request),
          reviewProposal: (proposal) => reviewProposal(ctx, proposal),
          progress: (message) => {
            ctx.ui.setStatus("openshell-agent", message);
            onUpdate?.({ content: [{ type: "text", text: message }], details: { lifecycle: message } });
          },
        });
        ctx.ui.setStatus("openshell-agent", undefined);
        return {
          content: [{ type: "text", text: trustedCompletion(details) }],
          details,
          terminate: true,
        };
      } catch (error) {
        ctx.ui.setStatus("openshell-agent", undefined);
        const code = error instanceof AgentFailure ? error.code : "preflight_or_runtime_failure";
        const message = error instanceof Error ? error.message : "OpenShell job failed closed";
        return terminatingFailure(code, message);
      }
    },
    renderCall(args, theme) {
      const title = theme.fg("toolTitle", theme.bold("openshell_agent "));
      const profile = theme.fg("accent", args.profile || "…");
      const trust = theme.fg("muted", ` trust=${args.trustDomain || "…"}`);
      const task = typeof args.task === "string" ? args.task.replace(/\s+/g, " ").slice(0, 100) : "…";
      return new Text(`${title}${profile}${trust}\n${theme.fg("dim", task)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        const block = result.content[0];
        return new Text(theme.fg("muted", block?.type === "text" ? block.text : "OpenShell job running…"), 0, 0);
      }
      const details = result.details as OpenShellAgentDetails | undefined;
      if (!details) return new Text(theme.fg("error", "OpenShell job failed closed"), 0, 0);
      const container = new Container();
      const color = details.status === "complete" ? "success" : details.status === "cancelled" ? "warning" : "error";
      container.addChild(new Text(theme.fg(color, `${details.status === "complete" ? "✓" : "✗"} OpenShell job ${details.status}`), 0, 0));
      container.addChild(new Text(theme.fg("dim", `sandbox ${details.sandboxName || "not-created"} · job ${details.jobId || "not-started"} · ${details.reused ? "reused" : "new"}`), 0, 0));
      if (details.professionalSocials) {
        const summary = details.professionalSocials;
        container.addChild(new Text(theme.fg("muted", `mandate ${summary.mandateId.slice(0, 8)} · sites ${summary.sites.join(",")} · submits ${summary.submits} · publishes ${summary.publishes} · denials ${summary.denials}${summary.revocation ? ` · revoked ${summary.revocation}` : ""}`), 0, 0));
      }
      if (details.report) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("success", "Trusted host report (controller-observed)"), 0, 0));
        container.addChild(new Markdown(details.report, 0, 0, getMarkdownTheme()));
      }
      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("error", details.error), 0, 0));
      } else if (details.answer) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("warning", "Untrusted worker narrative (not evidence)"), 0, 0));
        container.addChild(new Markdown(details.answer, 0, 0, getMarkdownTheme()));
      }
      const refs = [details.branch && `branch ${details.branch}`, details.commit && `commit ${details.commit}`, ...(details.artifacts ?? [])].filter(Boolean);
      if (refs.length) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", refs.join("\n")), 0, 0));
      }
      return container;
    },
  });

  pi.registerCommand("openshell", {
    description: "Manage OpenShell profiles/workspaces: profiles, list, status, delete, recreate, takeover, resume",
    async handler(args, ctx) {
      const [action, id, portArg] = parseOpenShellCommand(args);
      const profiles = await loadProfiles({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
      const state = await orchestrator.registry.read();
      const records = state.workspaces;
      const browserWorkspaces = state.browserWorkspaces;
      const browserFor = (record: WorkspaceRecord): BrowserWorkspaceRecord | undefined =>
        browserWorkspaces.find((entry) => entry.browserWorkspaceKey === record.browserWorkspaceKey);
      if (action === "profiles") {
        ctx.ui.notify(Object.values(profiles).map((profile) =>
          `${profile.name}: ${profile.description}\n  image=${profile.image} reuse=${profile.reuse} policy=${profile.advisorMode} providers=${profile.providers.join(",") || "none"} inference=${profile.codexSubscription ? `${profile.codexSubscription.provider}/${profile.codexSubscription.model}` : "gateway"}`,
        ).join("\n\n"), "info");
        return;
      }
      if (action === "list") {
        const workspaces = records.length ? records.map((record) => formatWorkspace(record, browserFor(record))).join("\n\n") : "No managed OpenShell workspaces";
        const browsers = browserWorkspaces.length
          ? `\n\nShared browser workspaces:\n${browserWorkspaces.map((entry) => `${entry.browserWorkspaceKey.slice(0, 12)} · ${entry.sandboxName} · trust=${entry.trustDomain} browser=${entry.browserProfile}`).join("\n")}`
          : "";
        ctx.ui.notify(`${workspaces}${browsers}`, "info");
        return;
      }
      const record = records.find((entry) => entry.workspaceId === id || entry.sandboxName === id);
      if (!record) {
        ctx.ui.notify("Workspace not found. Use /openshell list.", "error");
        return;
      }
      if (action === "status") {
        const sandboxes = await orchestrator.cli.listSandboxes();
        const sandbox = sandboxes.find((entry) => entry.name === record.sandboxName);
        const browser = browserFor(record);
        const browserPhase = browser ? sandboxes.find((entry) => entry.name === browser.sandboxName)?.phase ?? "missing" : undefined;
        const audits = await listAudits(record.workspaceId);
        ctx.ui.notify([
          formatWorkspace(record, browser),
          `phase=${sandbox?.phase ?? "missing"}${browserPhase ? ` browser-phase=${browserPhase}` : ""}`,
          audits.length ? `audited jobs: ${audits.slice(-5).join(", ")}` : "audited jobs: none",
        ].join("\n"), "info");
        return;
      }
      if (action === "audit") {
        const audits = await listAudits(record.workspaceId);
        if (audits.length === 0) {
          ctx.ui.notify("No professional-socials audit ledger exists for this workspace.", "info");
          return;
        }
        const jobId = portArg && audits.includes(portArg) ? portArg : audits[audits.length - 1];
        const entries = await readAudit(record.workspaceId, jobId);
        const activation = entries.find((entry) => entry.action === "mandate.activate");
        const use = { actions: 0, edits: 0, submits: 0, publishes: 0, uploads: 0, denials: 0, diffMismatches: 0 };
        for (const entry of entries) {
          if (entry.decision === "deny") use.denials += 1;
          if (entry.decision !== "allow") continue;
          use.actions += 1;
          if (entry.action === "submit") use.submits += 1;
          if (entry.action === "publish") use.publishes += 1;
          if (entry.action.startsWith("act.")) use.edits += 1;
          if (entry.action === "upload") use.uploads += 1;
        }
        ctx.ui.notify(renderReport({
          jobId,
          workspaceId: record.workspaceId,
          trustDomain: record.trustDomain,
          browserProfile: record.browserProfile ?? "unknown",
          sites: [], origins: [], actionClasses: [],
          mandateId: "recorded",
          issuedAt: activation?.at ?? "unknown",
          expiresAt: "see ledger",
        }, entries, use, { status: "recorded" }), "info");
        return;
      }
      if (action === "delete" || action === "recreate") {
        const verb = action === "delete" ? "Delete" : "Recreate";
        const confirmed = await ctx.ui.confirm(`${verb} OpenShell worker sandbox?`,
          `${record.sandboxName}\nTrust domain: ${record.trustDomain}\nThis permanently deletes worker sandbox files, caches, and artifacts.\nThe shared browser workspace and its logged-in sessions are kept; use browser-recreate for those.${action === "recreate" ? " The next job creates a clean replacement." : ""}`);
        if (!confirmed) return;
        forwards.get(record.workspaceId)?.stop();
        forwards.delete(record.workspaceId);
        await orchestrator.cli.deleteSandbox(record.sandboxName);
        // A legacy workspace can still own an unadopted browser sandbox.
        if (record.browserSandboxName) await orchestrator.cli.deleteSandbox(record.browserSandboxName).catch(() => {});
        await orchestrator.registry.remove(record.logicalKey);
        ctx.ui.notify(`${record.sandboxName} deleted${action === "recreate" ? "; run the next job to create its replacement" : ""}.`, "info");
        return;
      }
      if (action === "browser-recreate" || action === "browser-delete") {
        const browser = browserFor(record);
        if (!browser) {
          ctx.ui.notify("This workspace has no shared browser workspace.", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm("Delete the persistent browser workspace?",
          `${browser.sandboxName}\nTrust domain: ${browser.trustDomain} · browser profile: ${browser.browserProfile}\nThis permanently deletes cookies, local storage, history, downloads, and every logged-in session. You will log in again through /openshell takeover.`);
        if (!confirmed) return;
        forwards.get(record.workspaceId)?.stop();
        forwards.delete(record.workspaceId);
        await orchestrator.cli.deleteSandbox(browser.sandboxName);
        await orchestrator.registry.removeBrowserWorkspace(browser.browserWorkspaceKey);
        ctx.ui.notify(`${browser.sandboxName} deleted; the next browser job creates an empty replacement.`, "info");
        return;
      }
      if (action === "takeover") {
        if (!record.browser) {
          ctx.ui.notify("This workspace has no authenticated browser profile.", "error");
          return;
        }
        if (forwards.has(record.workspaceId)) {
          ctx.ui.notify(`Takeover already active: ${forwards.get(record.workspaceId)!.url}`, "warning");
          return;
        }
        const localPort = portArg ? Number(portArg) : record.browser.noVncPort;
        if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
          ctx.ui.notify("Use a local port from 1024 to 65535.", "error");
          return;
        }
        const browser = browserFor(record);
        if (!browser) {
          ctx.ui.notify("This browser workspace lacks its isolated browser service or host-only takeover capability. Recreate it before use.", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Begin sensitive manual browser takeover?",
          "This explicitly authorizes a human-only interval. The worker will be OS-suspended and the browser controller will enter its host-authenticated paused state before noVNC opens. Perform only the consequential action you intend, then run the explicit resume command.",
        );
        if (!confirmed) return;
        const control = browserControlPacket(browser.controlSecret, "pause");
        const stopped = await orchestrator.cli.exec(record.sandboxName, ["sh", "-c", "if test -f /sandbox/.openshell-agent/active-process-group; then kill -STOP -- -$(cat /sandbox/.openshell-agent/active-process-group); fi"], { timeout: 15 });
        let paused = false;
        if (stopped.code === 0) {
          const response = await orchestrator.cli.browserCall(browser.sandboxName, "/control/pause", control.packet).catch(() => undefined);
          paused = Boolean(response && response.status >= 200 && response.status < 300);
        }
        if (!paused) {
          await orchestrator.cli.exec(record.sandboxName, ["sh", "-c", "if test -f /sandbox/.openshell-agent/active-process-group; then kill -CONT -- -$(cat /sandbox/.openshell-agent/active-process-group) || true; fi"], { timeout: 15 });
          ctx.ui.notify("Could not pause protected browser automation; the worker was resumed and takeover was not opened.", "error");
          return;
        }
        const vncPassword = control.vncPassword;
        const handle = orchestrator.cli.startForward(browser.sandboxName, record.browser.noVncPort, localPort);
        forwards.set(record.workspaceId, handle);
        ctx.ui.notify(
          `Sensitive manual takeover active\n${handle.url}\nVNC password: ${vncPassword}\n\nThe worker is OS-suspended and every automation route is locked behind a one-time host-authenticated pause. X11 and VNC require browser-user-only credentials, and the controller exposes no CDP socket. Screenshots, tracing, keystroke capture, and controller request-body logging are disabled. The browser process still handles secrets inside this isolated sandbox. Run /openshell resume ${record.workspaceId} when finished.`,
          "warning",
        );
        return;
      }
      if (action === "resume") {
        const handle = forwards.get(record.workspaceId);
        handle?.stop();
        forwards.delete(record.workspaceId);
        const browser = browserFor(record);
        if (!browser) {
          ctx.ui.notify("This browser workspace lacks its isolated browser service or host-only takeover capability. Recreate it before use.", "error");
          return;
        }
        const browserResumed = await orchestrator.cli.browserCall(browser.sandboxName, "/control/resume", browserControlPacket(browser.controlSecret, "resume").packet).catch(() => undefined);
        const workerResumed = browserResumed && browserResumed.status >= 200 && browserResumed.status < 300
          ? await orchestrator.cli.exec(record.sandboxName, ["sh", "-c", "if test -f /sandbox/.openshell-agent/active-process-group; then kill -CONT -- -$(cat /sandbox/.openshell-agent/active-process-group); fi"], { timeout: 15 })
          : undefined;
        const resumed = workerResumed?.code === 0;
        if (!resumed) {
          ctx.ui.notify("Resume failed closed; automation remains unavailable.", "error");
          return;
        }
        // An active task mandate is only usable again after the controller
        // re-checks its TTL and the logged-in account identity for every origin.
        const revalidated = await orchestrator.cli
          .browserCall(browser.sandboxName, "/mandate/revalidate", browserControlPacket(browser.controlSecret, "mandate-revalidate").packet)
          .catch(() => undefined);
        const mandate = revalidated?.body as { mandate?: string; reason?: string; identity?: Record<string, string> } | undefined;
        const identity = mandate?.identity ? Object.entries(mandate.identity).map(([origin, state]) => `${origin}=${state}`).join(" ") : "";
        const mandateNote = !mandate || mandate.mandate === "none"
          ? "No task mandate was active."
          : mandate.mandate === "active"
            ? `Task mandate revalidated; stale refs were invalidated. ${identity}`.trim()
            : `Task mandate revoked after takeover (${mandate.reason ?? "unknown"}). ${identity}`.trim();
        ctx.ui.notify(`Takeover ended explicitly; controller and worker may resume.\n${mandateNote}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /openshell <profiles|list|status ID|audit ID [job]|delete ID|recreate ID|browser-recreate ID|takeover ID [local-port]|resume ID>", "error");
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const handle of forwards.values()) handle.stop();
    forwards.clear();
    ctx.ui.setStatus("openshell-agent", undefined);
  });
};

async function reviewProposal(ctx: ExtensionContext, proposal: PolicyProposal) {
  const grant = [
    `Chunk: ${proposal.id}`,
    `Host: ${proposal.host ?? "unknown"}:${proposal.port ?? "unknown"}`,
    `Binary: ${proposal.binary ?? "unknown"}`,
    `HTTP: ${proposal.method ?? "opaque/L4"} ${proposal.path ?? ""}`.trim(),
    `Gateway prover: ${proposal.proverFindings.length ? proposal.proverFindings.join(", ") : "empty delta"}`,
    proposal.rationale ? `Agent rationale (untrusted, not approval evidence): ${proposal.rationale}` : "",
  ].filter(Boolean).join("\n");
  const decision = await ctx.ui.select(`Review OpenShell policy proposal\n\n${grant}`, ["Reject with guidance", "Approve structured grant"], { timeout: 300_000 });
  if (decision !== "Approve structured grant") {
    const reason = await ctx.ui.input("Rejection guidance", "Narrow the host, method, path, or binary", { timeout: 300_000 });
    return { action: "reject" as const, reason: reason?.trim() || "Rejected by operator; stop or propose a narrower structured grant." };
  }
  const confirmed = await ctx.ui.confirm("Approve this structured grant?", `${grant}\n\nApprove based on the structured grant and prover evidence, never the agent rationale alone.`);
  return confirmed ? { action: "approve" as const } : { action: "reject" as const, reason: "Operator declined this structured grant." };
}

/**
 * The single task-level authorization. Everything the mandate will permit is
 * shown once, before any browser action runs; after this the autonomous run
 * proceeds without further prompts and the operator reviews the trusted report.
 */
async function authorizeMandate(ctx: ExtensionContext, request: MandateAuthorizationRequest): Promise<boolean> {
  const summary = [
    `Task: ${request.task.replace(/\s+/g, " ").slice(0, 400)}`,
    "",
    `Sites: ${request.sites.map((site) => `${site.label} (${site.origins.join(", ")})`).join("; ")}`,
    `Allowed actions: ${request.actionClasses.join(", ")}`,
    `Budget: ${request.budget.edits} edits · ${request.budget.submits} submits · ${request.budget.publishes} publishes · ${request.budget.uploads} uploads · ${request.budget.actions} actions`,
    `Valid for: ${request.ttlMinutes} minutes in browser workspace ${request.browserProfile} (trust domain ${request.trustDomain})`,
    "",
    "The worker will edit and submit autonomously inside this scope with no further prompts.",
    "Credentials, security, sessions, OAuth consent, billing, terms, messaging, connections, applications, and delete surfaces stay refused.",
    "Login, 2FA, CAPTCHA, and security challenges pause the run for your /openshell takeover.",
    "You review the trusted host report afterwards and can correct anything the run changed.",
  ].join("\n");
  return ctx.ui.confirm("Authorize autonomous professional-social maintenance?", summary);
}

export function parseOpenShellCommand(args: string): [string, string | undefined, string | undefined] {
  const [requestedAction, id, portArg] = args.trim().split(/\s+/).filter(Boolean);
  return [requestedAction || "list", id, portArg];
}

export function trustedCompletion(details: OpenShellAgentDetails): string {
  const base = `OpenShell job ${details.status}. sandbox=${details.sandboxName} workspace=${details.workspaceId} job=${details.jobId} reused=${details.reused}`;
  const summary = details.professionalSocials;
  if (!summary) return base;
  // Counts and rulebook site ids only: no page-derived text reaches the model.
  return `${base} sites=${summary.sites.join("+") || "none"} submits=${summary.submits} publishes=${summary.publishes} denials=${summary.denials}${summary.revocation ? ` revoked=${summary.revocation}` : ""}`;
}

function terminatingFailure(code: string, message: string) {
  const details: OpenShellAgentDetails = {
    status: "failed", answer: "", sandboxId: "", sandboxName: "", workspaceId: "", jobId: "", reused: false, errorCode: code, error: message,
  };
  return {
    content: [{ type: "text" as const, text: `OpenShell job failed closed. code=${code}` }],
    details,
    terminate: true as const,
  };
}

function formatWorkspace(record: WorkspaceRecord, browser?: BrowserWorkspaceRecord): string {
  const browserPart = record.browserProfile
    ? ` browser=${record.browserProfile}${browser ? ` service=${browser.sandboxName}` : record.browserAdoptionConflict ? " service=adoption-conflict" : " service=none"}`
    : "";
  const modePart = record.browser?.mode === "professional-socials" ? " mode=professional-socials" : record.browser ? " mode=safe" : "";
  return `${record.workspaceId} · ${record.sandboxName}\nprofile=${record.profile} trust=${record.trustDomain} providers=${record.providers.join(",") || "none"} inference=${record.inference ? `${record.inference.provider}/${record.inference.model}` : "unknown"}${browserPart}${modePart}`;
}

export default openshellAgentExtension;
