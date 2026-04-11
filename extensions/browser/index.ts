// Browser extension entry point — orchestrates browser automation tools
// Registers all browser tools, manages lazy lifecycle, integrates overlay and briefing gate

import { Type } from "@sinclair/typebox";
import type {
  ExtensionFactory,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
  launchBrowser,
  getBrowser,
  getCurrentPage,
  setCurrentPage,
  closeBrowser,
  type BrowserType,
  type LaunchOptions,
} from "./browser.js";
import {
  navigate,
  goBack,
  goForward,
  screenshot,
  evaluate,
  click,
  type as typeText,
  manageTabs,
  setViewport,
  type WaitUntilOption,
  type TabAction,
} from "./page.js";
import { extractPageContent } from "./extract.js";
import {
  injectOverlay,
  highlightElement,
  showAction,
} from "./overlay.js";
import {
  shouldShowBriefing,
  showBriefing,
  trustDomain,
  getSessionTrustedDomains,
  type BrowserMode,
} from "./briefing.js";

// ── Module-level state ─────────────────────────────────────────────

let currentElementMap: Map<number, string> = new Map();
let currentBrowserType: BrowserType = "chromium";
let headlessMode = true;
let browserMode: BrowserMode = "autonomous";
let currentDomain = "";

// ── Helpers ────────────────────────────────────────────────────────

/** Ensure the browser is launched, returning the active page. */
async function ensureBrowser() {
  const opts: LaunchOptions = {
    browserType: currentBrowserType,
    headless: headlessMode,
  };
  const context = await launchBrowser(opts);
  const page = await getCurrentPage();
  if (!page) throw new Error("Failed to get browser page");

  // Inject overlay in headed mode
  if (!headlessMode) {
    await injectOverlay(page);
  }

  return { context, page };
}

/** Update the element map from an extract result. */
function updateElementMap(elementMap: Map<number, string>) {
  currentElementMap = elementMap;
}

/** Format an extract result as tool output text. */
function formatExtractResult(result: {
  title: string;
  url: string;
  textContent: string;
  interactiveElements: string[];
  truncated: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`Title: ${result.title}`);
  lines.push(`URL: ${result.url}`);
  if (result.truncated) lines.push("[Content truncated]");
  lines.push("");
  lines.push(result.textContent);
  if (result.interactiveElements.length > 0) {
    lines.push("");
    lines.push("Interactive Elements:");
    lines.push(...result.interactiveElements);
  }
  return lines.join("\n");
}

/** Extract the domain from a URL. */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Determine if we're in autonomous mode (headless or subagent). */
function detectBrowserMode(ctx: ExtensionContext): BrowserMode {
  // In headless mode, always autonomous
  if (headlessMode) return "autonomous";
  // If no UI available, autonomous (subagent/RPC mode)
  if (!ctx.hasUI) return "autonomous";
  return "interactive";
}

/** Simple text result helper. */
function textResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
  };
}

// ── Extension factory ──────────────────────────────────────────────

