# pi-clean

Custom [pi](https://github.com/badlogic/pi) package collection — multi-agent orchestration.

## Install

```bash
pi install git:git@github.com:mtrenker/pi-clean.git
```

## Features

### 🤖 Orchestrator Extension

Multi-agent workflow that automatically scouts, plans, and executes tasks with specialist subagents.

**Flow:**
1. **Scout** (haiku) — fast codebase recon, gathers context
2. **Planner** (sonnet) — creates `PLAN.md` + `TASK-{n}.md` files with horizontal task slices
3. **Specialists** execute tasks in dependency order with parallelism:
   - **Worker** — implements features, writes code
   - **Reviewer** — code review for quality & security
   - **Tester** — writes and runs tests
   - **Red Team** — adversarial analysis, finds edge cases & vulnerabilities

**Usage:**
```
/orchestrate add Redis caching to the session store
```

Or just tell the agent what you want and it will use the `orchestrate` tool.

**Commands:**
| Command | Description |
|---------|-------------|
| `/orchestrate <goal>` | Start orchestration workflow |
| `/plan-status` | Show current plan progress |

**Progress UI:**
- Widget shows real-time task progress above the editor
- Status bar shows current phase and completion count
- Expanded tool view (Ctrl+O) shows full output per task with markdown rendering

### 📋 Prompt Templates

| Template | Description |
|----------|-------------|
| `/orchestrate` | Full orchestration workflow |

## Structure

```
pi-clean/
├── extensions/orchestrator/   # Main orchestrator extension
│   ├── index.ts               # Extension entry + tool + rendering
│   ├── agents.ts              # Agent discovery
│   ├── runner.ts              # Subagent process spawning
│   └── tasks.ts               # PLAN.md / TASK-{n}.md parser
├── agents/                    # Agent definitions
│   ├── scout.md               # Fast recon (haiku)
│   ├── planner.md             # Plan creation (sonnet)
│   ├── worker.md              # Code implementation (sonnet)
│   ├── reviewer.md            # Code review (sonnet)
│   ├── tester.md              # Test writing (sonnet)
│   └── red-team.md            # Adversarial analysis (sonnet)
├── prompts/                   # Workflow prompt templates
│   └── orchestrate.md
├── skills/                    # (empty, add your own)
└── themes/                    # (empty, add your own)
```

## Agent Definitions

Agents are markdown files with YAML frontmatter in `agents/`. The orchestrator discovers them automatically.

```yaml
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt goes here.
```

## License

MIT
