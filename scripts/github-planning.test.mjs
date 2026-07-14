import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FINDING_CODES,
  PlanningError,
  analyzeSnapshot,
  buildDaily,
  collectDraftContext,
  collectPortfolio,
  getPortfolio,
  loadConfig,
  normalizeSnapshot,
  parseIssueFormRequiredFields,
  validateConfig,
  validateDraft,
} from "./github-planning/lib.mjs";

const readFixture = async (name) => JSON.parse(await (await import("node:fs/promises")).readFile(new URL(`./github-planning/fixtures/${name}`, import.meta.url), "utf8"));

const config = await readFixture("config.json");
const source = await readFixture("source.json");
const draftContext = await readFixture("draft-context.json");

test("validates a two-repository portfolio with separate Projects", () => {
  assert.deepEqual(validateConfig(config), { valid: true, errors: [] });
  const portfolio = getPortfolio(config, "example");
  assert.deepEqual(portfolio.repositories, ["octo-org/service-alpha", "octo-org/service-beta"]);
  assert.deepEqual(portfolio.projects.map((project) => `${project.owner}/${project.number}`), ["octo-org/10", "octo-org/20"]);
});

test("rejects incompatible and malformed configuration", () => {
  const incompatible = structuredClone(config);
  incompatible.version = 2;
  incompatible.portfolios.example.repositories.push("not-a-repository");
  const result = validateConfig(incompatible);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /version must be 1/);
  assert.match(result.errors.join("\n"), /owner\/name/);

  const directory = mkdtempSync(join(tmpdir(), "github-planning-"));
  const path = join(directory, "config.json");
  writeFileSync(path, "{ nope");
  assert.throws(() => loadConfig({ env: { PI_GITHUB_WORKFLOW_CONFIG: path } }), (error) => error.code === "CONFIG_INVALID_JSON");
  assert.throws(() => loadConfig({ env: { PI_GITHUB_WORKFLOW_CONFIG: join(directory, "missing.json") } }), (error) => error.code === "CONFIG_NOT_FOUND");
});

test("normalizes multiple repositories and Projects with stable ordering and provenance", () => {
  const first = normalizeSnapshot(config, "example", source);
  const second = normalizeSnapshot(config, "example", structuredClone(source));
  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map((item) => item.id), [
    "octo-org/service-alpha#1:ISSUE",
    "octo-org/service-alpha#2:ISSUE",
    "octo-org/service-alpha#3:ISSUE",
    "octo-org/service-alpha#7:PULL_REQUEST",
    "octo-org/service-alpha#10:ISSUE",
    "octo-org/service-beta#5:ISSUE",
    "octo-org/service-beta#6:ISSUE",
    "octo-org/service-beta#11:ISSUE",
  ]);
  assert.equal(first.sources.projects[0].fields[0].id.startsWith("F_"), true);
  assert.equal(first.items[0].sourceProjects[0].itemId, "I1");
  assert.equal(first.items[0].projectStatus, "ready");

  const mixedCase = structuredClone(source);
  mixedCase.projects[0].items[0].content.repository = "Octo-Org/Service-Alpha";
  const canonical = normalizeSnapshot(config, "example", mixedCase);
  assert.equal(canonical.items.length, first.items.length);
  assert.equal(canonical.items[0].projectStatus, "ready");
  assert.equal(canonical.items[0].repository, "octo-org/service-alpha");
});

test("refuses partial source data instead of returning a misleading clean snapshot", () => {
  assert.throws(
    () => normalizeSnapshot(config, "example", { ...source, errors: [{ code: "FORBIDDEN" }] }),
    (error) => error.code === "SOURCE_PARTIAL",
  );
});

test("emits every deterministic admission and limit finding code", () => {
  const analysis = analyzeSnapshot(normalizeSnapshot(config, "example", source));
  const codes = new Set(analysis.findings.map((finding) => finding.code));
  for (const code of [
    FINDING_CODES.BLOCKER_OPEN,
    FINDING_CODES.PARENT_IN_READY,
    FINDING_CODES.SIZE_L_READY,
    FINDING_CODES.READINESS_LABEL_CONFLICT,
    FINDING_CODES.PROJECT_FIELD_UNRESOLVED,
    FINDING_CODES.ITEM_FIELD_MISSING,
    FINDING_CODES.WIP_LIMIT_EXCEEDED,
    FINDING_CODES.REVIEW_LIMIT_EXCEEDED,
  ]) assert.equal(codes.has(code), true, `missing ${code}`);
  assert.equal(analysis.findings.some((finding) => finding.code === FINDING_CODES.READINESS_LABEL_CONFLICT && finding.requiresHumanDecision), true);
});

