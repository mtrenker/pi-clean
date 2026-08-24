export type AdvisorMode = "manual" | "auto";
export type BrowserMode = "safe" | "professional-socials";
export type ReuseStrategy = "ephemeral" | "trust-domain" | "repository" | "browser-profile";
export type InferenceApi = "openai-responses" | "openai-completions" | "anthropic-messages" | "openai-codex-responses";

export interface OpenShellProfile {
  name: string;
  description: string;
  image: string;
  imageContract?: string;
  cpu?: string;
  memory?: string;
  reuse: ReuseStrategy;
  basePolicy: string;
  advisorMode: AdvisorMode;
  providers: string[];
  requiredProviderTypes?: string[];
  inferenceApi?: InferenceApi;
  codexSubscription?: {
    provider: string;
    model: string;
  };
  workerTools: string[];
  filesystem: {
    readOnly: string[];
    readWrite: string[];
  };
  process: {
    runAsUser: string;
    runAsGroup: string;
  };
  repository?: {
    required: boolean;
    defaultBaseBranch?: string;
  };
  browser?: {
    persistent: true;
    controllerPort: number;
    noVncPort: number;
    image: string;
    imageContract: string;
    basePolicy: string;
    /**
     * `safe` keeps the unchanged authenticated-browser behavior where every
     * consequential action is blocked for manual takeover. `professional-socials`
     * enables task-authorized autonomous maintenance behind a host mandate.
     */
    mode?: BrowserMode;
  };
}

export interface ProfessionalSocialsRequest {
  /** Rulebook site ids, for example linkedin or freelancermap. */
  sites: string[];
  /** Requested action classes beyond read, such as edit-profile or publish-post. */
  allow: string[];
  budget?: Partial<{ actions: number; edits: number; submits: number; publishes: number; uploads: number }>;
  ttlMinutes?: number;
}

export interface RepositoryRequest {
  url: string;
  baseBranch?: string;
}

export interface OpenShellJobInput {
  task: string;
  profile: string;
  trustDomain: string;
  repository?: RepositoryRequest;
  browserProfile?: string;
  professionalSocials?: ProfessionalSocialsRequest;
}

export interface ProfileConfigFile {
  profiles?: Record<string, Partial<OpenShellProfile> & { extends?: string }>;
}

export interface StaticIdentity {
  logicalKey: string;
  workspaceId: string;
  staticFingerprint: string;
  sandboxName: string;
  repositoryKey?: string;
}

/**
 * Browser workspace identity is deliberately separate from worker profile
 * identity: `authenticated-browser` and `professional-socials` share one
 * logged-in browser workspace per `trustDomain + browserProfile`, while each
 * worker profile keeps its own sandbox.
 */
export interface BrowserWorkspaceRecord {
  browserWorkspaceKey: string;
  trustDomain: string;
  browserProfile: string;
  sandboxName: string;
  sandboxId: string;
  staticFingerprint: string;
  /** Browser network policy in effect; mode switches are dynamic updates. */
  dynamicFingerprint?: string;
  controlSecret: string;
  adoptedFrom?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecord {
  logicalKey: string;
  workspaceId: string;
  profile: string;
  trustDomain: string;
  sandboxName: string;
  sandboxId: string;
  staticFingerprint: string;
  dynamicFingerprint: string;
  providers: string[];
  inference?: { provider: string; model: string; mode: "gateway" | "codex-subscription" };
  repository?: RepositoryRequest;
  browserProfile?: string;
  browser?: OpenShellProfile["browser"];
  browserWorkspaceKey?: string;
  /** Two legacy workspaces claimed one browser identity; adoption stopped. */
  browserAdoptionConflict?: boolean;
  /** Legacy v1 fields, retained only so migration can adopt or report them. */
  browserSandboxName?: string;
  browserSandboxId?: string;
  browserControlSecret?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreflightReport {
  cliVersion: string;
  gatewayVersion: string;
  inferenceProvider: string;
  inferenceModel: string;
  inferenceApi: InferenceApi;
}

export interface PolicyProposal {
  id: string;
  status: "pending" | "approved" | "rejected";
  host?: string;
  port?: number;
  binary?: string;
  method?: string;
  path?: string;
  proverFindings: string[];
  rationale?: string;
}

export interface WorkerResult {
  status: "complete" | "failed" | "cancelled";
  answer: string;
  branch?: string;
  commit?: string;
  artifacts?: string[];
}

export interface ProfessionalSocialsSummary {
  mandateId: string;
  sites: string[];
  actionClasses: string[];
  submits: number;
  publishes: number;
  edits: number;
  denials: number;
  revocation?: string;
  auditPath: string;
}

export interface OpenShellAgentDetails extends WorkerResult {
  sandboxId: string;
  sandboxName: string;
  workspaceId: string;
  jobId: string;
  reused: boolean;
  errorCode?: string;
  error?: string;
  /** Trusted host-authored review report; never worker-authored text. */
  report?: string;
  professionalSocials?: ProfessionalSocialsSummary;
}
