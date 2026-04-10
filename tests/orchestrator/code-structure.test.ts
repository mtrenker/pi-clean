/**
 * Code Structure Validation Tests
 * 
 * These tests verify that key orchestrator components are correctly structured
 * without requiring a full orchestration run.
 */

import { describe, it, expect } from "@jest/globals";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Orchestrator Code Structure", () => {
	const extensionDir = path.resolve(__dirname, "../../extensions/orchestrator");

	describe("Required Files", () => {
		it("should have index.ts", () => {
			expect(fs.existsSync(path.join(extensionDir, "index.ts"))).toBe(true);
		});

		it("should have runner.ts", () => {
			expect(fs.existsSync(path.join(extensionDir, "runner.ts"))).toBe(true);
		});

		it("should have agents.ts", () => {
			expect(fs.existsSync(path.join(extensionDir, "agents.ts"))).toBe(true);
		});

		it("should have tasks.ts", () => {
			expect(fs.existsSync(path.join(extensionDir, "tasks.ts"))).toBe(true);
		});
	});

	describe("Spinner Animation Constants", () => {
		it("should define SPINNER_FRAMES", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toContain("SPINNER_FRAMES");
			expect(content).toMatch(/SPINNER_FRAMES\s*=\s*\[.*⠋.*⠙.*⠹.*\]/);
		});

		it("should define SPINNER_INTERVAL_MS", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toContain("SPINNER_INTERVAL_MS");
		});

		it("should have startSpinner function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+startSpinner\s*\(/);
		});

		it("should have stopSpinner function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+stopSpinner\s*\(/);
		});
	});

	describe("Status State Machine", () => {
		it("should define VALID_TRANSITIONS", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toContain("VALID_TRANSITIONS");
			expect(content).toMatch(/pending.*running.*skipped/);
			expect(content).toMatch(/running.*done.*failed/);
		});

		it("should have isValidTransition function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+isValidTransition/);
		});

		it("should have updateTaskStatus function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+updateTaskStatus/);
		});
	});

	describe("Timeout Configuration", () => {
		it("should define SCOUT_TIMEOUT", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/SCOUT_TIMEOUT\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
		});

		it("should define PLANNER_TIMEOUT", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/PLANNER_TIMEOUT\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
		});

		it("should define TASK_TIMEOUT", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/TASK_TIMEOUT\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
		});

		it("runner should implement timeout logic", () => {
			const content = fs.readFileSync(path.join(extensionDir, "runner.ts"), "utf-8");
			expect(content).toContain("timeoutController");
			expect(content).toContain("setTimeout");
			expect(content).toMatch(/timeout.*abort/i);
		});
	});

	describe("Widget Cleanup", () => {
		it("should have cleanupOrchestration function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+cleanupOrchestration/);
		});

		it("should clear widget on cleanup", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/currentDetails\s*=\s*null/);
			expect(content).toMatch(/liveAgents\.clear\(\)/);
		});

		it("should have session shutdown handler", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/pi\.on\(\s*["']session_shutdown["']/);
		});

		it("should cleanup in finally block", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/\}\s*finally\s*\{[\s\S]*cleanupOrchestration/m);
		});
	});

	describe("Progress Throttling", () => {
		it("should define WIDGET_THROTTLE_MS", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toContain("WIDGET_THROTTLE_MS");
		});

		it("should have throttledUpdateWidget function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+throttledUpdateWidget/);
		});

		it("should support immediate updates for terminal states", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			// Should pass 'immediate' flag for terminal states
			expect(content).toMatch(/immediate.*terminal|terminal.*immediate/i);
		});
	});

	describe("Agent Tracking", () => {
		it("should have trackAgent function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+trackAgent/);
		});

		it("should have finishAgent function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+finishAgent/);
		});

		it("should have removeAgent function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).toMatch(/function\s+removeAgent/);
		});
	});

	describe("Missing Features (Should Fail)", () => {
		it("should NOT have checkpoint module (TASK-5 not implemented)", () => {
			expect(fs.existsSync(path.join(extensionDir, "checkpoint.ts"))).toBe(false);
		});

		it("should NOT have saveCheckpoint function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).not.toContain("saveCheckpoint");
		});

		it("should NOT have loadCheckpoint function", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).not.toContain("loadCheckpoint");
		});

		it("should NOT have retry logic (TASK-6 not implemented)", () => {
			const content = fs.readFileSync(path.join(extensionDir, "index.ts"), "utf-8");
			expect(content).not.toContain("isRetryableError");
			expect(content).not.toContain("MAX_RETRIES");
			expect(content).not.toContain("backoff");
		});
	});
});

describe("Agent Discovery", () => {
	const agentsDir = path.resolve(__dirname, "../../agents");

	it("should have agents directory", () => {
		expect(fs.existsSync(agentsDir)).toBe(true);
	});

	it("should have scout agent", () => {
		expect(fs.existsSync(path.join(agentsDir, "scout.md"))).toBe(true);
	});

	it("should have planner agent", () => {
		expect(fs.existsSync(path.join(agentsDir, "planner.md"))).toBe(true);
	});

	it("should have worker agent", () => {
		expect(fs.existsSync(path.join(agentsDir, "worker.md"))).toBe(true);
	});

	it("should have reviewer agent", () => {
		expect(fs.existsSync(path.join(agentsDir, "reviewer.md"))).toBe(true);
	});

	it("should have tester agent", () => {
		expect(fs.existsSync(path.join(agentsDir, "tester.md"))).toBe(true);
	});

	it("should have red-team agent", () => {
		expect(fs.existsSync(path.join(agentsDir, "red-team.md"))).toBe(true);
	});
});

describe("Runner Module", () => {
	const runnerPath = path.resolve(__dirname, "../../extensions/orchestrator/runner.ts");

	it("should export TaskResult interface", () => {
		const content = fs.readFileSync(runnerPath, "utf-8");
		expect(content).toMatch(/export\s+interface\s+TaskResult/);
	});

	it("should export runSubagent function", () => {
		const content = fs.readFileSync(runnerPath, "utf-8");
		expect(content).toMatch(/export\s+(async\s+)?function\s+runSubagent/);
	});

	it("should handle subprocess errors", () => {
		const content = fs.readFileSync(runnerPath, "utf-8");
		expect(content).toMatch(/proc\.on\(\s*["']error["']/);
	});

	it("should handle SIGTERM and SIGKILL", () => {
		const content = fs.readFileSync(runnerPath, "utf-8");
		expect(content).toContain("SIGTERM");
		expect(content).toContain("SIGKILL");
	});

	it("should clean up temp files in finally block", () => {
		const content = fs.readFileSync(runnerPath, "utf-8");
		expect(content).toMatch(/finally[\s\S]*unlinkSync/m);
	});
});
