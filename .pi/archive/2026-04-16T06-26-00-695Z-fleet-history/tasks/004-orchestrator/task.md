# Task 004: Orchestrator

## Configuration
- **engine**: claude
- **model**: sonnet
- **agent**: worker
- **depends**: 002, 003

## Context

You are implementing the `fleet` extension for `pi`. The orchestrator is the heart of fleet: it resolves dependencies, schedules agents up to a concurrency cap, manages engine processes, and emits events that other modules subscribe to.

Tasks 001-003 are done. Read these files before starting:
- `extensions/fleet/config.ts` — `FleetConfig`, `loadConfig()`, `resolveAgentPrompt()`
- `extensions/fleet/plan.ts` — `TaskSpec`
- `extensions/fleet/task.ts` — `TaskState`, `TaskStatus`, `readStatus()`, `writeStatus()`, `listTasks()`, `appendProgress()`
- `extensions/fleet/state.ts` — `buildAggregateState()`, `writeAggregateState()`
- `extensions/fleet/engines/index.ts` — `createEngineAdapter()`

## File to Create

### `extensions/fleet/orchestrator.ts`

The orchestrator extends Node's `EventEmitter`. All state changes emit events — the widget and state.json writer subscribe to these; the orchestrator does not reference them directly.

#### Events

```typescript
export interface TaskStatusEvent {
  id: string;
  name: string;
  status: TaskStatus;
  prevStatus: TaskStatus;
  state: TaskState;
}

export interface TaskProgressEvent {
  id: string;
  name: string;
  step: string;
  status: "running" | "done" | "error";
}

export interface TaskUsageEvent {
  id: string;
  name: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FleetDoneEvent {
  summary: AggregateState["summary"];
}

// Typed EventEmitter
export interface OrchestratorEvents {
  "task:status": (event: TaskStatusEvent) => void;
  "task:progress": (event: TaskProgressEvent) => void;
  "task:usage": (event: TaskUsageEvent) => void;
  "fleet:done": (event: FleetDoneEvent) => void;
}
```

Use TypeScript declaration merging or a typed EventEmitter wrapper to make `on()` and `emit()` type-safe.

#### Class

```typescript
export class Orchestrator extends EventEmitter {
  constructor(private cwd: string, private config: FleetConfig) {}

  // Start all tasks whose dependencies are met (up to concurrency cap)
  async start(taskIds?: string[]): Promise<void>

  // Stop one or all running agents
  async stop(taskId?: string): Promise<void>

  // Retry a specific failed task (called by recovery module)
  async retry(taskId: string): Promise<void>

  // Get current in-memory state snapshot
  getSnapshot(): TaskState[]

  // Helper: recompute and write state.json, then emit task:status
  private async onStatusChange(state: TaskState, prevStatus: TaskStatus): Promise<void>
}
```

#### Scheduling Logic

```
start(taskIds?):
  1. Load all TaskState from disk via listTasks()
  2. Build dependency graph
  3. Determine ready tasks: status=pending AND all depends are "done"
     - If taskIds provided, filter to only those (error if deps not met)
  4. While runningCount < config.concurrency AND readyTasks.length > 0:
     a. Dequeue next ready task
     b. spawnTask(task)
  5. If nothing started and nothing running: emit "fleet:done"

spawnTask(task):
  1. Resolve agent prompt via resolveAgentPrompt()
  2. Read task.md content
  3. Create engine adapter via createEngineAdapter()
  4. Spawn engine process with { taskPrompt: task.md content, agentPrompt, model, cwd, outputJsonlPath }
  5. Update status → "running", write status.json, emit "task:status"
  6. process.onProgress → appendProgress() + emit "task:progress"
  7. process.onUsageUpdate → update in-memory usage + emit "task:usage"
  8. process.onComplete → handleComplete(task, result)

handleComplete(task, result):
  1. If result.success:
     - Update status → "done", write status.json
     - Emit "task:status"
     - Write updated state.json
     - Check for newly unblocked tasks, call start() again
     - If nothing running and nothing pending: emit "fleet:done"
  2. If result.failed AND task.retries < 1:
     - Update status → "retrying", increment retries
     - Emit "task:status"
     - (recovery.ts will generate recovery.md and call orchestrator.retry())
  3. If result.failed AND task.retries >= 1:
     - Update status → "failed", write status.json
     - Emit "task:status" with error
     - Check if anything is still running; if not emit "fleet:done"
```

#### Important
- Keep a `Map<string, EngineProcess>` of running processes for `stop()`
- `stop()` calls `process.kill()` and updates status to `"failed"`
- All disk writes must be await-ed before emitting events so listeners see consistent state
- After every status change, call `writeAggregateState()` with fresh data

## Acceptance Criteria
- Orchestrator correctly schedules tasks respecting concurrency cap
- Dependencies are respected (task with `depends: ["001"]` doesn't start until 001 is `done`)
- All 4 event types are emitted at the right moments
- `stop()` kills the process and updates status
- `fleet:done` fires when all tasks are either `done` or `failed`
- No TypeScript errors (`npx tsc --noEmit` from repo root)

## Progress Tracking

Append to `progress.jsonl` in this task directory after each significant step:
```
{"ts":"<ISO timestamp>","step":"<description>","status":"done"|"running"|"error"}
```
