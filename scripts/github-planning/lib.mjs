import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const CONFIG_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_CONFIG_PATH = "~/.pi/agent/github-workflow.json";
export const CONFIG_ENV = "PI_GITHUB_WORKFLOW_CONFIG";

export const BUILTIN_DEFAULTS = Object.freeze({
  fields: {
    status: ["Status"],
    priority: ["Priority"],
    size: ["Size"],
  },
  options: {
    status: {
      inbox: ["Inbox"],
      backlog: ["Backlog"],
      ready: ["Ready"],
      inProgress: ["In progress", "In Progress"],
      inReview: ["In review", "In Review"],
      done: ["Done"],
    },
    priority: ["P0", "P1", "P2", "P3"],
    size: ["XS", "S", "M", "L"],
  },
  labels: {
    agentReady: ["agent-ready"],
    needsHuman: ["needs-human"],
  },
  limits: { inProgress: 3, inReview: 2 },
  staleDays: 30,
  requiredDraftSections: {
    outcome: ["Desired outcome", "Outcome"],
    scope: ["Scope"],
    nonGoals: ["Non-goals", "Non goals", "Out of scope"],
    acceptance: ["Acceptance criteria"],
    dependencies: ["Dependencies", "Dependencies and risks"],
    validation: ["Validation"],
  },
});

export const FINDING_CODES = Object.freeze({
  BLOCKER_OPEN: "BLOCKER_OPEN",
  PARENT_IN_READY: "PARENT_IN_READY",
  SIZE_L_READY: "SIZE_L_READY",
  READINESS_LABEL_CONFLICT: "READINESS_LABEL_CONFLICT",
  PROJECT_FIELD_UNRESOLVED: "PROJECT_FIELD_UNRESOLVED",
  ITEM_FIELD_MISSING: "ITEM_FIELD_MISSING",
  WIP_LIMIT_EXCEEDED: "WIP_LIMIT_EXCEEDED",
  REVIEW_LIMIT_EXCEEDED: "REVIEW_LIMIT_EXCEEDED",
  STALE_ITEM: "STALE_ITEM",
});

export class PlanningError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function mergeSettings(base, override = {}) {
  const result = clone(base);
  for (const key of ["fields", "labels", "requiredDraftSections"]) {
    if (override[key] !== undefined) {
      result[key] = { ...result[key], ...clone(override[key]) };
    }
  }
  if (override.options !== undefined) {
    result.options = {
      ...result.options,
      ...clone(override.options),
      status: { ...result.options.status, ...(override.options.status ?? {}) },
    };
  }
  if (override.limits !== undefined) result.limits = { ...result.limits, ...clone(override.limits) };
  if (override.staleDays !== undefined) result.staleDays = override.staleDays;
  return result;
}

function validateAliasMap(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, aliases] of Object.entries(value)) {
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      errors.push(`${path}.${key} must be a non-empty array of strings`);
    }
  }
}

function validateSettings(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (value.fields !== undefined) validateAliasMap(value.fields, `${path}.fields`, errors);
  if (value.labels !== undefined) validateAliasMap(value.labels, `${path}.labels`, errors);
  if (value.requiredDraftSections !== undefined) validateAliasMap(value.requiredDraftSections, `${path}.requiredDraftSections`, errors);
  if (value.options !== undefined) {
    if (!isObject(value.options)) errors.push(`${path}.options must be an object`);
    else {
      if (value.options.status !== undefined) validateAliasMap(value.options.status, `${path}.options.status`, errors);
      for (const key of ["priority", "size"]) {
        if (value.options[key] !== undefined && (!Array.isArray(value.options[key]) || value.options[key].some((item) => typeof item !== "string" || !item.trim()))) {
          errors.push(`${path}.options.${key} must be an array of strings`);
        }
      }
    }
  }
  if (value.limits !== undefined) {
    if (!isObject(value.limits)) errors.push(`${path}.limits must be an object`);
    else {
      for (const key of ["inProgress", "inReview"]) {
        if (value.limits[key] !== undefined && (!Number.isInteger(value.limits[key]) || value.limits[key] < 0)) {
          errors.push(`${path}.limits.${key} must be a non-negative integer`);
        }
      }
    }
  }
  if (value.staleDays !== undefined && (!Number.isInteger(value.staleDays) || value.staleDays < 1)) {
    errors.push(`${path}.staleDays must be a positive integer`);
  }
}

function repositoryName(entry) {
  return typeof entry === "string" ? entry : entry?.name;
}

