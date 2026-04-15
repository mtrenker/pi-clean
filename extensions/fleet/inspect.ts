import { readFile } from "fs/promises";
import { join } from "path";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { TaskState } from "./task.js";
import { listTasks } from "./task.js";

type Screen = "overview" | "progress" | "output" | "task" | "recovery";

const SCREENS: Screen[] = ["overview", "progress", "output", "task", "recovery"];

async function readMaybe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function loadScreen(root: string, task: TaskState, screen: Screen): Promise<string> {
  const dir = join(root, ".pi", "tasks", `${task.id}-${task.name}`);
  switch (screen) {
    case "overview": {
      const total = task.usage.inputTokens + task.usage.outputTokens;
      const blocked = task.depends.length > 0 ? task.depends.join(", ") : "none";
      return [
        `Task ${task.id}-${task.name}`,
        "",
        `status:     ${task.status}`,
        `engine:     ${task.engine}`,
        `model:      ${task.model}`,
        `agent:      ${task.agent}`,
        `depends:    ${blocked}`,
        `retries:    ${task.retries}`,
        `pid:        ${task.pid ?? "-"}`,
        `startedAt:  ${task.startedAt ?? "-"}`,
        `completedAt:${task.completedAt ?? "-"}`,
        `error:      ${task.error ?? "-"}`,
        `tokens:     in ${task.usage.inputTokens} / out ${task.usage.outputTokens} / total ${total}`,
      ].join("\n");
    }
    case "progress":
      return (await readMaybe(join(dir, "progress.jsonl"))) || "(no progress entries)";
    case "output":
      return (await readMaybe(join(dir, "output.jsonl"))) || "(no output)";
    case "task":
      return (await readMaybe(join(dir, "task.md"))) || "(no task.md)";
    case "recovery":
      return (await readMaybe(join(dir, "recovery.md"))) || "(no recovery.md)";
  }
}

function boxLines(width: number, title: string, body: string, footer: string): string[] {
  const inner = Math.max(20, width - 4);
  const top = `┌${"─".repeat(inner + 2)}┐`;
  const bottom = `└${"─".repeat(inner + 2)}┘`;
  const lines: string[] = [top];

  for (const raw of wrapTextWithAnsi(title, inner)) {
    const pad = Math.max(0, inner - visibleWidth(raw));
    lines.push(`│ ${raw}${" ".repeat(pad)} │`);
  }
  lines.push(`│ ${"─".repeat(inner)} │`);

  const bodyLines = body.length > 0 ? body.split("\n") : [""];
  for (const line of bodyLines) {
    const wrapped = wrapTextWithAnsi(line, inner);
    if (wrapped.length === 0) {
      lines.push(`│ ${" ".repeat(inner)} │`);
      continue;
    }
    for (const part of wrapped) {
      const clipped = truncateToWidth(part, inner, "");
      const pad = Math.max(0, inner - visibleWidth(clipped));
      lines.push(`│ ${clipped}${" ".repeat(pad)} │`);
    }
  }

  lines.push(`│ ${"─".repeat(inner)} │`);
  for (const raw of wrapTextWithAnsi(footer, inner)) {
    const pad = Math.max(0, inner - visibleWidth(raw));
    lines.push(`│ ${raw}${" ".repeat(pad)} │`);
  }
  lines.push(bottom);
  return lines;
}

export async function openFleetInspector(
  root: string,
  initialTaskId: string | undefined,
  ctx: {
    ui: {
      custom: <T>(factory: any, options?: any) => Promise<T>;
      notify: (message: string, level: "info" | "warning" | "error") => void;
    };
  },
): Promise<void> {
  let tasks = await listTasks(root);
  if (tasks.length === 0) {
    ctx.ui.notify("No tasks found to inspect", "info");
    return;
  }

  let selected = Math.max(0, initialTaskId ? tasks.findIndex((t) => t.id === initialTaskId) : 0);
  if (selected < 0) selected = 0;
  let screenIndex = 0;
  let bodyCache = "Loading...";
  let loading = false;
  let closed = false;
  let lastUpdatedAt = "-";

  const refresh = async (requestRender: () => void) => {
    if (loading || closed) return;
    loading = true;
    try {
      const currentTaskId = tasks[selected]?.id;
      const nextTasks = await listTasks(root);
      if (nextTasks.length > 0) {
        tasks = nextTasks;
        if (currentTaskId) {
          const nextSelected = tasks.findIndex((t) => t.id === currentTaskId);
          selected = nextSelected >= 0 ? nextSelected : Math.min(selected, tasks.length - 1);
        } else {
          selected = Math.min(selected, tasks.length - 1);
        }
      }

      const task = tasks[selected];
      if (!task) {
        bodyCache = "(task disappeared)";
      } else {
        bodyCache = await loadScreen(root, task, SCREENS[screenIndex]!);
      }
      lastUpdatedAt = new Date().toLocaleTimeString();
    } finally {
      loading = false;
      requestRender();
    }
  };

  await ctx.ui.custom<void>(
    (tui: any, _theme: any, _kb: any, done: (value: void) => void) => {
      const requestRefresh = () => void refresh(() => tui.requestRender());
      const interval = setInterval(requestRefresh, 1500);
      requestRefresh();

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        done(undefined);
      };

      return {
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) {
            close();
            return;
          }
          if (matchesKey(data, Key.up)) {
            selected = (selected - 1 + tasks.length) % tasks.length;
            requestRefresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            selected = (selected + 1) % tasks.length;
            requestRefresh();
            return;
          }
          if (matchesKey(data, Key.left)) {
            screenIndex = (screenIndex - 1 + SCREENS.length) % SCREENS.length;
            requestRefresh();
            return;
          }
          if (matchesKey(data, Key.right)) {
            screenIndex = (screenIndex + 1) % SCREENS.length;
            requestRefresh();
            return;
          }
        },
        render(width: number): string[] {
          const task = tasks[selected];
          const screen = SCREENS[screenIndex]!;
          const taskLabel = task ? `${task.id}-${task.name}` : "(missing task)";
          const liveState = loading ? "refreshing…" : `auto 1.5s • updated ${lastUpdatedAt}`;
          const title = `Fleet Inspect — ${taskLabel}  [${screen}]`;
          const footer = `↑/↓ task  ←/→ screen  esc close  ${liveState}   screens: ${SCREENS.join(" • ")}`;
          const usable = Math.min(width - 4, 140);
          return boxLines(usable, title, bodyCache, footer);
        },
        invalidate() {
          closed = true;
          clearInterval(interval);
        },
      };
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%", margin: 1 } },
  );
}