test("daily report puts attention and continuation first and excludes inadmissible Ready work", () => {
  const daily = buildDaily(normalizeSnapshot(config, "example", source));
  assert.deepEqual(daily.sections.attention.map((item) => item.id), ["octo-org/service-alpha#7:PULL_REQUEST"]);
  assert.equal(daily.sections.continuation.length, 4);
  assert.deepEqual(daily.limits, {
    inProgress: { count: 2, limit: 1, exceeded: true },
    inReview: { count: 2, limit: 1, exceeded: true },
  });
  assert.deepEqual(daily.sections.readyCandidates.map((item) => item.id), ["octo-org/service-alpha#10:ISSUE"]);
  assert.match(daily.decisionRequired, /operator must choose/i);
});

test("validates structured drafts, labels, issue-form fields, and duplicate candidates without mutation", async () => {
  const validDraft = await readFixture("draft-valid.json");
  const valid = validateDraft(config, "example", validDraft, draftContext);
  assert.equal(valid.valid, true);
  assert.equal(valid.mutationApplied, false);
  assert.equal(valid.duplicateCandidates[0].number, 42);
  assert.equal(valid.proposedMutation.projectChanges.length, 1);
  assert.equal(valid.proposedMutation.parent.number, 1);
  assert.equal(valid.proposedMutation.dependencies.blockedBy[0].number, 2);

  const invalidDraft = await readFixture("draft-invalid.json");
  const invalid = validateDraft(config, "example", invalidDraft, draftContext);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.findings.some((finding) => finding.code === "DRAFT_LABEL_INVALID"), true);
  assert.equal(invalid.findings.filter((finding) => finding.code === "DRAFT_SECTION_MISSING").length, 4);
});

test("requires explicit issue-form selection when a repository has multiple forms", async () => {
  const draft = await readFixture("draft-valid.json");
  const context = {
    ...draftContext,
    forms: [{ name: "bug.yml" }, { name: "feature.yml" }],
    selectedIssueForm: null,
    requiredIssueFormFields: [],
  };
  const result = validateDraft(config, "example", draft, context);
  assert.equal(result.valid, false);
  assert.equal(result.findings.some((finding) => finding.code === "ISSUE_FORM_REQUIRED"), true);
  assert.deepEqual(result.issueForms.available, ["bug.yml", "feature.yml"]);
});

