#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  PlanningError,
  analyzeSnapshot,
  buildDaily,
  collectDraftContext,
  collectPortfolio,
  dailyToMarkdown,
  getPortfolio,
  groomingToMarkdown,
  loadConfig,
  normalizeSnapshot,
  snapshotToMarkdown,
  validateDraft,
} from "./github-planning/lib.mjs";

const HELP = `Deterministic cross-repository GitHub planning

Usage:
  node scripts/github-planning.mjs config [--config PATH]
  node scripts/github-planning.mjs snapshot [PORTFOLIO] [--format json|markdown] [--fixture PATH] [--config PATH]
  node scripts/github-planning.mjs groom [PORTFOLIO] [--format json|markdown] [--fixture PATH] [--config PATH]
  node scripts/github-planning.mjs daily [PORTFOLIO] [--format json|markdown] [--fixture PATH] [--config PATH]
  node scripts/github-planning.mjs validate-draft [PORTFOLIO] --draft PATH [--form FILE] [--context-fixture PATH] [--config PATH]

Configuration defaults to ~/.pi/agent/github-workflow.json. Set PI_GITHUB_WORKFLOW_CONFIG
for tests or nonstandard installations. Inspection commands never mutate GitHub or write config.
See docs/github-planning.md and docs/github-workflow.example.json.
`;

function parseArgs(argv) {
  const values = { positional: [] };
  const valueOptions = new Set(["config", "format", "fixture", "draft", "form", "context-fixture"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      values.positional.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (name === "help") values[name] = true;
    else {
      if (!valueOptions.has(name)) throw new PlanningError("ARGUMENT_INVALID", `Unknown option --${name}`);
      const next = inline ?? argv[++index];
      if (next === undefined || next.startsWith("--")) throw new PlanningError("ARGUMENT_INVALID", `--${name} requires a value`);
      values[name] = next;
    }
  }
  return values;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PlanningError("INPUT_INVALID", `Cannot read ${label} JSON at ${path}: ${error.message}`);
  }
}

function print(value, format, markdown) {
  if (format === "json") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (format === "markdown") process.stdout.write(markdown(value));
  else throw new PlanningError("FORMAT_INVALID", `Unsupported format "${format}"; use json or markdown`);
}

function snapshotFor(config, portfolioName, args) {
  const raw = args.fixture ? readJson(args.fixture, "snapshot fixture") : collectPortfolio(config, portfolioName);
  return normalizeSnapshot(config, portfolioName, raw);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];
  if (!command || command === "help" || args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!["config", "snapshot", "groom", "daily", "validate-draft"].includes(command)) {
    throw new PlanningError("COMMAND_INVALID", `Unknown command "${command}"\n\n${HELP}`);
  }
  const maxPositionals = command === "config" ? 1 : 2;
  if (args.positional.length > maxPositionals) throw new PlanningError("ARGUMENT_INVALID", `Too many positional arguments for ${command}`);
  const { path, config } = loadConfig({ path: args.config });
  const portfolioName = args.positional[1];
  switch (command) {
    case "config": {
      const portfolioNames = Object.keys(config.portfolios).sort();
      process.stdout.write(`${JSON.stringify({ valid: true, path, version: config.version, portfolios: portfolioNames }, null, 2)}\n`);
      return;
    }
    case "snapshot": {
      const snapshot = snapshotFor(config, portfolioName, args);
      print(snapshot, args.format ?? "json", snapshotToMarkdown);
      return;
    }
    case "groom": {
      const analysis = analyzeSnapshot(snapshotFor(config, portfolioName, args));
      print(analysis, args.format ?? "markdown", groomingToMarkdown);
      return;
    }
    case "daily": {
      const daily = buildDaily(snapshotFor(config, portfolioName, args));
      print(daily, args.format ?? "markdown", dailyToMarkdown);
      return;
    }
    case "validate-draft": {
      if (!args.draft) throw new PlanningError("ARGUMENT_REQUIRED", "validate-draft requires --draft PATH");
      const draft = readJson(args.draft, "draft");
      if (!draft.repository) throw new PlanningError("DRAFT_REPOSITORY_REQUIRED", "Draft JSON requires repository");
      const selectedPortfolio = getPortfolio(config, portfolioName);
      const context = args["context-fixture"]
        ? readJson(args["context-fixture"], "draft context fixture")
        : collectDraftContext(draft.repository, { issueForm: args.form ?? draft.issueForm, title: draft.title });
      const result = validateDraft(config, selectedPortfolio.name, draft, context);
      print(result, args.format ?? "json", (value) => `${JSON.stringify(value, null, 2)}\n`);
      return;
    }
    default:
      throw new PlanningError("COMMAND_INVALID", `Unknown command "${command}"\n\n${HELP}`);
  }
}

try {
  main();
} catch (error) {
  const payload = error instanceof PlanningError
    ? { error: error.code, message: error.message, details: error.details }
    : { error: "UNEXPECTED", message: error?.stack || String(error) };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}
