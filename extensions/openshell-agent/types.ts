export type AdvisorMode = "manual" | "auto";
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
  };
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
  repository?: RepositoryRequest;
  browserProfile?: string;
  browser?: OpenShellProfile["browser"];
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

export interface OpenShellAgentDetails extends WorkerResult {
  sandboxId: string;
  sandboxName: string;
  workspaceId: string;
  jobId: string;
  reused: boolean;
  errorCode?: string;
  error?: string;
}
