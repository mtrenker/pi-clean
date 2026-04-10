/**
 * Agent discovery and configuration for the orchestrator.
 * Loads agent definitions from the package's agents/ directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

export function discoverAgents(extensionDir: string): AgentConfig[] {
	// The agents/ dir is at the package root, two levels up from extensions/orchestrator/
	const agentsDir = path.resolve(extensionDir, "..", "..", "agents");
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(agentsDir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(agentsDir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(agentsDir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			filePath,
		});
	}

	return agents;
}

/** Map specialist type from TASK files to agent name */
export function specialistToAgent(specialist: string): string {
	const mapping: Record<string, string> = {
		// Core specialists
		worker: "worker",
		reviewer: "reviewer",
		tester: "tester",
		"red-team": "red-team",
		redteam: "red-team",
		"red team": "red-team",
		// Domain specialists
		frontend: "frontend",
		front: "frontend",
		ui: "frontend",
		css: "frontend",
		backend: "backend",
		api: "backend",
		server: "backend",
		database: "database",
		db: "database",
		schema: "database",
		migration: "database",
		devops: "devops",
		infra: "devops",
		infrastructure: "devops",
		ci: "devops",
		cicd: "devops",
		"ci/cd": "devops",
		docker: "devops",
		deployment: "devops",
		security: "security",
		sec: "security",
		auth: "security",
		performance: "performance",
		perf: "performance",
		optimization: "performance",
	};
	return mapping[specialist.toLowerCase()] ?? "worker";
}
