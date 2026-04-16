# Task 007: Commands & Wiring

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: 004, 005, 006

## Context

You are implementing the `fleet` extension for `pi`. This is the final task: wire everything together in `index.ts` by implementing all command handlers and the `fleet_status` tool. Task 001 created the skeleton; this task fills it in.

All previous tasks are done. Read ALL of these files before starting:
- `extensions/fleet/index.ts` — the skeleton to fill in
- `extensions/fleet/config.ts` — `loadConfig()`
- `extensions/fleet/plan.ts` — `loadPlan()`, `validateDependencies()`
- `extensions/fleet/task.ts` — `createTaskFolder()`, `listTasks()`, `readStatus()`, `writeStatus()`
- `extensions/fleet/state.ts` — `readAggregateState()`
- `extensions/fleet/orchestrator.ts` — `Orchestrator`
- `extensions/fleet/recovery.ts` — `handleFailure()`
- `extensions/fleet/widget.ts` — `FleetWidget`

## What to Implement in `extensions/fleet/index.ts`

### Module-level state (outside the default function)

The orchestrator and widget are singletons per pi session:

```typescript
let orchestrator: Orchestrator | null = null;
let widget: FleetWidget | null = null;
```

### `session_shutdown` event

```typescript
pi.on("session_shutdown", async () => {
  widget?.detach();
  await orchestrator?.stop();
});
```

### `/fleet:groom`

1. Read `.pi/tasks/PLAN.md`
2. Set editor text to the plan content with a prompt prefix asking the LLM to review/refine it
3. Use `ctx.ui.notify()` to guide the user

Implementation:
```typescript
const plan = await fs.readFile(path.join(ctx.cwd, ".pi/tasks/PLAN.md"), "utf8");
ctx.ui.setEditorText(
  `Please review and refine this plan. You can:\n` +
  `- Add or clarify task descriptions\n` +
  `- Adjust engine/model/agent assignments\n` +
  `- Fix or add dependencies\n` +
  `- Split large tasks into smaller ones\n\n` +
  `When done, write the updated PLAN.md to .pi/tasks/PLAN.md\n\n---\n\n${plan}`
);
ctx.ui.notify("Plan loaded into editor. Refine and ask the LLM to write the updated PLAN.md.", "info");
```

### `/fleet:split`

1. Load and parse PLAN.md via `loadPlan(ctx.cwd)`
2. Validate dependencies via `validateDependencies(tasks)`
3. For each task, call `createTaskFolder(ctx.cwd, spec)`
4. Skip tasks that already have a folder (check if folder exists)
5. Notify: `"Created N task folders in .pi/tasks/"` 

On error: `ctx.ui.notify(error.message, "error")`

### `/fleet:start [taskId?]`

1. Load config via `loadConfig(ctx.cwd)`
2. Create orchestrator if not exists: `new Orchestrator(ctx.cwd, config)`
3. Set up recovery integration:
   ```typescript
   orchestrator.on("task:status", async (event) => {
     if (event.status === "retrying") {
       await handleFailure({
         cwd: ctx.cwd,
         taskState: event.state,
         orchestrator,
         onNotify: (msg) => ctx.ui.notify(msg, "warning"),
       });
     }
     if (event.status === "failed") {
       ctx.ui.notify(`Task ${event.id}-${event.name} failed.`, "error");
     }
   });
   ```
4. Create and attach widget:
   ```typescript
   widget = new FleetWidget(
     orchestrator,
     (id, lines) => ctx.ui.setWidget(id, lines),
     (id) => ctx.ui.setWidget(id, undefined)
   );
   widget.attach();
   ```
5. Call `orchestrator.start(args ? [args] : undefined)`
6. Notify: `"Fleet started"` / show task count

### `/fleet:stop [taskId?]`

```typescript
if (!orchestrator) {
  ctx.ui.notify("No fleet running", "info");
  return;
}
await orchestrator.stop(args || undefined);
ctx.ui.notify(args ? `Stopped task ${args}` : "All tasks stopped", "info");
```

### `/fleet:status`

1. Read all task states via `listTasks(ctx.cwd)`
2. Format a multi-line status summary
3. Show via `ctx.ui.notify()` or inject as a message into the conversation

Format:
```
Fleet Status (N tasks)
✓ 001-explore-auth     done    pi/sonnet    12.4k tokens
● 002-refactor-auth    running claude/sonnet 8.1k tokens
◌ 003-update-service   blocked codex/o3
```

Use `pi.sendMessage()` so it appears in the conversation and the LLM can see it:
```typescript
pi.sendMessage({
  customType: "fleet-status",
  content: formattedStatus,
  display: true,
});
```

### `/fleet:retry [taskId]`

```typescript
if (!args) { ctx.ui.notify("Usage: /fleet:retry <task-id>", "error"); return; }
if (!orchestrator) {
  // Create orchestrator if not running (user may be retrying after restart)
  const config = await loadConfig(ctx.cwd);
  orchestrator = new Orchestrator(ctx.cwd, config);
}
await orchestrator.retry(args);
ctx.ui.notify(`Retrying task ${args}`, "info");
```

### `/fleet:reset [taskId]`

```typescript
if (!args) { ctx.ui.notify("Usage: /fleet:reset <task-id>", "error"); return; }
const tasks = await listTasks(ctx.cwd);
const task = tasks.find(t => t.id === args);
if (!task) { ctx.ui.notify(`Task ${args} not found`, "error"); return; }

const dir = taskDir(ctx.cwd, task.id, task.name);
await fs.writeFile(path.join(dir, "progress.jsonl"), "");
await fs.writeFile(path.join(dir, "output.jsonl"), "");
try { await fs.unlink(path.join(dir, "recovery.md")); } catch {}
await writeStatus(ctx.cwd, { ...task, status: "pending", retries: 0, error: null, pid: null, startedAt: null, completedAt: null, duration: null, usage: { inputTokens: 0, outputTokens: 0 } });
ctx.ui.notify(`Task ${args} reset to pending`, "info");
```

### `fleet_status` tool

Replace the stub from task 001:

```typescript
pi.registerTool({
  name: "fleet_status",
  label: "Fleet Status",
  description: "Get the current status of fleet tasks. Use this to answer questions about task progress, what's running, what failed, etc.",
  promptSnippet: "Get current status of fleet agent tasks",
  parameters: Type.Object({
    taskId: Type.Optional(Type.String({ description: "Specific task ID (e.g. '001'), or omit for all tasks" })),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const tasks = await listTasks(ctx.cwd);
    const filtered = params.taskId ? tasks.filter(t => t.id === params.taskId) : tasks;

    if (filtered.length === 0) {
      return { content: [{ type: "text", text: params.taskId ? `Task ${params.taskId} not found` : "No tasks found. Run /fleet:split first." }], details: {} };
    }

    const lines = filtered.map(t => {
      const tokens = t.usage.inputTokens + t.usage.outputTokens;
      const tokenStr = tokens > 0 ? ` | ${(tokens/1000).toFixed(1)}k tokens` : "";
      return `${t.status.padEnd(10)} ${t.id}-${t.name.padEnd(25)} ${t.engine}/${t.model}${tokenStr}`;
    });

    return {
      content: [{ type: "text", text: `Fleet tasks:\n${lines.join("\n")}` }],
      details: { tasks: filtered },
    };
  },
});
```

## Acceptance Criteria
- All commands are implemented and functional
- `/fleet:split` creates correct folder structure
- `/fleet:start` launches agents, shows widget, handles recovery
- `/fleet:status` shows readable output and injects into conversation
- `fleet_status` tool returns useful information to the LLM
- Session shutdown stops all agents cleanly
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
