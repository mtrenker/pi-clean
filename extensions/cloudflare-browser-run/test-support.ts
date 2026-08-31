/**
 * Cloudflare Browser Run - test doubles
 *
 * Not a test file: the `*.test.ts` glob skips it. It provides the minimum of
 * Pi's extension surface the tests need, so a test can load the real factory and
 * drive real handlers without a Pi runtime.
 *
 * Every fixture credential here is synthetic. Nothing in this repository holds a
 * real account id or token.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FIXTURE_ACCOUNT_ID = "fixtureaccount0000000000000000ab";
export const FIXTURE_TOKEN = "fixture-token-0000000000000000000000000000";

export interface RecordedExec {
  command: string;
  args: string[];
}

export interface FakeTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void,
    ctx?: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;
}

export interface FakeCommand {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => unknown;
}

export interface FakeUiRecord {
  notifications: Array<{ text: string; level: string }>;
  status: Array<string | undefined>;
}

export interface FakePi {
  api: ExtensionAPI;
  tools: Map<string, FakeTool>;
  commands: Map<string, FakeCommand>;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  execCalls: RecordedExec[];
  execImpl: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
  activeTools: string[];
  emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<void>;
}

export function createFakePi(): FakePi {
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, FakeCommand>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const execCalls: RecordedExec[] = [];

  const fake: FakePi = {
    tools,
    commands,
    handlers,
    execCalls,
    activeTools: ["read", "bash"],
    execImpl: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    async emit(event, payload, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    api: {
      on(event: string, handler: (payload: unknown, ctx: ExtensionContext) => unknown) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerTool(definition: FakeTool) {
        tools.set(definition.name, definition);
      },
      registerCommand(name: string, options: FakeCommand) {
        commands.set(name, options);
      },
      exec(command: string, args: string[]) {
        execCalls.push({ command, args });
        return fake.execImpl(command, args);
      },
      getActiveTools() {
        return [...fake.activeTools];
      },
      setActiveTools(names: string[]) {
        fake.activeTools = [...names];
      },
    } as unknown as ExtensionAPI,
  };
  return fake;
}

export interface FakeContext {
  ctx: ExtensionContext;
  ui: FakeUiRecord;
}

export interface FakeBranchEntry {
  type: "message";
  message: { role: string; toolName?: string; details?: unknown };
}

/** Build the branch entry a completed tool call leaves behind. */
export function toolResultEntry(toolName: string, details: unknown): FakeBranchEntry {
  return { type: "message", message: { role: "toolResult", toolName, details } };
}

export function createFakeContext(
  overrides: Partial<{ hasUI: boolean; cwd: string; branch: FakeBranchEntry[]; confirm: boolean }> = {},
): FakeContext {
  const ui: FakeUiRecord = { notifications: [], status: [] };
  const ctx = {
    cwd: overrides.cwd ?? process.cwd(),
    sessionManager: { getBranch: () => overrides.branch ?? [] },
    mode: "tui",
    hasUI: overrides.hasUI ?? true,
    isProjectTrusted: () => true,
    ui: {
      theme: { fg: (_name: string, text: string) => text, bold: (text: string) => text },
      notify: (text: string, level = "info") => ui.notifications.push({ text, level }),
      setStatus: (_key: string, value?: string) => ui.status.push(value),
      setWidget: () => undefined,
      confirm: async () => overrides.confirm ?? true,
      input: async () => undefined,
      select: async () => undefined,
    },
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

/** A fetch double that answers from a queue of scripted responses. */
export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  bodyText?: string;
  headers?: Record<string, string>;
}

export interface ScriptedFetch {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; init: RequestInit }>;
}

export function scriptedFetch(responses: ScriptedResponse[]): ScriptedFetch {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      const spec = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      const status = spec.status ?? 200;
      const text =
        spec.bodyText ?? JSON.stringify(spec.body ?? { success: true, result: "ok" });
      return new Response(text, { status, headers: spec.headers ?? {} });
    },
  };
}

/** Collect every string leaf of a structure, for secret-containment assertions. */
export function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, into);
  }
  return into;
}

// ---------------------------------------------------------------------------
// Browser doubles
//
// Structural stand-ins for the parts of Playwright session.ts uses. They record
// every call so tests can assert ordering, and they can be told to hang, throw,
// or return oversized buffers.
// ---------------------------------------------------------------------------

