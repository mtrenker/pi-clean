// Visual overlay utilities for element highlighting in headed browser mode.
// Provides cursor trail, action bar, element highlights, and action history.

import type { Page } from 'playwright';

// ────────────────────────────────────────────────────────────
// Browser-side CSS (injected into page via <style>)
// ────────────────────────────────────────────────────────────

const OVERLAY_CSS = /* css */ `
  :host {
    all: initial;
    position: fixed;
    top: 0; left: 0;
    width: 100vw; height: 100vh;
    pointer-events: none;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  /* ── Action bar (top) ── */
  .pi-action-bar {
    position: fixed;
    top: 0; left: 0; right: 0;
    padding: 8px 16px;
    background: rgba(20, 20, 30, 0.85);
    color: #e0e0e0;
    font-size: 13px;
    line-height: 1.4;
    text-align: center;
    backdrop-filter: blur(4px);
    transform: translateY(-100%);
    transition: transform 0.25s ease, opacity 0.25s ease;
    opacity: 0;
    z-index: 10;
  }
  .pi-action-bar.visible {
    transform: translateY(0);
    opacity: 1;
  }

  /* ── Element highlight ── */
  .pi-highlight {
    position: fixed;
    border: 2px solid #4a9eff;
    border-radius: 4px;
    pointer-events: none;
    box-sizing: border-box;
    animation: pi-pulse 0.8s ease-out forwards;
    z-index: 5;
  }
  .pi-highlight.type-click  { border-color: #4a9eff; }
  .pi-highlight.type-type   { border-color: #4aff7e; }
  .pi-highlight.type-select { border-color: #ffaa4a; }

  .pi-highlight-label {
    position: absolute;
    top: -22px; left: 0;
    padding: 2px 6px;
    font-size: 11px;
    border-radius: 3px;
    color: #fff;
    white-space: nowrap;
  }
  .type-click  .pi-highlight-label { background: #4a9eff; }
  .type-type   .pi-highlight-label { background: #4aff7e; color: #111; }
  .type-select .pi-highlight-label { background: #ffaa4a; color: #111; }

  @keyframes pi-pulse {
    0%   { opacity: 1; box-shadow: 0 0 0 0 rgba(74,158,255,0.4); }
    50%  { box-shadow: 0 0 8px 4px rgba(74,158,255,0.2); }
    100% { opacity: 0; box-shadow: 0 0 0 0 rgba(74,158,255,0); }
  }

  /* ── Cursor dot ── */
  .pi-cursor {
    position: fixed;
    width: 12px; height: 12px;
    margin-left: -6px; margin-top: -6px;
    border-radius: 50%;
    background: #ff5555;
    transition: left 0.3s cubic-bezier(.4,0,.2,1), top 0.3s cubic-bezier(.4,0,.2,1);
    z-index: 20;
    opacity: 0.9;
  }
  .pi-cursor.pulse {
    animation: pi-cursor-pulse 0.35s ease-out;
  }
  @keyframes pi-cursor-pulse {
    0%   { transform: scale(1); }
    50%  { transform: scale(1.8); opacity: 0.6; }
    100% { transform: scale(1); opacity: 0.9; }
  }

  /* ── History panel (bottom-right) ── */
  .pi-history {
    position: fixed;
    bottom: 12px; right: 12px;
    max-width: 280px;
    background: rgba(20, 20, 30, 0.85);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
    color: #ccc;
    backdrop-filter: blur(4px);
    transition: opacity 0.4s ease;
    opacity: 0;
    z-index: 10;
  }
  .pi-history.visible { opacity: 1; }
  .pi-history-item {
    padding: 3px 0;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    display: flex;
    gap: 6px;
  }
  .pi-history-item:last-child { border-bottom: none; }
  .pi-history-time {
    color: #888;
    flex-shrink: 0;
  }
`;

// ────────────────────────────────────────────────────────────
// Browser-side JS (injected via addInitScript)
// ────────────────────────────────────────────────────────────

