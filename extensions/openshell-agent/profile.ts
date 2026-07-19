import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import type { OpenShellProfile, ProfileConfigFile } from "./types.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILESYSTEM = {
  readOnly: ["/usr", "/lib", "/proc", "/dev/urandom", "/app", "/etc", "/var/log"],
  readWrite: ["/sandbox", "/tmp", "/dev/null"],
};
const DEFAULT_PROCESS = { runAsUser: "sandbox", runAsGroup: "sandbox" };
const PINNED_PI_IMAGE = "ghcr.io/nvidia/openshell-community/sandboxes/pi:a2afd1b";
const PINNED_PI_CONTRACT = "OpenShell Community Pi image from commit a2afd1ba5d0655ed531d7cd0bd7e1b93cb788a61, tested with OpenShell v0.0.86";

export const BUILTIN_PROFILES: Readonly<Record<string, OpenShellProfile>> = Object.freeze({
  "web-research": {
    name: "web-research",
    description: "Provider-free, deny-first research with safe Policy Advisor auto-approval",
    image: PINNED_PI_IMAGE,
    imageContract: PINNED_PI_CONTRACT,
    cpu: "1",
    memory: "2G",
    reuse: "trust-domain",
    basePolicy: join(extensionDir, "profiles", "web-research.policy.yaml"),
    advisorMode: "auto",
    providers: [],
    workerTools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    filesystem: DEFAULT_FILESYSTEM,
    process: DEFAULT_PROCESS,
  },
  development: {
    name: "development",
    description: "Persistent sandbox-side Git checkout with explicit GitHub provider attachment",
    image: PINNED_PI_IMAGE,
    imageContract: PINNED_PI_CONTRACT,
    cpu: "2",
    memory: "4G",
    reuse: "repository",
    basePolicy: join(extensionDir, "profiles", "development.policy.yaml"),
    advisorMode: "manual",
    providers: ["github"],
    requiredProviderTypes: ["github"],
    workerTools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    filesystem: DEFAULT_FILESYSTEM,
    process: DEFAULT_PROCESS,
    repository: { required: true, defaultBaseBranch: "main" },
  },
  "authenticated-browser": {
    name: "authenticated-browser",
    description: "Persistent isolated browser profile with local noVNC manual takeover",
    image: join(extensionDir, "image"),
    imageContract: "repository-owned OpenShell pi browser derivative",
    cpu: "2",
    memory: "4G",
    reuse: "browser-profile",
    basePolicy: join(extensionDir, "profiles", "authenticated-browser.policy.yaml"),
    advisorMode: "manual",
    providers: [],
    workerTools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    filesystem: {
      ...DEFAULT_FILESYSTEM,
      readWrite: [...DEFAULT_FILESYSTEM.readWrite, "/var/lib/openshell-browser"],
    },
    process: DEFAULT_PROCESS,
    browser: { persistent: true, controllerPort: 3010, noVncPort: 6080 },
  },
});

export interface LoadProfilesOptions {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
}

export async function loadProfiles(options: LoadProfilesOptions): Promise<Record<string, OpenShellProfile>> {
  const profiles: Record<string, OpenShellProfile> = structuredClone(BUILTIN_PROFILES);
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, "openshell-agent.json");
  const userPath = join(options.agentDir ?? getAgentDir(), "openshell-agent.json");

  if (options.projectTrusted) await applyConfig(profiles, projectPath);
  await applyConfig(profiles, userPath);
  return profiles;
}

async function applyConfig(profiles: Record<string, OpenShellProfile>, path: string): Promise<void> {
  let parsed: ProfileConfigFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as ProfileConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Could not read OpenShell profile config ${path}: ${errorMessage(error)}`);
  }

  assertNoCredentialMaterial(parsed, path);
  if (!parsed.profiles || typeof parsed.profiles !== "object") return;

  for (const [name, overlay] of Object.entries(parsed.profiles)) {
    validateName(name, "profile");
    if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
      throw new Error(`Profile ${name} in ${path} must be an object`);
    }
    const baseName = overlay.extends ?? (profiles[name] ? name : undefined);
    if (!baseName || !profiles[baseName]) {
      throw new Error(`Profile ${name} in ${path} must extend an existing profile`);
    }
    const { extends: _extends, ...values } = overlay;
    const base = profiles[baseName];
    const merged = {
      ...base,
      ...values,
      name,
      providers: values.providers ? [...values.providers] : [...base.providers],
      requiredProviderTypes: values.requiredProviderTypes ? [...values.requiredProviderTypes] : base.requiredProviderTypes ? [...base.requiredProviderTypes] : undefined,
      workerTools: values.workerTools ? [...values.workerTools] : [...base.workerTools],
      filesystem: values.filesystem
        ? {
            readOnly: values.filesystem.readOnly ? [...values.filesystem.readOnly] : [...base.filesystem.readOnly],
            readWrite: values.filesystem.readWrite ? [...values.filesystem.readWrite] : [...base.filesystem.readWrite],
          }
        : structuredClone(base.filesystem),
      process: { ...base.process, ...values.process },
      repository: values.repository ? { ...base.repository, ...values.repository } : base.repository,
      browser: values.browser ? { ...base.browser, ...values.browser } as OpenShellProfile["browser"] : base.browser,
    } satisfies OpenShellProfile;
    merged.basePolicy = resolveFrom(path, merged.basePolicy);
    if (merged.image.startsWith(".") || merged.image.startsWith("/")) merged.image = resolveFrom(path, merged.image);
    validateProfile(merged, path);
    profiles[name] = merged;
  }
}

function resolveFrom(configPath: string, value: string): string {
  return value.startsWith(".") ? resolve(dirname(configPath), value) : value;
}

export function validateProfile(profile: OpenShellProfile, source = "profile config"): void {
  validateName(profile.name, "profile");
  if (!profile.description || !profile.image || !profile.basePolicy) throw new Error(`${profile.name} in ${source} is incomplete`);
  if (!(["ephemeral", "trust-domain", "repository", "browser-profile"] as const).includes(profile.reuse)) {
    throw new Error(`${profile.name} in ${source} has an invalid reuse strategy`);
  }
  if (!(["manual", "auto"] as const).includes(profile.advisorMode)) throw new Error(`${profile.name} in ${source} has an invalid advisor mode`);
  for (const provider of profile.providers) validateName(provider, "provider");
  for (const providerType of profile.requiredProviderTypes ?? []) validateName(providerType, "provider type");
  if (new Set(profile.providers).size !== profile.providers.length) throw new Error(`${profile.name} repeats a provider name`);
  if (profile.reuse === "repository" && !profile.repository) throw new Error(`${profile.name} requires repository settings`);
  if (profile.reuse === "browser-profile" && !profile.browser) throw new Error(`${profile.name} requires browser settings`);
}

export function validateTrustDomain(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(normalized)) {
    throw new Error("trustDomain must be 1-80 characters using letters, digits, dot, underscore, or dash");
  }
  return normalized;
}

function validateName(value: string, kind: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new Error(`Invalid ${kind} name: ${value}`);
}

const SECRET_KEY = /(credential|secret|token|password|api.?key|cookie|session.?storage|private.?key)/i;

export function assertNoCredentialMaterial(value: unknown, source: string, path: string[] = []): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const next = [...path, key];
    if (SECRET_KEY.test(key)) {
      throw new Error(`${source} may contain provider names, never credential material (${next.join(".")})`);
    }
    assertNoCredentialMaterial(nested, source, next);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
