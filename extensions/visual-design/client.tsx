import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Plate,
  PlateContent,
  createPlateEditor,
} from "@platejs/core/react";

import type { DesignDocument, DesignNode, DesignText } from "./design.js";

type RenderElementProps = Parameters<
  NonNullable<React.ComponentProps<typeof PlateContent>["renderElement"]>
>[0];
type DesignPayload = { path: string; document: DesignDocument };
type TimelineItem = { id: number; kind: "user" | "status" | "agent" | "error"; text: string };
type RelayEvent =
  | { type: "chat-user"; text: string }
  | { type: "design-error"; message: string }
  | { type: "agent-status"; status: string; message?: string }
  | { type: "agent-output"; text: string };
type ServerEvent =
  | { type: "design"; document: DesignDocument; source: string }
  | { type: "history"; events: RelayEvent[] }
  | RelayEvent;

const token = new URLSearchParams(window.location.search).get("token") ?? "";
const withToken = (path: string) => `${path}?token=${encodeURIComponent(token)}`;

function App() {
  const [payload, setPayload] = useState<DesignPayload>();
  const [selectedId, setSelectedId] = useState<string>();
  const [instruction, setInstruction] = useState("");
  const [behavior, setBehavior] = useState<"steer" | "followUp">("followUp");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    void fetch(withToken("/api/design"))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load design (${response.status})`);
        setPayload((await response.json()) as DesignPayload);
      })
      .catch((error) => appendTimeline(setTimeline, "error", errorMessage(error)));

    const events = new EventSource(withToken("/events"));
    events.onopen = () => setConnection("live");
    events.onerror = () => setConnection("offline");
    events.onmessage = (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      if (event.type === "design") {
        setPayload((current) => current ? { ...current, document: event.document } : current);
        setSelectedId((current) => current && findNode(event.document.root, current) ? current : undefined);
      } else if (event.type === "history") {
        setTimeline(timelineFromHistory(event.events));
      } else {
        setTimeline((items) => applyRelayEvent(items, event));
      }
    };
    return () => events.close();
  }, []);

  const selected = payload && selectedId ? findNode(payload.document.root, selectedId) : undefined;
  const editor = useMemo(
    () => payload ? createPlateEditor({ value: payload.document.root as never }) : null,
    [payload?.document],
  );

  const renderElement = useCallback(
    (props: RenderElementProps) => (
      <DesignElement {...props} selectedId={selectedId} onSelect={setSelectedId} />
    ),
    [selectedId],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId || !instruction.trim() || sending) return;
    const text = instruction.trim();
    setInstruction("");
    setSending(true);
    try {
      const response = await fetch(withToken("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedId, instruction: text, behavior }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
    } catch (error) {
      appendTimeline(setTimeline, "error", errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  if (!payload || !editor) {
    return <main className="loading-state"><span className="pulse" /> Loading the design relay…</main>;
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <div className="eyebrow">Pi × PlateJS</div>
          <h1>Design relay</h1>
        </div>
        <div className="file-status">
          <span className={`connection connection-${connection}`}>{connection}</span>
          <code>{payload.path}</code>
        </div>
      </header>

      <section className="stage" aria-label="Rendered design canvas">
        <div className="stage-label">
          <span>Live artifact</span>
          <strong>{payload.document.title}</strong>
          <span>schema v{payload.document.schemaVersion}</span>
        </div>
        <div className="plate-frame">
          <Plate editor={editor} readOnly>
            <PlateContent className="plate-content" readOnly renderElement={renderElement} />
          </Plate>
        </div>
      </section>

      <aside className="relay-panel" aria-label="Selected-node conversation">
        <div className="selection-readout">
          <div className="eyebrow">Current selection</div>
          {selected ? (
            <>
              <div className="selection-id"><span>{selected.type}</span><code>#{selected.id}</code></div>
              <p>{nodePreview(selected)}</p>
            </>
          ) : (
            <p>Select any outlined block on the canvas to give Pi exact context.</p>
          )}
        </div>

        <div className="timeline" aria-live="polite" aria-label="Agent progress">
          {timeline.length === 0 ? (
            <div className="empty-timeline">
              <span className="relay-mark">↗</span>
              <p>Ask for a change. Pi receives the selected node, its nearby structure, and this file path.</p>
            </div>
          ) : timeline.map((item) => (
            <div className={`timeline-item timeline-${item.kind}`} key={item.id}>
              <span>{item.kind === "user" ? "You" : item.kind === "agent" ? "Pi" : "Relay"}</span>
              <p>{item.text}</p>
            </div>
          ))}
        </div>

        <form className="prompt-form" onSubmit={submit}>
          <label htmlFor="design-instruction">Describe the visual change</label>
          <textarea
            id="design-instruction"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={selected ? `Change #${selected.id}…` : "Select a block first…"}
            disabled={!selected || sending}
            rows={4}
          />
          <div className="prompt-actions">
            <label className="queue-choice">
              <span>While Pi is busy</span>
              <select value={behavior} onChange={(event) => setBehavior(event.target.value as "steer" | "followUp")}>
                <option value="followUp">Queue next</option>
                <option value="steer">Steer now</option>
              </select>
            </label>
            <button type="submit" disabled={!selected || !instruction.trim() || sending}>
              {sending ? "Sending…" : "Send to Pi"}
            </button>
          </div>
        </form>
      </aside>
    </main>
  );
}

