import {
  getMarkdownTheme,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { createHmac, randomUUID } from "node:crypto";
import { Type } from "typebox";

import { OpenShellAgentOrchestrator, AgentFailure } from "./orchestrator.ts";
import { loadProfiles, validateTrustDomain } from "./profile.ts";
import type { OpenShellAgentDetails, PolicyProposal, WorkspaceRecord } from "./types.ts";
import type { ForwardHandle } from "./cli.ts";

const parameters = Type.Object({
  task: Type.String({ description: "Bounded one-shot task. Sent through sandbox stdin, never a host process argument." }),
  profile: Type.String({ description: "Operator-owned execution profile name, such as web-research or development" }),
  trustDomain: Type.String({ description: "Mandatory isolation domain, for example personal, project-foo, or client-a" }),
  repository: Type.Optional(Type.Object({
    url: Type.String({ description: "Repository URL cloned from inside the sandbox; embedded credentials are forbidden" }),
    baseBranch: Type.Optional(Type.String({ description: "Remote base branch (default from profile, usually main)" })),
  })),
  browserProfile: Type.Optional(Type.String({ description: "Persistent browser workspace name; isolated together with trustDomain" })),
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
      if (details.error) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("error", details.error), 0, 0));
      } else if (details.answer) {
        container.addChild(new Spacer(1));
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
      const records = await orchestrator.registry.list();
      if (action === "profiles") {
        ctx.ui.notify(Object.values(profiles).map((profile) =>
          `${profile.name}: ${profile.description}\n  image=${profile.image} reuse=${profile.reuse} policy=${profile.advisorMode} providers=${profile.providers.join(",") || "none"} inference=${profile.codexSubscription ? `${profile.codexSubscription.provider}/${profile.codexSubscription.model}` : "gateway"}`,
        ).join("\n\n"), "info");
        return;
      }
      if (action === "list") {
        ctx.ui.notify(records.length ? records.map(formatWorkspace).join("\n\n") : "No managed OpenShell workspaces", "info");
        return;
      }
      const record = records.find((entry) => entry.workspaceId === id || entry.sandboxName === id);
      if (!record) {
        ctx.ui.notify("Workspace not found. Use /openshell list.", "error");
        return;
      }
      if (action === "status") {
        const sandbox = (await orchestrator.cli.listSandboxes()).find((entry) => entry.name === record.sandboxName);
        ctx.ui.notify(`${formatWorkspace(record)}\nphase=${sandbox?.phase ?? "missing"}`, "info");
        return;
      }
      if (action === "delete" || action === "recreate") {
        const verb = action === "delete" ? "Delete" : "Recreate";
        const confirmed = await ctx.ui.confirm(`${verb} OpenShell sandbox?`,
          `${record.sandboxName}\nTrust domain: ${record.trustDomain}\nThis permanently deletes sandbox files, caches, artifacts, and browser state.${action === "recreate" ? " The next job creates a clean replacement." : ""}`);
        if (!confirmed) return;
        forwards.get(record.workspaceId)?.stop();
        forwards.delete(record.workspaceId);
        await orchestrator.cli.deleteSandbox(record.sandboxName);
        await orchestrator.registry.remove(record.logicalKey);
        ctx.ui.notify(`${record.sandboxName} deleted${action === "recreate" ? "; run the next job to create its replacement" : ""}.`, "info");
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
        if (!record.browserControlSecret) {
          ctx.ui.notify("This browser workspace lacks its host-only takeover capability. Recreate it before use.", "error");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "Begin sensitive manual browser takeover?",
          "This explicitly authorizes a human-only interval. The worker will be OS-suspended and the browser controller will enter its host-authenticated paused state before noVNC opens. Perform only the consequential action you intend, then run the explicit resume command.",
        );
        if (!confirmed) return;
        const control = browserControlPacket(record.browserControlSecret, "pause");
        const paused = await orchestrator.cli.exec(record.sandboxName, ["sh", "-c", "stopped=0; if test -f /sandbox/.openshell-agent/active-process-group; then pgid=$(cat /sandbox/.openshell-agent/active-process-group); kill -STOP -- -$pgid; stopped=1; fi; if ! curl -fsS -X POST --data-binary @- http://127.0.0.1:3010/control/pause >/dev/null; then if test $stopped -eq 1; then kill -CONT -- -$pgid || true; fi; exit 1; fi"], { input: JSON.stringify(control.packet), timeout: 15 });
        if (paused.code !== 0) {
          const resume = browserControlPacket(record.browserControlSecret, "resume");
          await orchestrator.cli.exec(record.sandboxName, ["curl", "-fsS", "-X", "POST", "--data-binary", "@-", "http://127.0.0.1:3010/control/resume"], { input: JSON.stringify(resume.packet), timeout: 15 });
          await orchestrator.cli.exec(record.sandboxName, ["sh", "-c", "if test -f /sandbox/.openshell-agent/active-process-group; then kill -CONT -- -$(cat /sandbox/.openshell-agent/active-process-group) || true; fi"], { timeout: 15 });
          ctx.ui.notify("Could not pause protected browser automation; the worker was resumed and takeover was not opened.", "error");
          return;
        }
        const vncPassword = control.vncPassword;
        const handle = orchestrator.cli.startForward(record.sandboxName, record.browser.noVncPort, localPort);
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
        if (!record.browserControlSecret) {
          ctx.ui.notify("This browser workspace lacks its host-only takeover capability. Recreate it before use.", "error");
          return;
        }
        const control = browserControlPacket(record.browserControlSecret, "resume");
        const resumed = await orchestrator.cli.exec(record.sandboxName, ["sh", "-c", "if ! curl -fsS -X POST --data-binary @- http://127.0.0.1:3010/control/resume >/dev/null; then exit 1; fi; if test -f /sandbox/.openshell-agent/active-process-group; then kill -CONT -- -$(cat /sandbox/.openshell-agent/active-process-group); fi"], { input: JSON.stringify(control.packet), timeout: 15 });
        ctx.ui.notify(resumed.code === 0 ? "Takeover ended explicitly; controller and worker may resume." : "Resume failed closed; automation remains unavailable.", resumed.code === 0 ? "info" : "error");
        return;
      }
      ctx.ui.notify("Usage: /openshell <profiles|list|status ID|delete ID|recreate ID|takeover ID [local-port]|resume ID>", "error");
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

export function browserControlPacket(secret: string, action: "pause" | "resume") {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const mac = createHmac("sha256", secret).update(`${action}:${timestamp}:${nonce}`).digest("hex");
  const vncPassword = createHmac("sha256", secret).update("vnc").digest("hex").slice(0, 8);
  return { packet: { timestamp, nonce, mac }, vncPassword };
}

export function parseOpenShellCommand(args: string): [string, string | undefined, string | undefined] {
  const [requestedAction, id, portArg] = args.trim().split(/\s+/).filter(Boolean);
  return [requestedAction || "list", id, portArg];
}

export function trustedCompletion(details: OpenShellAgentDetails): string {
  return `OpenShell job ${details.status}. sandbox=${details.sandboxName} workspace=${details.workspaceId} job=${details.jobId} reused=${details.reused}`;
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

function formatWorkspace(record: WorkspaceRecord): string {
  return `${record.workspaceId} · ${record.sandboxName}\nprofile=${record.profile} trust=${record.trustDomain} providers=${record.providers.join(",") || "none"} inference=${record.inference ? `${record.inference.provider}/${record.inference.model}` : "unknown"}${record.browserProfile ? ` browser=${record.browserProfile}` : ""}`;
}

export default openshellAgentExtension;