export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) return { valid: false, errors: ["configuration must be a JSON object"] };
  if (config.version !== CONFIG_VERSION) errors.push(`version must be ${CONFIG_VERSION}`);
  if (config.defaults !== undefined) validateSettings(config.defaults, "defaults", errors);
  if (!isObject(config.portfolios) || Object.keys(config.portfolios).length === 0) {
    errors.push("portfolios must be a non-empty object");
  } else {
    for (const [name, portfolio] of Object.entries(config.portfolios)) {
      const path = `portfolios.${name}`;
      if (!isObject(portfolio)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      const configuredRepositories = new Set();
      if (!Array.isArray(portfolio.repositories) || portfolio.repositories.length === 0) {
        errors.push(`${path}.repositories must be a non-empty array`);
      } else {
        for (const [index, repository] of portfolio.repositories.entries()) {
          const repo = repositoryName(repository);
          if (typeof repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
            errors.push(`${path}.repositories[${index}] must be "owner/name" or an object with that name`);
          } else if (configuredRepositories.has(repo.toLowerCase())) {
            errors.push(`${path}.repositories contains duplicate ${repo}`);
          } else {
            configuredRepositories.add(repo.toLowerCase());
          }
          if (isObject(repository) && repository.projects !== undefined) {
            if (!Array.isArray(repository.projects)) errors.push(`${path}.repositories[${index}].projects must be an array`);
            else for (const [projectIndex, project] of repository.projects.entries()) {
              const projectPath = `${path}.repositories[${index}].projects[${projectIndex}]`;
              if (!isObject(project) || typeof project.owner !== "string" || !project.owner.trim()) errors.push(`${projectPath}.owner must be a string`);
              if (!isObject(project) || !Number.isInteger(project.number) || project.number < 1) errors.push(`${projectPath}.number must be a positive integer`);
            }
          }
        }
      }
      if (portfolio.projects !== undefined) {
        if (!Array.isArray(portfolio.projects)) errors.push(`${path}.projects must be an array`);
        else {
          const seen = new Set();
          for (const [index, project] of portfolio.projects.entries()) {
            const projectPath = `${path}.projects[${index}]`;
            if (!isObject(project) || typeof project.owner !== "string" || !project.owner.trim()) errors.push(`${projectPath}.owner must be a string`);
            if (!isObject(project) || !Number.isInteger(project.number) || project.number < 1) errors.push(`${projectPath}.number must be a positive integer`);
            const key = `${project?.owner}/${project?.number}`.toLowerCase();
            if (seen.has(key)) errors.push(`${path}.projects contains duplicate ${project?.owner}/${project?.number}`);
            seen.add(key);
            if (project?.repositories !== undefined) {
              if (!Array.isArray(project.repositories) || project.repositories.some((repo) => typeof repo !== "string")) {
                errors.push(`${projectPath}.repositories must be an array of repository names`);
              } else for (const repository of project.repositories) {
                if (!configuredRepositories.has(repository.toLowerCase())) errors.push(`${projectPath}.repositories contains unconfigured ${repository}`);
              }
            }
          }
        }
      }
      if (portfolio.settings !== undefined) validateSettings(portfolio.settings, `${path}.settings`, errors);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function resolveConfigPath(path, env = process.env) {
  const configured = path || env[CONFIG_ENV] || DEFAULT_CONFIG_PATH;
  return configured.startsWith("~/") ? resolve(homedir(), configured.slice(2)) : resolve(configured);
}

export function loadConfig({ path, env = process.env } = {}) {
  const resolvedPath = resolveConfigPath(path, env);
  if (!existsSync(resolvedPath)) {
    throw new PlanningError(
      "CONFIG_NOT_FOUND",
      `GitHub workflow configuration not found at ${resolvedPath}. Copy docs/github-workflow.example.json there or set ${CONFIG_ENV}.`,
      { path: resolvedPath },
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    throw new PlanningError("CONFIG_INVALID_JSON", `Cannot parse GitHub workflow configuration at ${resolvedPath}: ${error.message}`, { path: resolvedPath });
  }
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new PlanningError("CONFIG_INVALID", `Invalid GitHub workflow configuration at ${resolvedPath}:\n- ${validation.errors.join("\n- ")}`, {
      path: resolvedPath,
      errors: validation.errors,
    });
  }
  return { path: resolvedPath, config };
}

export function getPortfolio(config, name) {
  const names = Object.keys(config.portfolios).sort();
  const selectedName = name || (names.length === 1 ? names[0] : undefined);
  if (!selectedName) throw new PlanningError("PORTFOLIO_REQUIRED", `Choose a portfolio: ${names.join(", ")}`);
  const portfolio = config.portfolios[selectedName];
  if (!portfolio) throw new PlanningError("PORTFOLIO_NOT_FOUND", `Portfolio "${selectedName}" is not configured. Available: ${names.join(", ")}`);
  const settings = mergeSettings(mergeSettings(BUILTIN_DEFAULTS, config.defaults), portfolio.settings);
  return {
    name: selectedName,
    repositories: portfolio.repositories.map(repositoryName),
    projects: normalizeProjectMappings(portfolio),
    settings,
  };
}

function normalizeProjectMappings(portfolio) {
  const projects = [];
  for (const project of portfolio.projects ?? []) {
    projects.push({ owner: project.owner, number: project.number, repositories: uniqueStrings(project.repositories ?? []) });
  }
  for (const repository of portfolio.repositories) {
    if (!isObject(repository)) continue;
    for (const project of repository.projects ?? []) {
      projects.push({ owner: project.owner, number: project.number, repositories: [repository.name] });
    }
  }
  const merged = new Map();
  for (const project of projects) {
    const key = `${project.owner.toLowerCase()}/${project.number}`;
    const current = merged.get(key) ?? { owner: project.owner, number: project.number, repositories: [] };
    current.repositories = uniqueStrings([...current.repositories, ...project.repositories]);
    merged.set(key, current);
  }
  return [...merged.values()].sort((a, b) => a.owner.localeCompare(b.owner) || a.number - b.number);
}

function normalized(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function matchesAlias(value, aliases) {
  const candidate = normalized(value);
  return aliases.some((alias) => normalized(alias) === candidate);
}

function canonicalStatus(value, settings) {
  for (const [canonical, aliases] of Object.entries(settings.options.status)) {
    if (matchesAlias(value, aliases)) return canonical;
  }
  return value ? `other:${value}` : null;
}

function projectKey(project) {
  return `${project.owner}/${project.number}`;
}

function itemKey(repository, number, itemType) {
  return `${repository}#${number}:${itemType}`;
}

function fieldValue(item, aliases) {
  return item.fieldValues?.find((field) => matchesAlias(field.fieldName, aliases))?.value ?? null;
}

function sourceProject(project, projectItem) {
  return {
    owner: project.owner,
    number: project.number,
    id: project.id,
    title: project.title,
    url: project.url,
    itemId: projectItem.id,
  };
}

function baseNormalizedItem(content) {
  const itemType = content.itemType === "PULL_REQUEST" || content.pull_request ? "PULL_REQUEST" : "ISSUE";
  return {
    id: itemKey(content.repository, content.number, itemType),
    repository: content.repository,
    number: content.number,
    itemType,
    title: content.title ?? "",
    url: content.url ?? null,
    state: (content.state ?? "UNKNOWN").toUpperCase(),
    projectStatus: null,
    priority: null,
    size: null,
    projectValues: [],
    labels: uniqueStrings((content.labels ?? []).map((label) => typeof label === "string" ? label : label.name)).sort(),
    assignees: uniqueStrings((content.assignees ?? []).map((assignee) => typeof assignee === "string" ? assignee : assignee.login)).sort(),
    parent: content.parent ?? null,
    hasChildren: Boolean(content.hasChildren),
    blockers: {
      availability: content.blockersAvailability ?? (Array.isArray(content.blockers) ? "available" : "unavailable"),
      items: (content.blockers ?? []).map((blocker) => ({
        repository: blocker.repository ?? content.repository,
        number: blocker.number,
        title: blocker.title ?? "",
        state: (blocker.state ?? "UNKNOWN").toUpperCase(),
        url: blocker.url ?? null,
      })).sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number),
    },
    updatedAt: content.updatedAt ?? null,
    linkedPullRequest: content.linkedPullRequest ?? null,
    review: content.review ?? { decision: null, attention: [] },
    checks: content.checks ?? { status: "UNKNOWN", failed: [] },
    sourceProjects: [],
    missingConfiguredFields: [],
    availability: {
      parent: content.parentAvailability ?? "unavailable",
      blockers: content.blockersAvailability ?? (Array.isArray(content.blockers) ? "available" : "unavailable"),
      linkedPullRequest: content.linkedPullRequestAvailability ?? "unavailable",
    },
  };
}

function mergeContent(target, content) {
  for (const key of ["title", "url", "updatedAt"]) if (content[key]) target[key] = content[key];
  if (content.state) target.state = content.state.toUpperCase();
  target.labels = uniqueStrings([...target.labels, ...((content.labels ?? []).map((label) => typeof label === "string" ? label : label.name))]).sort();
  target.assignees = uniqueStrings([...target.assignees, ...((content.assignees ?? []).map((assignee) => typeof assignee === "string" ? assignee : assignee.login))]).sort();
  if (content.parentAvailability === "available" || content.parent) {
    target.parent = content.parent ?? null;
    target.availability.parent = "available";
  }
  if (content.hasChildren !== undefined) target.hasChildren = Boolean(content.hasChildren);
  if (content.blockersAvailability === "available" || Array.isArray(content.blockers)) {
    target.blockers = baseNormalizedItem({ repository: target.repository, number: target.number, blockers: content.blockers ?? [], blockersAvailability: "available" }).blockers;
    target.availability.blockers = "available";
  }
  if (content.linkedPullRequestAvailability === "available" || content.linkedPullRequest) {
    target.linkedPullRequest = content.linkedPullRequest ?? null;
    target.availability.linkedPullRequest = "available";
  }
  if (content.review) target.review = content.review;
  if (content.checks) target.checks = content.checks;
}

export function normalizeSnapshot(config, portfolioName, raw) {
  const portfolio = getPortfolio(config, portfolioName);
  if (!isObject(raw) || !Array.isArray(raw.repositories) || !Array.isArray(raw.projects)) {
    throw new PlanningError("SOURCE_INVALID", "Collector response must contain repositories and projects arrays");
  }
  const errors = raw.errors ?? [];
  if (errors.length) {
    throw new PlanningError("SOURCE_PARTIAL", "GitHub returned partial data; refusing to produce a clean snapshot", { errors });
  }
  const items = new Map();
  const configuredRepositoryNames = new Map(portfolio.repositories.map((repo) => [repo.toLowerCase(), repo]));
  const canonicalRepository = (repo) => configuredRepositoryNames.get(repo?.toLowerCase()) ?? repo;
  const canonicalContent = (content, fallbackRepository = content.repository) => ({
    ...content,
    repository: canonicalRepository(fallbackRepository),
    parent: content.parent ? { ...content.parent, repository: canonicalRepository(content.parent.repository) } : content.parent,
    blockers: content.blockers?.map((blocker) => ({ ...blocker, repository: canonicalRepository(blocker.repository ?? fallbackRepository) })),
    linkedPullRequest: content.linkedPullRequest ? { ...content.linkedPullRequest, repository: canonicalRepository(content.linkedPullRequest.repository) } : content.linkedPullRequest,
  });
  for (const repository of raw.repositories) {
    const canonicalName = configuredRepositoryNames.get(repository.name.toLowerCase());
    if (!canonicalName) continue;
    for (const content of [...(repository.issues ?? []), ...(repository.pullRequests ?? [])]) {
      const normalizedContent = canonicalContent(content, canonicalName);
      const item = baseNormalizedItem(normalizedContent);
      items.set(item.id, item);
    }
  }
  const sourceProjects = [];
  for (const project of [...raw.projects].sort((a, b) => a.owner.localeCompare(b.owner) || a.number - b.number)) {
    const mapping = portfolio.projects.find((candidate) => candidate.owner.toLowerCase() === project.owner.toLowerCase() && candidate.number === project.number);
    if (!mapping) continue;
    const fieldNames = (project.fields ?? []).map((field) => field.name);
    const unresolvedFields = Object.entries(portfolio.settings.fields)
      .filter(([, aliases]) => !fieldNames.some((name) => matchesAlias(name, aliases)))
      .map(([canonical]) => canonical)
      .sort();
    sourceProjects.push({
      owner: project.owner,
      number: project.number,
      id: project.id,
      title: project.title,
      url: project.url,
      fields: (project.fields ?? []).map((field) => ({ id: field.id, name: field.name, options: field.options ?? [] })).sort((a, b) => a.name.localeCompare(b.name)),
      unresolvedFields,
    });
    for (const projectItem of project.items ?? []) {
      const rawContent = projectItem.content;
      if (!rawContent?.repository || !configuredRepositoryNames.has(rawContent.repository.toLowerCase())) continue;
      if (mapping.repositories.length && !mapping.repositories.some((repo) => repo.toLowerCase() === rawContent.repository.toLowerCase())) continue;
      const content = canonicalContent(rawContent);
      const itemType = content.itemType === "PULL_REQUEST" ? "PULL_REQUEST" : "ISSUE";
      const id = itemKey(content.repository, content.number, itemType);
      const item = items.get(id) ?? baseNormalizedItem(content);
      mergeContent(item, content);
      const values = {
        sourceProject: projectKey(project),
        status: fieldValue(projectItem, portfolio.settings.fields.status),
        priority: fieldValue(projectItem, portfolio.settings.fields.priority),
        size: fieldValue(projectItem, portfolio.settings.fields.size),
      };
      item.projectValues.push(values);
      item.sourceProjects.push(sourceProject(project, projectItem));
      item.missingConfiguredFields = uniqueStrings([
        ...item.missingConfiguredFields,
        ...unresolvedFields.map((field) => `${projectKey(project)}:${field}`),
        ...Object.entries(values).filter(([key, value]) => key !== "sourceProject" && !value).map(([key]) => `${projectKey(project)}:${key}`),
      ]).sort();
      items.set(id, item);
    }
  }
  for (const item of items.values()) {
    item.projectValues.sort((a, b) => a.sourceProject.localeCompare(b.sourceProject));
    item.sourceProjects.sort((a, b) => a.owner.localeCompare(b.owner) || a.number - b.number);
    const preferred = item.projectValues[0];
    item.projectStatus = canonicalStatus(preferred?.status, portfolio.settings);
    item.priority = preferred?.priority ?? null;
    item.size = preferred?.size ?? null;
  }
  const orderedItems = [...items.values()].sort((a, b) =>
    a.repository.localeCompare(b.repository) ||
    a.number - b.number ||
    a.itemType.localeCompare(b.itemType),
  );
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    portfolio: portfolio.name,
    capturedAt: raw.capturedAt ?? null,
    settings: portfolio.settings,
    sources: {
      repositories: portfolio.repositories.map((name) => ({ name })).sort((a, b) => a.name.localeCompare(b.name)),
      projects: sourceProjects,
    },
    items: orderedItems,
  };
}

function finding(code, message, { item = null, severity = "warning", evidence = {}, requiresHumanDecision = false } = {}) {
  return {
    code,
    severity,
    itemId: item?.id ?? null,
    message,
    evidence,
    requiresHumanDecision,
  };
}

function hasLabel(item, aliases) {
  return item.labels.some((label) => matchesAlias(label, aliases));
}

function statusIs(item, canonical) {
  return item.projectStatus === canonical;
}

export function analyzeSnapshot(snapshot) {
  const settings = snapshot.settings;
  const findings = [];
  for (const project of snapshot.sources.projects) {
    for (const field of project.unresolvedFields) {
      findings.push(finding(FINDING_CODES.PROJECT_FIELD_UNRESOLVED, `${project.owner} Project ${project.number} does not expose configured ${field} field aliases`, {
        severity: "error",
        evidence: { project: `${project.owner}/${project.number}`, field },
      }));
    }
  }
  for (const item of snapshot.items) {
    for (const blocker of item.blockers.items.filter((candidate) => candidate.state === "OPEN")) {
      findings.push(finding(FINDING_CODES.BLOCKER_OPEN, `${item.id} is blocked by open ${blocker.repository}#${blocker.number}`, {
        item,
        evidence: { blocker },
      }));
    }
    if (statusIs(item, "ready") && item.hasChildren) {
      findings.push(finding(FINDING_CODES.PARENT_IN_READY, `${item.id} is a parent issue admitted to Ready`, { item, evidence: { hasChildren: true } }));
    }
    if (statusIs(item, "ready") && matchesAlias(item.size, ["L"])) {
      findings.push(finding(FINDING_CODES.SIZE_L_READY, `${item.id} has Size L in Ready and should be split`, { item, evidence: { size: item.size } }));
    }
    if (hasLabel(item, settings.labels.agentReady) && hasLabel(item, settings.labels.needsHuman)) {
      findings.push(finding(FINDING_CODES.READINESS_LABEL_CONFLICT, `${item.id} has both agent-ready and needs-human labels`, {
        item,
        evidence: { labels: item.labels },
        requiresHumanDecision: true,
      }));
    }
    for (const field of item.missingConfiguredFields) {
      findings.push(finding(FINDING_CODES.ITEM_FIELD_MISSING, `${item.id} is missing configured Project value ${field}`, {
        item,
        evidence: { field },
      }));
    }
    const capturedAt = Date.parse(snapshot.capturedAt);
    const updatedAt = Date.parse(item.updatedAt);
    if (item.state === "OPEN" && Number.isFinite(capturedAt) && Number.isFinite(updatedAt) && capturedAt - updatedAt > settings.staleDays * 86_400_000) {
      findings.push(finding(FINDING_CODES.STALE_ITEM, `${item.id} has not been updated within the configured ${settings.staleDays}-day threshold`, {
        item,
        evidence: { updatedAt: item.updatedAt, capturedAt: snapshot.capturedAt, staleDays: settings.staleDays },
        requiresHumanDecision: true,
      }));
    }
  }
  const inProgress = snapshot.items.filter((item) => item.state === "OPEN" && statusIs(item, "inProgress"));
  const inReview = snapshot.items.filter((item) => item.state === "OPEN" && statusIs(item, "inReview"));
  if (inProgress.length > settings.limits.inProgress) {
    findings.push(finding(FINDING_CODES.WIP_LIMIT_EXCEEDED, `In-progress WIP is ${inProgress.length}; configured limit is ${settings.limits.inProgress}`, {
      severity: "error",
      evidence: { count: inProgress.length, limit: settings.limits.inProgress, items: inProgress.map((item) => item.id).sort() },
      requiresHumanDecision: true,
    }));
  }
  if (inReview.length > settings.limits.inReview) {
    findings.push(finding(FINDING_CODES.REVIEW_LIMIT_EXCEEDED, `Review WIP is ${inReview.length}; configured limit is ${settings.limits.inReview}`, {
      severity: "error",
      evidence: { count: inReview.length, limit: settings.limits.inReview, items: inReview.map((item) => item.id).sort() },
      requiresHumanDecision: true,
    }));
  }
  findings.sort((a, b) => a.code.localeCompare(b.code) || (a.itemId ?? "").localeCompare(b.itemId ?? "") || a.message.localeCompare(b.message));
  return { schemaVersion: 1, portfolio: snapshot.portfolio, findings };
}

function priorityRank(item, settings) {
  const rank = settings.options.priority.findIndex((value) => matchesAlias(item.priority, [value]));
  return rank === -1 ? settings.options.priority.length : rank;
}

export function buildDaily(snapshot) {
  const analysis = analyzeSnapshot(snapshot);
  const disallowed = new Set(analysis.findings
    .filter((finding) => [
      FINDING_CODES.BLOCKER_OPEN,
      FINDING_CODES.PARENT_IN_READY,
      FINDING_CODES.SIZE_L_READY,
      FINDING_CODES.READINESS_LABEL_CONFLICT,
      FINDING_CODES.ITEM_FIELD_MISSING,
    ].includes(finding.code))
    .map((finding) => finding.itemId)
    .filter(Boolean));
  const compareCandidates = (a, b) =>
    priorityRank(a, snapshot.settings) - priorityRank(b, snapshot.settings) ||
    a.repository.localeCompare(b.repository) ||
    a.number - b.number ||
    a.itemType.localeCompare(b.itemType);
  const attention = snapshot.items.filter((item) =>
    item.state === "OPEN" && (item.checks.status === "FAILURE" || item.review.attention.length > 0),
  ).sort(compareCandidates);
  const continuation = snapshot.items.filter((item) =>
    item.state === "OPEN" && (statusIs(item, "inProgress") || statusIs(item, "inReview")),
  ).sort(compareCandidates);
  const blockersAndDecisions = snapshot.items.filter((item) =>
    item.state === "OPEN" && (item.blockers.items.some((blocker) => blocker.state === "OPEN") || hasLabel(item, snapshot.settings.labels.needsHuman)),
  ).sort(compareCandidates);
  const readyCandidates = snapshot.items.filter((item) =>
    item.itemType === "ISSUE" &&
    item.state === "OPEN" &&
    statusIs(item, "ready") &&
    !hasLabel(item, snapshot.settings.labels.needsHuman) &&
    !disallowed.has(item.id),
  ).sort(compareCandidates);
  const inProgressCount = continuation.filter((item) => statusIs(item, "inProgress")).length;
  const inReviewCount = continuation.filter((item) => statusIs(item, "inReview")).length;
  return {
    schemaVersion: 1,
    portfolio: snapshot.portfolio,
    limits: {
      inProgress: { count: inProgressCount, limit: snapshot.settings.limits.inProgress, exceeded: inProgressCount > snapshot.settings.limits.inProgress },
      inReview: { count: inReviewCount, limit: snapshot.settings.limits.inReview, exceeded: inReviewCount > snapshot.settings.limits.inReview },
    },
    sections: { attention, continuation, blockersAndDecisions, readyCandidates },
    findings: analysis.findings,
    decisionRequired: "The operator must choose today's outcome and capacity; this report does not assign semantic priority or mutate GitHub.",
  };
}

function sectionPresent(body, aliases) {
  const lines = String(body ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const heading = normalized(match[1]);
    if (!aliases.some((alias) => heading === normalized(alias) || heading.includes(normalized(alias)))) continue;
    const content = [];
    for (let next = index + 1; next < lines.length && !/^#{1,6}\s+/.test(lines[next]); next += 1) content.push(lines[next]);
    if (content.join("\n").trim()) return true;
  }
  return false;
}

function tokenize(value) {
  return uniqueStrings(String(value ?? "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((word) => !["the", "and", "for", "with", "from", "this", "that", "feature", "issue"].includes(word));
}

function duplicateScore(title, candidateTitle) {
  const left = new Set(tokenize(title));
  const right = new Set(tokenize(candidateTitle));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

export const DRAFT_CODES = Object.freeze({
  TITLE_MISSING: "DRAFT_TITLE_MISSING",
  SECTION_MISSING: "DRAFT_SECTION_MISSING",
  ISSUE_FORM_REQUIRED: "ISSUE_FORM_REQUIRED",
  ISSUE_FORM_FIELD_MISSING: "ISSUE_FORM_FIELD_MISSING",
  LABEL_INVALID: "DRAFT_LABEL_INVALID",
});

export function validateDraft(config, portfolioName, draft, repositoryContext) {
  const portfolio = getPortfolio(config, portfolioName);
  if (!portfolio.repositories.some((repo) => repo.toLowerCase() === draft.repository?.toLowerCase())) {
    throw new PlanningError("REPOSITORY_NOT_CONFIGURED", `${draft.repository} is not in portfolio ${portfolio.name}`);
  }
  const findings = [];
  if (!draft.title?.trim()) findings.push({ code: DRAFT_CODES.TITLE_MISSING, message: "Draft title is required", field: "title" });
  for (const [section, aliases] of Object.entries(portfolio.settings.requiredDraftSections)) {
    if (!sectionPresent(draft.body, aliases)) {
      findings.push({ code: DRAFT_CODES.SECTION_MISSING, message: `Draft is missing required ${section} section (${aliases.join(" / ")})`, field: section });
    }
  }
  if ((repositoryContext.forms?.length ?? 0) > 1 && !repositoryContext.selectedIssueForm) {
    findings.push({
      code: DRAFT_CODES.ISSUE_FORM_REQUIRED,
      message: `Choose one repository issue form: ${repositoryContext.forms.map((form) => form.name).sort().join(", ")}`,
      field: "issueForm",
    });
  }
  const validLabels = new Set((repositoryContext.validLabels ?? []).map(normalized));
  for (const label of uniqueStrings(draft.labels ?? [])) {
    if (!validLabels.has(normalized(label))) findings.push({ code: DRAFT_CODES.LABEL_INVALID, message: `Label "${label}" does not exist in ${draft.repository}`, field: "labels" });
  }
  for (const expected of repositoryContext.requiredIssueFormFields ?? []) {
    if (!sectionPresent(draft.body, [expected])) {
      findings.push({ code: DRAFT_CODES.ISSUE_FORM_FIELD_MISSING, message: `Draft does not satisfy required issue-form field "${expected}"`, field: expected });
    }
  }
  findings.sort((a, b) => a.code.localeCompare(b.code) || a.field.localeCompare(b.field));
  const duplicateCandidates = (repositoryContext.existingIssues ?? [])
    .map((issue) => ({ ...issue, score: duplicateScore(draft.title, issue.title) }))
    .filter((issue) => issue.score >= 0.2)
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .map((issue) => ({ number: issue.number, title: issue.title, url: issue.url, state: issue.state, score: Number(issue.score.toFixed(3)) }));
  return {
    schemaVersion: 1,
    repository: draft.repository,
    valid: findings.length === 0,
    findings,
    duplicateCandidates,
    issueForms: {
      available: (repositoryContext.forms ?? []).map((form) => form.name).sort(),
      selected: repositoryContext.selectedIssueForm ?? null,
      requiredFields: [...(repositoryContext.requiredIssueFormFields ?? [])].sort(),
    },
    proposedMutation: {
      operation: "createIssue",
      repository: draft.repository,
      title: draft.title,
      body: draft.body,
      labels: uniqueStrings(draft.labels ?? []).sort(),
      milestone: draft.milestone ?? null,
      assignees: uniqueStrings(draft.assignees ?? []).sort(),
      parent: draft.parent ?? null,
      dependencies: draft.dependencies ?? { blockedBy: [], blocking: [] },
      projectChanges: draft.projectChanges ?? [],
    },
    mutationApplied: false,
  };
}

function classifyGhFailure(error, args) {
  const output = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`;
  if (/rate limit/i.test(output)) return new PlanningError("GITHUB_RATE_LIMIT", `GitHub rate limit prevented: gh ${args.join(" ")}`);
  if (/resource not accessible|insufficient scope|read:project|project scope|forbidden/i.test(output)) {
    return new PlanningError("GITHUB_PERMISSION", `GitHub permission or Project scope is missing for: gh ${args.join(" ")}`);
  }
  if (/not found|could not resolve|HTTP 404/i.test(output)) return new PlanningError("GITHUB_TARGET_UNRESOLVED", `Configured GitHub target could not be resolved: gh ${args.join(" ")}`);
  return new PlanningError("GITHUB_API_ERROR", `GitHub command failed: gh ${args.join(" ")}: ${String(error.stderr || error.message).trim()}`);
}

export function runGh(args) {
  try {
    const output = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.trim() ? JSON.parse(output) : null;
  } catch (error) {
    throw classifyGhFailure(error, args);
  }
}

function graphqlData(response, context) {
  if (response?.errors?.length) {
    const messages = response.errors.map((error) => error.message).join("; ");
    if (/rate limit/i.test(messages)) throw new PlanningError("GITHUB_RATE_LIMIT", `${context}: ${messages}`);
    if (/scope|permission|forbidden|resource not accessible/i.test(messages)) throw new PlanningError("GITHUB_PERMISSION", `${context}: ${messages}`);
    throw new PlanningError("GITHUB_API_ERROR", `${context}: ${messages}`);
  }
  if (!response?.data) throw new PlanningError("GITHUB_PARTIAL_RESPONSE", `${context}: GitHub response did not contain data`);
  return response.data;
}

function mapPr(pr, repository) {
  const failed = (pr.statusCheckRollup ?? []).filter((check) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(check.conclusion || check.state));
  const pending = (pr.statusCheckRollup ?? []).some((check) => !check.conclusion && !["SUCCESS", "FAILURE", "ERROR"].includes(check.state));
  const attention = [];
  if (pr.isDraft) attention.push("DRAFT");
  if (pr.reviewDecision === "CHANGES_REQUESTED") attention.push("CHANGES_REQUESTED");
  if (!pr.reviewDecision && !pr.isDraft) attention.push("REVIEW_REQUIRED");
  return {
    repository,
    number: pr.number,
    itemType: "PULL_REQUEST",
    title: pr.title,
    url: pr.url,
    state: pr.state,
    labels: (pr.labels ?? []).map((label) => label.name),
    assignees: (pr.assignees ?? []).map((assignee) => assignee.login),
    updatedAt: pr.updatedAt,
    review: { decision: pr.reviewDecision ?? null, attention },
    checks: { status: failed.length ? "FAILURE" : pending ? "PENDING" : "SUCCESS", failed: failed.map((check) => check.name || check.context).filter(Boolean).sort() },
  };
}

const ISSUE_DETAILS_QUERY = `
query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    issues(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        number title url state updatedAt
        labels(first:100){pageInfo{hasNextPage} nodes{name}}
        assignees(first:100){pageInfo{hasNextPage} nodes{login}}
        parent{number title url state repository{nameWithOwner}}
        subIssues(first:1){totalCount}
        blockedBy(first:100){pageInfo{hasNextPage} nodes{number title url state repository{nameWithOwner}}}
        closedByPullRequestsReferences(first:20){pageInfo{hasNextPage} nodes{number title url state repository{nameWithOwner}}}
      }
    }
  }
}`;

function mapIssueDetails(issue, repository) {
  for (const [name, connection] of [["labels", issue.labels], ["assignees", issue.assignees], ["blockers", issue.blockedBy], ["linked pull requests", issue.closedByPullRequestsReferences]]) {
    if (connection?.pageInfo?.hasNextPage) throw new PlanningError("GITHUB_PARTIAL_RESPONSE", `${repository}#${issue.number} has more ${name} than the normalized schema page supports`);
  }
  const linked = [...(issue.closedByPullRequestsReferences?.nodes ?? [])]
    .sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || a.number - b.number)[0];
  return {
    repository,
    number: issue.number,
    itemType: "ISSUE",
    title: issue.title,
    url: issue.url,
    state: issue.state,
    labels: (issue.labels?.nodes ?? []).map((label) => label.name),
    assignees: (issue.assignees?.nodes ?? []).map((assignee) => assignee.login),
    parent: issue.parent ? {
      repository: issue.parent.repository.nameWithOwner,
      number: issue.parent.number,
      title: issue.parent.title,
      state: issue.parent.state,
      url: issue.parent.url,
    } : null,
    parentAvailability: "available",
    hasChildren: (issue.subIssues?.totalCount ?? 0) > 0,
    blockers: (issue.blockedBy?.nodes ?? []).map((blocker) => ({
      repository: blocker.repository.nameWithOwner,
      number: blocker.number,
      title: blocker.title,
      state: blocker.state,
      url: blocker.url,
    })),
    blockersAvailability: "available",
    linkedPullRequest: linked ? {
      repository: linked.repository.nameWithOwner,
      number: linked.number,
      title: linked.title,
      state: linked.state,
      url: linked.url,
    } : null,
    linkedPullRequestAvailability: "available",
    updatedAt: issue.updatedAt,
  };
}

function collectRepositoryIssues(repository, gh) {
  const [owner, name] = repository.split("/");
  const issues = [];
  let cursor = null;
  do {
    const args = ["api", "graphql", "-f", `query=${ISSUE_DETAILS_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const data = graphqlData(gh(args), `Cannot inspect ${repository}`);
    const connection = data.repository?.issues;
    if (!connection) throw new PlanningError("GITHUB_TARGET_UNRESOLVED", `Configured repository ${repository} could not be resolved`);
    issues.push(...(connection.nodes ?? []).map((issue) => mapIssueDetails(issue, repository)));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo?.hasNextPage && !cursor) throw new PlanningError("GITHUB_PARTIAL_RESPONSE", `${repository} issue pagination omitted an end cursor`);
  } while (cursor);
  return issues;
}

const PROJECT_QUERY = `
query($owner:String!,$number:Int!,$cursor:String){
  repositoryOwner(login:$owner){
    ... on User{projectV2(number:$number){...ProjectData}}
    ... on Organization{projectV2(number:$number){...ProjectData}}
  }
}
fragment ProjectData on ProjectV2 {
  id number title url
  fields(first:100){pageInfo{hasNextPage} nodes{
    ... on ProjectV2FieldCommon{id name dataType}
    ... on ProjectV2SingleSelectField{id name dataType options{id name}}
  }}
  items(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{
    id
    fieldValues(first:50){pageInfo{hasNextPage} nodes{
      ... on ProjectV2ItemFieldSingleSelectValue{field{... on ProjectV2FieldCommon{id name}} name optionId}
      ... on ProjectV2ItemFieldTextValue{field{... on ProjectV2FieldCommon{id name}} text}
      ... on ProjectV2ItemFieldNumberValue{field{... on ProjectV2FieldCommon{id name}} number}
      ... on ProjectV2ItemFieldDateValue{field{... on ProjectV2FieldCommon{id name}} date}
      ... on ProjectV2ItemFieldIterationValue{field{... on ProjectV2FieldCommon{id name}} title iterationId}
    }}
    content{
      __typename
      ... on Issue{number title url state updatedAt repository{nameWithOwner} labels(first:100){nodes{name}} assignees(first:100){nodes{login}}}
      ... on PullRequest{number title url state updatedAt repository{nameWithOwner} labels(first:100){nodes{name}} assignees(first:100){nodes{login}}}
    }
  }}
}`;

function parseFieldValue(node) {
  const value = node.name ?? node.text ?? node.number ?? node.date ?? node.title ?? null;
  return node.field?.name ? { fieldId: node.field.id, fieldName: node.field.name, value } : null;
}

function mapProjectItem(node) {
  if (!node.content?.repository?.nameWithOwner) return { id: node.id, content: null, fieldValues: [] };
  return {
    id: node.id,
    content: {
      repository: node.content.repository.nameWithOwner,
      number: node.content.number,
      itemType: node.content.__typename === "PullRequest" ? "PULL_REQUEST" : "ISSUE",
      title: node.content.title,
      url: node.content.url,
      state: node.content.state,
      updatedAt: node.content.updatedAt,
      labels: (node.content.labels?.nodes ?? []).map((label) => label.name),
      assignees: (node.content.assignees?.nodes ?? []).map((assignee) => assignee.login),
    },
    fieldValues: (node.fieldValues?.nodes ?? []).map(parseFieldValue).filter(Boolean),
    fieldValuesPartial: Boolean(node.fieldValues?.pageInfo?.hasNextPage),
  };
}

function collectProject(project, gh) {
  let cursor = null;
  let result = null;
  const items = [];
  do {
    const args = ["api", "graphql", "-f", `query=${PROJECT_QUERY}`, "-F", `owner=${project.owner}`, "-F", `number=${project.number}`];
    if (cursor) args.push("-F", `cursor=${cursor}`);
    const data = graphqlData(gh(args), `Cannot inspect Project ${project.owner}/${project.number}`);
    const page = data.repositoryOwner?.projectV2;
    if (!page) throw new PlanningError("GITHUB_TARGET_UNRESOLVED", `Project ${project.owner}/${project.number} could not be resolved`);
    if (page.fields?.pageInfo?.hasNextPage) {
      throw new PlanningError("GITHUB_PARTIAL_RESPONSE", `Project ${project.owner}/${project.number} has more than 100 fields; refusing a partial snapshot`);
    }
    const mapped = (page.items?.nodes ?? []).map(mapProjectItem);
    if (mapped.some((item) => item.fieldValuesPartial)) {
      throw new PlanningError("GITHUB_PARTIAL_RESPONSE", `A Project ${project.owner}/${project.number} item has more than 50 field values; refusing a partial snapshot`);
    }
    items.push(...mapped.filter((item) => item.content));
    result = page;
    cursor = page.items?.pageInfo?.hasNextPage ? page.items.pageInfo.endCursor : null;
    if (page.items?.pageInfo?.hasNextPage && !cursor) {
      throw new PlanningError("GITHUB_PARTIAL_RESPONSE", `Project ${project.owner}/${project.number} item pagination omitted an end cursor`);
    }
  } while (cursor);
  return {
    owner: project.owner,
    number: project.number,
    id: result.id,
    title: result.title,
    url: result.url,
    fields: (result.fields?.nodes ?? []).filter((field) => field?.name).map((field) => ({ id: field.id, name: field.name, options: field.options ?? [] })),
    items,
  };
}

export function collectPortfolio(config, portfolioName, { gh = runGh, now = () => new Date().toISOString() } = {}) {
  const portfolio = getPortfolio(config, portfolioName);
  const repositories = [];
  for (const name of portfolio.repositories) {
    const issues = collectRepositoryIssues(name, gh);
    const prData = gh(["pr", "list", "--repo", name, "--state", "open", "--limit", "1000", "--json", "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,labels,assignees,updatedAt"]);
    const pullRequests = (prData ?? []).map((pr) => mapPr(pr, name));
    repositories.push({ name, issues, pullRequests });
  }
  const projects = portfolio.projects.map((project) => collectProject(project, gh));
  return { capturedAt: now(), repositories, projects, errors: [] };
}

function decodeContent(response) {
  if (!response?.content) return "";
  return Buffer.from(response.content.replace(/\n/g, ""), response.encoding || "base64").toString("utf8");
}

export function parseIssueFormRequiredFields(yaml) {
  const fields = [];
  const blocks = String(yaml).split(/\n(?=\s*-\s+type:\s*)/);
  for (const block of blocks) {
    if (!/\n?\s*validations:\s*[\s\S]*?required:\s*true\b/i.test(block)) continue;
    const label = block.match(/\n\s*label:\s*["']?([^\n"']+)/i)?.[1]?.trim();
    if (label) fields.push(label);
  }
  return uniqueStrings(fields);
}

export function collectDraftContext(repository, { gh = runGh, issueForm = null, title = "" } = {}) {
  const validLabels = (gh(["label", "list", "--repo", repository, "--limit", "1000", "--json", "name"]) ?? []).map((label) => label.name).sort();
  let entries = [];
  try {
    entries = gh(["api", `repos/${repository}/contents/.github/ISSUE_TEMPLATE`]) ?? [];
  } catch (error) {
    if (!(error instanceof PlanningError) || error.code !== "GITHUB_TARGET_UNRESOLVED") throw error;
  }
  const forms = entries.filter((entry) => /\.ya?ml$/i.test(entry.name) && !/^config\.ya?ml$/i.test(entry.name)).map((entry) => {
    const response = gh(["api", `repos/${repository}/contents/${entry.path}`]);
    const yaml = decodeContent(response);
    return { name: entry.name, path: entry.path, requiredFields: parseIssueFormRequiredFields(yaml) };
  });
  let selected = issueForm ? forms.find((form) => form.name === issueForm || form.path === issueForm) : null;
  if (issueForm && !selected) throw new PlanningError("ISSUE_FORM_NOT_FOUND", `Issue form ${issueForm} was not found in ${repository}`);
  if (!selected && forms.length === 1) selected = forms[0];
  const searchTerms = tokenize(title).slice(0, 5).join(" OR ");
  const existingIssues = searchTerms
    ? gh(["issue", "list", "--repo", repository, "--state", "all", "--limit", "50", "--search", `${searchTerms} in:title`, "--json", "number,title,url,state"])
    : [];
  return { validLabels, forms, selectedIssueForm: selected?.name ?? null, requiredIssueFormFields: selected?.requiredFields ?? [], existingIssues: existingIssues ?? [] };
}

export function snapshotToMarkdown(snapshot) {
  const lines = [`# GitHub portfolio: ${snapshot.portfolio}`, "", `Captured: ${snapshot.capturedAt ?? "fixture/unknown"}`, ""];
  if (!snapshot.items.length) return `${lines.join("\n")}No items.\n`;
  lines.push("| Item | Type | Status | Priority | Size | Attention |", "| --- | --- | --- | --- | --- | --- |");
  for (const item of snapshot.items) {
    const attention = [item.checks.status === "FAILURE" ? "failed checks" : null, ...item.review.attention, item.blockers.items.some((blocker) => blocker.state === "OPEN") ? "blocked" : null].filter(Boolean).join(", ");
    lines.push(`| ${item.repository}#${item.number} ${item.title.replace(/\|/g, "\\|")} | ${item.itemType} | ${item.projectStatus ?? "—"} | ${item.priority ?? "—"} | ${item.size ?? "—"} | ${attention || "—"} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function groomingToMarkdown(analysis) {
  const lines = [`# Grooming: ${analysis.portfolio}`, ""];
  if (!analysis.findings.length) return `${lines.join("\n")}No deterministic structural findings. Semantic readiness still requires human review.\n`;
  for (const item of analysis.findings) lines.push(`- **${item.code}**${item.itemId ? ` (${item.itemId})` : ""}: ${item.message}`);
  lines.push("", "These findings are deterministic evidence, not a readiness score or an automatic priority decision.");
  return `${lines.join("\n")}\n`;
}

function dailyItem(item) {
  return `${item.repository}#${item.number} — ${item.title}`;
}

export function dailyToMarkdown(daily) {
  const definitions = [
    ["Review and failed-check attention", daily.sections.attention],
    ["Continue current work", daily.sections.continuation],
    ["Blockers and human decisions", daily.sections.blockersAndDecisions],
    ["Unblocked Ready candidates", daily.sections.readyCandidates],
  ];
  const lines = [`# GitHub daily: ${daily.portfolio}`];
  for (const [heading, items] of definitions) {
    lines.push("", `## ${heading}`);
    if (heading === "Continue current work") {
      const inProgress = daily.limits.inProgress;
      const inReview = daily.limits.inReview;
      lines.push(`WIP: In progress ${inProgress.count}/${inProgress.limit}${inProgress.exceeded ? " (limit exceeded)" : ""}; In review ${inReview.count}/${inReview.limit}${inReview.exceeded ? " (limit exceeded)" : ""}.`, "");
    }
    lines.push(...(items.length ? items.map((item) => `- ${dailyItem(item)}`) : ["- None"]));
  }
  lines.push("", `> ${daily.decisionRequired}`);
  return `${lines.join("\n")}\n`;
}
