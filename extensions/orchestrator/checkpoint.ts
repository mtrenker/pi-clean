/**
 * Checkpoint management for orchestrator recovery
 * 
 * Saves orchestration state after scout and planner phases to enable
 * resumption if orchestration fails partway through.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskResult } from "./runner.js";

const CHECKPOINT_FILENAME = ".pi-orchestrator-checkpoint.json";
const CHECKPOINT_VERSION = 1;
const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export type CheckpointPhase = "scout" | "planner" | "execute";

export interface TaskCheckpoint {
	id: number;
	title: string;
	specialist: string;
	status: "pending" | "running" | "done" | "failed" | "skipped";
	result?: TaskResult;
}

export interface CheckpointData {
	version: number;
	goal: string;
	scoutHints?: string;
	cwd: string;
	phase: CheckpointPhase;
	scoutResult?: TaskResult;
	plannerResult?: TaskResult;
	planPath?: string;
	taskStates: TaskCheckpoint[];
	timestamp: string;
}

/**
 * Save checkpoint to disk
 */
export async function saveCheckpoint(data: CheckpointData, cwd: string): Promise<void> {
	const checkpointPath = path.join(cwd, CHECKPOINT_FILENAME);
	
	try {
		const json = JSON.stringify(data, null, 2);
		await fs.promises.writeFile(checkpointPath, json, "utf-8");
	} catch (error) {
		console.error("Failed to save checkpoint:", error);
		// Don't throw - checkpoint is best-effort
	}
}

/**
 * Load checkpoint from disk
 * Returns null if checkpoint doesn't exist, is invalid, or too old
 */
export async function loadCheckpoint(cwd: string): Promise<CheckpointData | null> {
	const checkpointPath = path.join(cwd, CHECKPOINT_FILENAME);
	
	try {
		// Check if file exists
		if (!fs.existsSync(checkpointPath)) {
			return null;
		}

		// Read and parse
		const json = await fs.promises.readFile(checkpointPath, "utf-8");
		const data = JSON.parse(json);

		// Validate checkpoint
		if (!isValidCheckpoint(data)) {
			console.warn("Invalid checkpoint structure, ignoring");
			return null;
		}

		// Check age
		const timestamp = new Date(data.timestamp);
		const age = Date.now() - timestamp.getTime();
		if (age > CHECKPOINT_MAX_AGE_MS) {
			console.warn(`Checkpoint too old (${Math.floor(age / 1000 / 60 / 60)}h), ignoring`);
			return null;
		}

		return data as CheckpointData;
	} catch (error) {
		console.warn("Failed to load checkpoint:", error);
		return null;
	}
}

/**
 * Delete checkpoint file
 */
export async function deleteCheckpoint(cwd: string): Promise<void> {
	const checkpointPath = path.join(cwd, CHECKPOINT_FILENAME);
	
	try {
		if (fs.existsSync(checkpointPath)) {
			await fs.promises.unlink(checkpointPath);
		}
	} catch (error) {
		console.error("Failed to delete checkpoint:", error);
		// Don't throw - this is cleanup
	}
}

/**
 * Validate checkpoint structure
 */
function isValidCheckpoint(data: any): boolean {
	if (!data || typeof data !== "object") {
		return false;
	}

	// Check required fields
	if (
		typeof data.version !== "number" ||
		data.version !== CHECKPOINT_VERSION ||
		typeof data.goal !== "string" ||
		typeof data.cwd !== "string" ||
		typeof data.phase !== "string" ||
		typeof data.timestamp !== "string" ||
		!Array.isArray(data.taskStates)
	) {
		return false;
	}

	// Validate phase
	const validPhases: CheckpointPhase[] = ["scout", "planner", "execute"];
	if (!validPhases.includes(data.phase)) {
		return false;
	}

	// Validate task states
	for (const task of data.taskStates) {
		if (
			typeof task.id !== "number" ||
			typeof task.title !== "string" ||
			typeof task.specialist !== "string" ||
			typeof task.status !== "string"
		) {
			return false;
		}
	}

	return true;
}

/**
 * Create a checkpoint from current orchestration state
 */
export function createCheckpoint(
	goal: string,
	cwd: string,
	phase: CheckpointPhase,
	options: {
		scoutHints?: string;
		scoutResult?: TaskResult;
		plannerResult?: TaskResult;
		planPath?: string;
		taskStates?: TaskCheckpoint[];
	} = {}
): CheckpointData {
	return {
		version: CHECKPOINT_VERSION,
		goal,
		scoutHints: options.scoutHints,
		cwd,
		phase,
		scoutResult: options.scoutResult,
		plannerResult: options.plannerResult,
		planPath: options.planPath,
		taskStates: options.taskStates || [],
		timestamp: new Date().toISOString(),
	};
}