test("extracts required repository issue-form fields and excludes chooser config", () => {
  const yaml = `name: Feature\nbody:\n  - type: textarea\n    id: outcome\n    attributes:\n      label: Desired outcome\n    validations:\n      required: true\n  - type: input\n    id: optional\n    attributes:\n      label: Optional detail\n`;
  assert.deepEqual(parseIssueFormRequiredFields(yaml), ["Desired outcome"]);
  const gh = (args) => {
    if (args[0] === "label") return [];
    const endpoint = args.at(-1);
    if (endpoint.endsWith("ISSUE_TEMPLATE")) return [
      { name: "config.yml", path: ".github/ISSUE_TEMPLATE/config.yml" },
      { name: "feature.yml", path: ".github/ISSUE_TEMPLATE/feature.yml" },
    ];
    if (endpoint.endsWith("feature.yml")) return { encoding: "base64", content: Buffer.from(yaml).toString("base64") };
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const context = collectDraftContext("octo-org/service-alpha", { gh });
  assert.deepEqual(context.forms.map((form) => form.name), ["feature.yml"]);
  assert.equal(context.selectedIssueForm, "feature.yml");
});

test("collector resolves Project field and option IDs at runtime", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "pr") return [];
    if (args.includes("graphql")) {
      const query = args.find((arg) => arg.startsWith("query="));
      if (query.includes("issues(first:100")) {
        return { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
      }
      const owner = args.find((arg) => arg.startsWith("owner="))?.slice(6);
      const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
      return {
        data: {
          user: null,
          organization: {
            projectV2: {
              id: `PVT_${number}`,
              number,
              title: `${owner} ${number}`,
              url: `https://github.example/${number}`,
              fields: { pageInfo: { hasNextPage: false }, nodes: [
                { id: `STATUS_${number}`, name: "Status", dataType: "SINGLE_SELECT", options: [{ id: `READY_${number}`, name: "Ready" }] },
                { id: `PRIORITY_${number}`, name: "Priority", dataType: "SINGLE_SELECT", options: [] },
                { id: `SIZE_${number}`, name: "Size", dataType: "SINGLE_SELECT", options: [] },
              ] },
              items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            },
          },
        },
      };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const raw = collectPortfolio(config, "example", { gh, now: () => "fixed" });
  assert.equal(raw.projects[0].fields[0].id, "STATUS_10");
  assert.equal(raw.projects[0].fields[0].options[0].id, "READY_10");
  assert.equal(calls.filter((args) => args.includes("graphql") && args.some((arg) => arg.includes("projectV2"))).length, 2);
});

test("collector normalizes hierarchy, dependencies, and linked pull requests exposed by GitHub", () => {
  const singleConfig = { version: 1, portfolios: { single: { repositories: ["octo-org/service-alpha"] } } };
  const gh = (args) => {
    if (args[0] === "pr") return [];
    return { data: { repository: { issues: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        number: 12, title: "Child", url: "issue-url", state: "OPEN", updatedAt: "2026-01-01T00:00:00Z",
        labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "agent-ready" }] },
        assignees: { pageInfo: { hasNextPage: false }, nodes: [{ login: "octocat" }] },
        parent: { number: 1, title: "Outcome", url: "parent-url", state: "OPEN", repository: { nameWithOwner: "octo-org/service-alpha" } },
        subIssues: { totalCount: 0 },
        blockedBy: { pageInfo: { hasNextPage: false }, nodes: [{ number: 11, title: "Decision", url: "blocker-url", state: "OPEN", repository: { nameWithOwner: "octo-org/service-beta" } }] },
        closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [{ number: 30, title: "Implement child", url: "pr-url", state: "OPEN", repository: { nameWithOwner: "octo-org/service-alpha" } }] },
      }],
    } } } };
  };
  const raw = collectPortfolio(singleConfig, "single", { gh, now: () => "2026-01-02T00:00:00Z" });
  const item = normalizeSnapshot(singleConfig, "single", raw).items[0];
  assert.equal(item.parent.number, 1);
  assert.equal(item.blockers.items[0].repository, "octo-org/service-beta");
  assert.equal(item.linkedPullRequest.number, 30);
  assert.deepEqual(item.availability, { parent: "available", blockers: "available", linkedPullRequest: "available" });
});

test("collector classifies GraphQL permission, rate-limit, and partial-response failures", () => {
  const singleConfig = { version: 1, portfolios: { single: { repositories: ["octo-org/service-alpha"] } } };
  for (const [message, code] of [
    ["Resource not accessible due to missing scope", "GITHUB_PERMISSION"],
    ["API rate limit exceeded", "GITHUB_RATE_LIMIT"],
  ]) {
    assert.throws(
      () => collectPortfolio(singleConfig, "single", { gh: () => ({ errors: [{ message }], data: { repository: null } }) }),
      (error) => error.code === code,
    );
  }
  assert.throws(
    () => collectPortfolio(singleConfig, "single", { gh: () => ({ data: null }) }),
    (error) => error.code === "GITHUB_PARTIAL_RESPONSE",
  );
});

test("collector reports unavailable Project targets and partial field pages", () => {
  const emptyProjectGh = (args) => {
    if (args[0] === "pr") return [];
    if (args.some((arg) => arg.includes("issues(first:100"))) return { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    return { data: { user: null, organization: null } };
  };
  assert.throws(() => collectPortfolio(config, "example", { gh: emptyProjectGh }), (error) => error.code === "GITHUB_TARGET_UNRESOLVED");

  const partialGh = (args) => {
    if (args[0] === "pr") return [];
    if (args.some((arg) => arg.includes("issues(first:100"))) return { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    return { data: { user: { projectV2: {
      id: "PVT", number: 10, title: "Partial", url: "url",
      fields: { pageInfo: { hasNextPage: true }, nodes: [] },
      items: { pageInfo: { hasNextPage: false }, nodes: [] },
    } }, organization: null } };
  };
  assert.throws(() => collectPortfolio(config, "example", { gh: partialGh }), (error) => error.code === "GITHUB_PARTIAL_RESPONSE");

  const missingCursorGh = (args) => {
    if (args[0] === "pr") return [];
    if (args.some((arg) => arg.includes("issues(first:100"))) return { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } };
    return { data: { user: { projectV2: {
      id: "PVT", number: 10, title: "Partial", url: "url",
      fields: { pageInfo: { hasNextPage: false }, nodes: [] },
      items: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
    } }, organization: null } };
  };
  assert.throws(() => collectPortfolio(config, "example", { gh: missingCursorGh }), (error) => error.code === "GITHUB_PARTIAL_RESPONSE");
});
