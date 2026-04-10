/**
 * Task file parser - reads PLAN.md and TASK-{n}.md files
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface TaskDef {
	id: number;
	title: string;
	specialist: string;
	filePath: string;
	content: string;
	dependsOn: number[];
}

export interface PlanDef {
	goal: string;
	tasks: TaskDef[];
	planPath: string;
}

/**
 * Parse PLAN.md and discover TASK-{n}.md files in the given directory.
 */
export function parsePlan(cwd: string): PlanDef | null {
	const planPath = path.join(cwd, "PLAN.md");
	if (!fs.existsSync(planPath)) return null;

	let planContent: string;
	try {
		planContent = fs.readFileSync(planPath, "utf-8");
	} catch {
		return null;
	}

	// Extract goal from first heading or ## Goal section
	let goal = "Unknown goal";
	const goalSection = planContent.match(/##\s*Goal\s*\n+([^\n#]+)/i);
	if (goalSection) {
		goal = goalSection[1].trim();
	} else {
		const firstHeading = planContent.match(/^#\s+(?:Plan:\s*)?(.+)$/m);
		if (firstHeading) goal = firstHeading[1].trim();
	}

	// Discover TASK-{n}.md files
	const tasks: TaskDef[] = [];

	let entries: string[];
	try {
		entries = fs.readdirSync(cwd);
	} catch {
		return { goal, tasks, planPath };
	}

	const taskFiles = entries
		.filter((f) => /^TASK-\d+\.md$/i.test(f))
		.sort((a, b) => {
			const numA = Number.parseInt(a.match(/\d+/)![0], 10);
			const numB = Number.parseInt(b.match(/\d+/)![0], 10);
			return numA - numB;
		});

	for (const file of taskFiles) {
		const id = Number.parseInt(file.match(/\d+/)![0], 10);
		const filePath = path.join(cwd, file);

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		// Extract title from first heading
		const titleMatch = content.match(/^#\s+TASK-\d+:\s*(.+)$/m);
		const title = titleMatch ? titleMatch[1].trim() : `Task ${id}`;

		// Extract specialist from ## Specialist section
		const specMatch = content.match(/##\s*Specialist\s*\n+\s*(\S+)/i);
		const specialist = specMatch ? specMatch[1].trim().toLowerCase() : "worker";

		// Extract dependencies from ## Depends on or the PLAN.md task entry
		const dependsOn: number[] = [];
		const depsMatch = content.match(/depends\s+on[:\s]+(.+)/i);
		if (depsMatch) {
			const depsText = depsMatch[1];
			for (const m of depsText.matchAll(/TASK-(\d+)/gi)) {
				dependsOn.push(Number.parseInt(m[1], 10));
			}
		}

		tasks.push({ id, title, specialist, filePath, content, dependsOn });
	}

	return { goal, tasks, planPath };
}
