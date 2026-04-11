// Content extraction from web pages
// Transforms a web page into readable text plus an indexed list of interactive elements

import type { Page } from 'playwright';

/** Options for content extraction */
export interface ExtractOptions {
  /** Maximum characters for text content (default: 8000) */
  maxLength?: number;
  /** Maximum interactive elements to index (default: 100) */
  maxElements?: number;
}

/** Describes a single interactive element on the page */
export interface InteractiveElement {
  index: number;
  type: 'link' | 'button' | 'input' | 'textarea' | 'select' | 'checkbox' | 'radio';
  text: string;
  href?: string;
  selector: string;
}

/** Result of extracting page content */
export interface ExtractResult {
  title: string;
  url: string;
  textContent: string;
  interactiveElements: string[];
  truncated: boolean;
  elementMap: Map<number, string>;
}

/**
 * Extract readable content and interactive elements from a page.
 *
 * All DOM queries run inside `page.evaluate()` so they execute in the
 * browser context. The returned `elementMap` maps each element index to
 * a stable CSS selector that Playwright can use for click/type actions.
 */
export async function extractPageContent(
  page: Page,
  options?: ExtractOptions,
): Promise<ExtractResult> {
  const maxLength = options?.maxLength ?? 8000;
  const maxElements = options?.maxElements ?? 100;

  const title = await page.title();
  const url = page.url();

  // --- Text content extraction ---
  const rawText: string = await page.evaluate(() => {
    // Remove hidden elements before extracting text
    const clone = document.body.cloneNode(true) as HTMLElement;
    const hidden = clone.querySelectorAll(
      '[style*="display:none"], [style*="display: none"], ' +
      '[style*="visibility:hidden"], [style*="visibility: hidden"], ' +
      '[aria-hidden="true"]'
    );
    for (const el of hidden) {
      el.remove();
    }
    // Also remove elements that are hidden via computed style
    // (we can't access computedStyle on a clone, so we gather hidden
    //  selectors from the live DOM first)
    const liveHidden: string[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') {
        // Build a quick selector for removal in the clone
        if (el.id) {
          liveHidden.push(`#${CSS.escape(el.id)}`);
        }
      }
    }
    for (const sel of liveHidden) {
      try {
        const match = clone.querySelector(sel);
        if (match) match.remove();
      } catch { /* ignore invalid selectors */ }
    }
    return clone.innerText ?? '';
  });

  // Collapse whitespace
  let textContent = rawText
    .replace(/[ \t]+/g, ' ')             // multiple spaces/tabs → single space
    .replace(/\n{3,}/g, '\n\n')          // 3+ newlines → 2
    .trim();

  // Smart truncation
  let truncated = false;
  if (textContent.length > maxLength) {
    truncated = true;
    const tailLength = 500;
    const head = textContent.slice(0, maxLength - tailLength - 30);
    const tail = textContent.slice(-tailLength);
    textContent = head + '\n...[truncated]...\n' + tail;
  }

  // --- Interactive elements indexing ---
  const rawElements: Array<{
    type: InteractiveElement['type'];
    text: string;
    href?: string;
    selector: string;
  }> = await page.evaluate((max: number) => {
    /** Generate a stable CSS selector for an element */
    function stableSelector(el: Element): string {
      // Prefer data-testid
      const testId = el.getAttribute('data-testid');
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

      // Prefer id
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
        return `#${CSS.escape(el.id)}`;
      }

      // Prefer name attribute (for form elements)
      const name = el.getAttribute('name');
      if (name) {
        const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }

      // Fall back to nth-of-type path
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.documentElement) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter(
          (s) => s.tagName === current!.tagName,
        );
        if (siblings.length === 1) {
          parts.unshift(tag);
        } else {
          const idx = siblings.indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${idx})`);
        }
        current = parent;
      }
      return parts.join(' > ');
    }

    /** Check if an element is visible */
    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    type ElType = 'link' | 'button' | 'input' | 'textarea' | 'select' | 'checkbox' | 'radio';

    const selectors: Array<{ query: string; type: ElType }> = [
      { query: 'a[href]', type: 'link' },
      { query: 'button', type: 'button' },
      { query: 'input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="tel"], input[type="number"], input:not([type])', type: 'input' },
      { query: 'textarea', type: 'textarea' },
      { query: 'select', type: 'select' },
      { query: 'input[type="checkbox"]', type: 'checkbox' },
      { query: 'input[type="radio"]', type: 'radio' },
    ];

    const results: Array<{
      type: ElType;
      text: string;
      href?: string;
      selector: string;
    }> = [];

    const seen = new Set<Element>();

    for (const { query, type } of selectors) {
      if (results.length >= max) break;
      for (const el of document.querySelectorAll(query)) {
        if (results.length >= max) break;
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isVisible(el)) continue;

        const text = (
          (el as HTMLInputElement).value ||
          el.getAttribute('aria-label') ||
          el.textContent ||
          ''
        ).trim().slice(0, 100);

        const entry: typeof results[number] = {
          type,
          text,
          selector: stableSelector(el),
        };
        if (type === 'link') {
          entry.href = (el as HTMLAnchorElement).href;
        }
        results.push(entry);
      }
    }

    return results;
  }, maxElements);

  // Check if there might be more elements (for the note)
  const totalInteractive: number = await page.evaluate(() => {
    return document.querySelectorAll(
      'a[href], button, input, textarea, select'
    ).length;
  });

  // Format interactive elements list
  const interactiveElements: string[] = rawElements.map((el, i) => {
    let line = `[${i}] ${el.type} "${el.text}"`;
    if (el.href) line += ` → ${el.href}`;
    return line;
  });

  if (totalInteractive > maxElements) {
    interactiveElements.push(
      `\n... and ${totalInteractive - maxElements} more interactive elements not shown`,
    );
  }

  // Build element map
  const elementMap = new Map<number, string>();
  for (let i = 0; i < rawElements.length; i++) {
    elementMap.set(i, rawElements[i].selector);
  }

  // Note iframe presence
  const hasIframes: boolean = await page.evaluate(() => {
    return document.querySelectorAll('iframe').length > 0;
  });
  if (hasIframes) {
    interactiveElements.push('[note: page contains iframes — only main frame content extracted]');
  }

  return {
    title,
    url,
    textContent,
    interactiveElements,
    truncated,
    elementMap,
  };
}