import type { BrowserLike, ContextLike, LocatorLike, PageLike } from "./session.ts";

export interface FakeLocatorBehavior {
  attributes?: Record<string, string | null>;
  onClick?: () => Promise<void> | void;
  screenshotBytes?: number;
  missing?: boolean;
}

export interface FakePageOptions {
  url?: string;
  title?: string;
  snapshot?: string;
  locators?: Record<string, FakeLocatorBehavior>;
  screenshotBytes?: number | number[];
  log?: string[];
}

export function createFakePage(options: FakePageOptions = {}): PageLike & { setUrl(url: string): void } {
  let url = options.url ?? "https://example.com/";
  const log = options.log ?? [];
  const screenshotSizes = Array.isArray(options.screenshotBytes)
    ? [...options.screenshotBytes]
    : undefined;
  let screenshotCall = 0;

  const nextScreenshot = (): Buffer => {
    const size = screenshotSizes
      ? (screenshotSizes[Math.min(screenshotCall, screenshotSizes.length - 1)] as number)
      : ((options.screenshotBytes as number | undefined) ?? 1_000);
    screenshotCall += 1;
    return Buffer.alloc(size, 7);
  };

  const locator = (selector: string): LocatorLike => {
    const ref = selector.replace("aria-ref=", "");
    const behavior = options.locators?.[ref];
    const guard = async (): Promise<void> => {
      if (!behavior || behavior.missing) {
        throw new Error(`No element matching aria-ref=${ref}`);
      }
    };
    return {
      async click() {
        await guard();
        log.push(`click:${ref}`);
        await behavior?.onClick?.();
      },
      async fill(value: string) {
        await guard();
        log.push(`fill:${ref}:${value}`);
      },
      async selectOption(values: string[]) {
        await guard();
        log.push(`select:${ref}:${values.join(",")}`);
        return values;
      },
      async press(key: string) {
        await guard();
        log.push(`press:${ref}:${key}`);
      },
      async getAttribute(name: string) {
        await guard();
        return behavior?.attributes?.[name] ?? null;
      },
      async screenshot() {
        await guard();
        return Buffer.alloc(behavior?.screenshotBytes ?? 500, 3);
      },
      async count() {
        return behavior && !behavior.missing ? 1 : 0;
      },
    };
  };

  return {
    setUrl(next: string) {
      url = next;
    },
    url: () => url,
    title: async () => options.title ?? "Example",
    async goto(next: string) {
      log.push(`goto:${next}`);
      url = next;
      return null;
    },
    async goBack() {
      log.push("back");
      return null;
    },
    async goForward() {
      log.push("forward");
      return null;
    },
    async reload() {
      log.push("reload");
      return null;
    },
    async ariaSnapshot() {
      return options.snapshot ?? '- button "Search" [ref=e1]\n- link "Docs" [ref=e2]';
    },
    locator,
    keyboard: {
      async press(key: string) {
        log.push(`key:${key}`);
      },
    },
    async screenshot() {
      return nextScreenshot();
    },
    async setViewportSize() {
      return undefined;
    },
    async close() {
      log.push("page.close");
    },
    isClosed: () => false,
  };
}

export interface FakeBrowserOptions {
  page?: PageLike;
  pageFactory?: () => PageLike;
  storageState?: unknown;
  log?: string[];
  connectError?: Error;
}

export function createFakeBrowser(options: FakeBrowserOptions = {}): {
  browser: BrowserLike;
  context: ContextLike;
  log: string[];
} {
  const log = options.log ?? [];
  const pages: PageLike[] = [];
  const context: ContextLike = {
    async newPage() {
      const page = options.pageFactory?.() ?? options.page ?? createFakePage({ log });
      pages.push(page);
      return page;
    },
    pages: () => [...pages],
    async storageState() {
      return options.storageState ?? { cookies: [], origins: [] };
    },
    async close() {
      log.push("context.close");
    },
  };
  const browser: BrowserLike = {
    async newContext() {
      log.push("newContext");
      return context;
    },
    contexts: () => [context],
    async close() {
      log.push("browser.close");
    },
    isConnected: () => true,
  };
  return { browser, context, log };
}