const browserExtension: ExtensionFactory = (pi) => {
  // ── browser_navigate ───────────────────────────────────────────

  pi.registerTool({
    name: "browser_navigate",
    label: "Navigate",
    description:
      "Navigate to a URL in the browser. Returns page content and interactive elements.",
    promptSnippet: "browser_navigate — open a URL in the browser",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      waitUntil: Type.Optional(
        Type.Union(
          [
            Type.Literal("load"),
            Type.Literal("domcontentloaded"),
            Type.Literal("networkidle"),
          ],
          { description: "When to consider navigation done (default: domcontentloaded)" },
        ),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      browserMode = detectBrowserMode(ctx);
      const { page } = await ensureBrowser();

      const targetDomain = getDomain(params.url);

      // Briefing gate for interactive mode
      if (browserMode === "interactive" && targetDomain && targetDomain !== currentDomain) {
        const needsBriefing = await shouldShowBriefing(browserMode, targetDomain);
        if (needsBriefing) {
          const result = await showBriefing(page as any, {
            mission: `Navigate to ${params.url}`,
            url: params.url,
            agent: "browser-extension",
          });
          if (result === "rejected") {
            return textResult(
              `Navigation to ${params.url} was rejected by user in briefing gate.`,
            );
          }
        }
      }

      if (!headlessMode) {
        await showAction(page, `Navigating to ${params.url}`);
      }

      const extracted = await navigate(
        page,
        params.url,
        (params.waitUntil as WaitUntilOption) ?? "domcontentloaded",
      );

      updateElementMap(extracted.elementMap);
      currentDomain = getDomain(extracted.url);

      // Re-inject overlay after navigation in headed mode
      if (!headlessMode) {
        await injectOverlay(page);
      }

      return textResult(formatExtractResult(extracted));
    },
  });

  // ── browser_click ──────────────────────────────────────────────

  pi.registerTool({
    name: "browser_click",
    label: "Click",
    description:
      "Click an element on the page by index (from interactive elements list) or CSS selector.",
    parameters: Type.Object({
      index: Type.Optional(
        Type.Number({ description: "Element index from interactive elements list" }),
      ),
      selector: Type.Optional(
        Type.String({ description: "CSS selector of element to click" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { page } = await ensureBrowser();

      const target =
        params.index !== undefined ? params.index : params.selector;
      if (target === undefined) {
        return textResult("Error: Provide either 'index' or 'selector'");
      }

      // Overlay highlight before click
      if (!headlessMode) {
        const selector =
          typeof target === "number"
            ? currentElementMap.get(target)
            : target;
        if (selector) {
          await highlightElement(page, selector, "click", `Click [${target}]`);
          await showAction(page, `Clicking element [${target}]`);
        }
      }

      const extracted = await click(page, target, currentElementMap);
      updateElementMap(extracted.elementMap);
      currentDomain = getDomain(extracted.url);

      if (!headlessMode) {
        await injectOverlay(page);
      }

      return textResult(formatExtractResult(extracted));
    },
  });

  // ── browser_type ───────────────────────────────────────────────

  pi.registerTool({
    name: "browser_type",
    label: "Type",
    description:
      "Type text into an input element by index or CSS selector.",
    parameters: Type.Object({
      index: Type.Optional(
        Type.Number({ description: "Element index from interactive elements list" }),
      ),
      selector: Type.Optional(
        Type.String({ description: "CSS selector of element" }),
      ),
      text: Type.String({ description: "Text to type" }),
      pressEnter: Type.Optional(
        Type.Boolean({ description: "Press Enter after typing (default: false)" }),
      ),
      clear: Type.Optional(
        Type.Boolean({ description: "Clear existing content before typing (default: false)" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { page } = await ensureBrowser();

      const target =
        params.index !== undefined ? params.index : params.selector;
      if (target === undefined) {
        return textResult("Error: Provide either 'index' or 'selector'");
      }

      if (!headlessMode) {
        const selector =
          typeof target === "number"
            ? currentElementMap.get(target)
            : target;
        if (selector) {
          await highlightElement(page, selector, "type", `Type into [${target}]`);
          await showAction(page, `Typing into element [${target}]`);
        }
      }

      const extracted = await typeText(
        page,
        target,
        params.text,
        {
          pressEnter: params.pressEnter,
          clear: params.clear,
        },
        currentElementMap,
      );
      updateElementMap(extracted.elementMap);
      currentDomain = getDomain(extracted.url);

      return textResult(formatExtractResult(extracted));
    },
  });

  // ── browser_screenshot ─────────────────────────────────────────

  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot",
    description:
      "Take a screenshot of the current page. Returns the image.",
    parameters: Type.Object({
      fullPage: Type.Optional(
        Type.Boolean({ description: "Capture entire scrollable page (default: false)" }),
      ),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to screenshot a specific element" }),
      ),
    }),
    async execute(toolCallId, params) {
      const { page } = await ensureBrowser();

      const buffer = await screenshot(page, {
        fullPage: params.fullPage,
        selector: params.selector,
      });

      return {
        content: [
          {
            type: "image" as const,
            mimeType: "image/png",
            data: buffer.toString("base64"),
          },
        ],
        details: undefined,
      };
    },
  });

  // ── browser_evaluate ───────────────────────────────────────────

  pi.registerTool({
    name: "browser_evaluate",
    label: "Evaluate JS",
    description:
      "Evaluate a JavaScript expression in the browser page context.",
    parameters: Type.Object({
      expression: Type.String({ description: "JavaScript expression to evaluate" }),
    }),
    async execute(toolCallId, params) {
      const { page } = await ensureBrowser();

      if (!headlessMode) {
        await showAction(page, "Evaluating JavaScript");
      }

      const result = await evaluate(page, params.expression);
      return textResult(result);
    },
  });

  // ── browser_back ───────────────────────────────────────────────

  pi.registerTool({
    name: "browser_back",
    label: "Back",
    description: "Go back in browser history.",
    parameters: Type.Object({}),
    async execute() {
      const { page } = await ensureBrowser();

      if (!headlessMode) {
        await showAction(page, "Going back");
      }

      const extracted = await goBack(page);
      updateElementMap(extracted.elementMap);
      currentDomain = getDomain(extracted.url);

      if (!headlessMode) {
        await injectOverlay(page);
      }

      return textResult(formatExtractResult(extracted));
    },
  });

  // ── browser_forward ────────────────────────────────────────────

  pi.registerTool({
    name: "browser_forward",
    label: "Forward",
    description: "Go forward in browser history.",
    parameters: Type.Object({}),
    async execute() {
      const { page } = await ensureBrowser();

      if (!headlessMode) {
        await showAction(page, "Going forward");
      }

      const extracted = await goForward(page);
      updateElementMap(extracted.elementMap);
      currentDomain = getDomain(extracted.url);

      if (!headlessMode) {
        await injectOverlay(page);
      }

      return textResult(formatExtractResult(extracted));
    },
  });

  // ── browser_tabs ───────────────────────────────────────────────

  pi.registerTool({
    name: "browser_tabs",
    label: "Tabs",
    description: "Manage browser tabs: list, switch, create new, or close.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("switch"),
          Type.Literal("new"),
          Type.Literal("close"),
        ],
        { description: "Tab action to perform" },
      ),
      tabIndex: Type.Optional(
        Type.Number({ description: "Tab index for switch/close actions" }),
      ),
    }),
    async execute(toolCallId, params) {
      const { context } = await ensureBrowser();

      const result = await manageTabs(
        context,
        params.action as TabAction,
        params.tabIndex,
      );

      const lines: string[] = [result.message, ""];
      for (const tab of result.tabs) {
        const marker = tab.index === result.activeTabIndex ? "→ " : "  ";
        lines.push(`${marker}[${tab.index}] ${tab.title} — ${tab.url}`);
      }

      return textResult(lines.join("\n"));
    },
  });

  // ── browser_close ──────────────────────────────────────────────

  pi.registerTool({
    name: "browser_close",
    label: "Close Browser",
    description: "Close the browser. Profile data is preserved for next launch.",
    parameters: Type.Object({}),
    async execute() {
      await closeBrowser();
      currentElementMap = new Map();
      currentDomain = "";
      return textResult("Browser closed. Profile data preserved.");
    },
  });

  // ── browser_set_viewport ───────────────────────────────────────

  pi.registerTool({
    name: "browser_set_viewport",
    label: "Set Viewport",
    description: "Set the browser viewport size.",
    parameters: Type.Object({
      width: Type.Number({ description: "Viewport width in pixels" }),
      height: Type.Number({ description: "Viewport height in pixels" }),
    }),
    async execute(toolCallId, params) {
      const { page } = await ensureBrowser();

      const result = await setViewport(page, params.width, params.height);
      return textResult(result);
    },
  });

  // ── /browser command ───────────────────────────────────────────

  pi.registerCommand("browser", {
    description: "Browser management: status, close, switch <chromium|firefox|webkit>",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] || "status";

      switch (subcommand) {
        case "status": {
          const browser = getBrowser();
          if (!browser) {
            ctx.ui.notify("Browser: not running");
          } else {
            const page = await getCurrentPage();
            const url = page ? page.url() : "(no page)";
            const pages = browser.pages();
            ctx.ui.notify(
              `Browser: ${currentBrowserType} (${headlessMode ? "headless" : "headed"})\n` +
              `Tabs: ${pages.length}\n` +
              `Current URL: ${url}\n` +
              `Elements tracked: ${currentElementMap.size}\n` +
              `Trusted domains: ${getSessionTrustedDomains().join(", ") || "none"}`,
            );
          }
          break;
        }

        case "close": {
          await closeBrowser();
          currentElementMap = new Map();
          currentDomain = "";
          ctx.ui.notify("Browser closed.");
          break;
        }

        case "switch": {
          const type = parts[1] as BrowserType | undefined;
          if (!type || !["chromium", "firefox", "webkit"].includes(type)) {
            ctx.ui.notify("Usage: /browser switch <chromium|firefox|webkit>");
            break;
          }
          // Close existing browser if different type
          if (getBrowser() && type !== currentBrowserType) {
            await closeBrowser();
            currentElementMap = new Map();
            currentDomain = "";
          }
          currentBrowserType = type;
          ctx.ui.notify(`Browser type set to ${type}. Will use on next launch.`);
          break;
        }

        default:
          ctx.ui.notify(
            "Unknown subcommand. Usage: /browser <status|close|switch <type>>",
          );
      }
    },
  });

  // ── Lifecycle: clean up on session shutdown ────────────────────

  pi.on("session_shutdown", async () => {
    await closeBrowser();
  });
};

export default browserExtension;