type DesignElementProps = RenderElementProps & {
  selectedId?: string;
  onSelect: (id: string) => void;
};

function DesignElement({ attributes, children, element, selectedId, onSelect }: DesignElementProps) {
  const node = element as DesignNode;
  const className = [
    "design-node",
    `design-${node.type}`,
    node.className,
    selectedId === node.id ? "is-selected" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      {...attributes as React.HTMLAttributes<HTMLDivElement>}
      className={`${attributes.className ?? ""} ${className}`.trim()}
      data-node-id={node.id}
      data-tone={readProperty(node, "tone")}
      data-direction={readProperty(node, "direction")}
      data-columns={readProperty(node, "columns")}
      data-variant={readProperty(node, "variant")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      role="button"
      tabIndex={0}
      aria-label={`Select ${node.type} ${node.id}`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      {children}
    </div>
  );
}

function findNode(nodes: DesignNode[], id: string): DesignNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children.filter(isNode), id);
    if (found) return found;
  }
  return undefined;
}

function isNode(value: DesignNode | DesignText): value is DesignNode {
  return typeof value.id === "string" && typeof value.type === "string" && Array.isArray(value.children);
}

function nodePreview(node: DesignNode): string {
  const text = node.children.filter((child): child is DesignText => "text" in child).map((child) => child.text).join("");
  return text ? text.slice(0, 140) : `${node.children.filter(isNode).length} nested block${node.children.length === 1 ? "" : "s"}`;
}

function readProperty(node: DesignNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function appendTimeline(
  setter: React.Dispatch<React.SetStateAction<TimelineItem[]>>,
  kind: TimelineItem["kind"],
  text: string,
) {
  setter((items) => [...items.slice(-19), { id: Date.now() + Math.random(), kind, text }]);
}

function timelineFromHistory(events: RelayEvent[]): TimelineItem[] {
  return events.reduce<TimelineItem[]>((items, event) => applyRelayEvent(items, event), []);
}

function applyRelayEvent(items: TimelineItem[], event: RelayEvent): TimelineItem[] {
  if (event.type === "agent-output") {
    const last = items.at(-1);
    if (last?.kind === "agent") return [...items.slice(0, -1), { ...last, text: event.text }];
    return [...items.slice(-99), { id: Date.now() + Math.random(), kind: "agent", text: event.text }];
  }
  const kind = event.type === "chat-user" ? "user" : event.type === "design-error" ? "error" : "status";
  const text = event.type === "chat-user"
    ? event.text
    : event.type === "design-error"
      ? `File change rejected: ${event.message}`
      : event.message ?? `Agent is ${event.status}`;
  return [...items.slice(-99), { id: Date.now() + Math.random(), kind, text }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(<App />);