const OVERLAY_JS = /* js */ `
(() => {
  if (window.__piOverlay) return; // idempotent guard

  // Create Shadow DOM host
  const host = document.createElement('div');
  host.id = '__pi-overlay-root';
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  // Inject styles
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(OVERLAY_CSS)};
  shadow.appendChild(style);

  // Action bar
  const actionBar = document.createElement('div');
  actionBar.className = 'pi-action-bar';
  shadow.appendChild(actionBar);

  // Cursor dot
  const cursor = document.createElement('div');
  cursor.className = 'pi-cursor';
  cursor.style.left = '-100px';
  cursor.style.top = '-100px';
  shadow.appendChild(cursor);

  // History panel
  const historyPanel = document.createElement('div');
  historyPanel.className = 'pi-history';
  shadow.appendChild(historyPanel);

  let historyHideTimer = null;
  const historyItems = [];

  const api = {
    showAction(text) {
      actionBar.textContent = text;
      actionBar.classList.add('visible');
      clearTimeout(api._actionTimer);
      api._actionTimer = setTimeout(() => actionBar.classList.remove('visible'), 3000);
    },
    _actionTimer: null,

    highlightElement(selector, action, label) {
      let el;
      try { el = document.querySelector(selector); } catch { return; }
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const hl = document.createElement('div');
      const actionType = (action || 'click').toLowerCase();
      hl.className = 'pi-highlight type-' + actionType;
      hl.style.left   = rect.left   + 'px';
      hl.style.top    = rect.top    + 'px';
      hl.style.width  = rect.width  + 'px';
      hl.style.height = rect.height + 'px';
      if (label) {
        const lbl = document.createElement('span');
        lbl.className = 'pi-highlight-label';
        lbl.textContent = label;
        hl.appendChild(lbl);
      }
      shadow.appendChild(hl);
      setTimeout(() => hl.remove(), 850);
    },

    moveCursorTo(x, y) {
      cursor.style.left = x + 'px';
      cursor.style.top  = y + 'px';
      cursor.classList.remove('pulse');
      // Force reflow to restart animation
      void cursor.offsetWidth;
      cursor.classList.add('pulse');
    },

    addToHistory(action) {
      const now = new Date();
      const ts = String(now.getHours()).padStart(2,'0') + ':'
              + String(now.getMinutes()).padStart(2,'0') + ':'
              + String(now.getSeconds()).padStart(2,'0');
      historyItems.push({ ts, action });
      if (historyItems.length > 5) historyItems.shift();

      historyPanel.innerHTML = '';
      for (const item of historyItems) {
        const row = document.createElement('div');
        row.className = 'pi-history-item';
        row.innerHTML = '<span class="pi-history-time">' + item.ts + '</span><span>' + item.action + '</span>';
        historyPanel.appendChild(row);
      }
      historyPanel.classList.add('visible');
      clearTimeout(historyHideTimer);
      historyHideTimer = setTimeout(() => historyPanel.classList.remove('visible'), 5000);
    }
  };

  window.__piOverlay = api;
})();
`;

// ────────────────────────────────────────────────────────────
// Node.js API — called from page.ts / index.ts
// ────────────────────────────────────────────────────────────

/** Set of pages that already have the overlay injected. */
const injectedPages = new WeakSet<Page>();

/**
 * Inject the visual overlay into a Playwright page.
 * No-op if already injected or if the browser is headless.
 */
export async function injectOverlay(page: Page): Promise<void> {
  // Skip if already injected
  if (injectedPages.has(page)) return;

  // Detect headless — browser().browserType() is not available pre-launch,
  // but we can check the user-agent or launch args.  The simplest reliable
  // method: evaluate a headless-detection heuristic.  However, the prompt
  // says "no-op in headless" — the caller should gate this, but we also
  // check navigator.webdriver as a proxy (set in headless Chromium).
  const browser = page.context().browser();
  if (!browser) return; // safety — detached context
  const isHeadless = browser.browserType().name() === 'chromium'
    ? await page.evaluate(() => navigator.webdriver).catch(() => true)
    : false;
  if (isHeadless) return;

  // Register the init-script so it re-runs on every navigation
  await page.addInitScript(OVERLAY_JS);
  // Also run it immediately for the current page
  await page.evaluate(OVERLAY_JS).catch(() => {
    // Page may not be ready yet — the init script will fire on next nav
  });

  injectedPages.add(page);
}

/**
 * Highlight a DOM element with a pulsing border and optional label.
 * @param action - action type: 'click' | 'type' | 'select' (determines colour)
 */
export async function highlightElement(
  page: Page,
  selector: string,
  action: string,
  label?: string,
): Promise<void> {
  await page.evaluate(
    ({ selector, action, label }) => {
      (window as any).__piOverlay?.highlightElement(selector, action, label);
    },
    { selector, action, label },
  ).catch(() => {});
}

/**
 * Show an action description in the top action bar.
 */
export async function showAction(page: Page, text: string): Promise<void> {
  await page.evaluate(
    (t: string) => { (window as any).__piOverlay?.showAction(t); },
    text,
  ).catch(() => {});
}

/**
 * Move the virtual cursor dot to (x, y) viewport coordinates.
 */
export async function moveCursorTo(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => { (window as any).__piOverlay?.moveCursorTo(x, y); },
    { x, y },
  ).catch(() => {});
}

/**
 * Append an action string to the history panel.
 */
export async function addToHistory(page: Page, action: string): Promise<void> {
  await page.evaluate(
    (a: string) => { (window as any).__piOverlay?.addToHistory(a); },
    action,
  ).catch(() => {});
}
