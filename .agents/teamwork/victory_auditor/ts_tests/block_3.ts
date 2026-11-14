/**
 * Universal Deep Query Selector across Light DOM, Open Shadow DOM,
 * Closed Shadow DOM, and Accessible Child Iframes.
 */
export function deepQuerySelectorAllAcrossRealms(
  selector: string,
  rootNode: Document | Element | ShadowRoot = document,
  depth = 0,
  maxDepth = 25
): Element[] {
  if (depth > maxDepth) return [];
  const results: Element[] = [];
  const registry = (window as any)[Symbol.for('__TNI_CLOSED_SHADOW_REGISTRY__')] as
    | WeakMap<Element, ShadowRoot>
    | undefined;

  // 1. Query Current Root Light Tree
  try {
    const matches = rootNode.querySelectorAll(selector);
    results.push(...Array.from(matches));
  } catch {
    // Selector syntax error or unsupported pseudoclass
  }

  // 2. Discover and Penetrate All Shadow Roots (Open and Closed)
  const allElements = rootNode.querySelectorAll('*');
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];

    // Check Open Shadow Root
    if (el.shadowRoot) {
      results.push(...deepQuerySelectorAllAcrossRealms(selector, el.shadowRoot, depth + 1, maxDepth));
    }
    // Check Closed Shadow Root via Realm Registry
    else if (registry && registry.has(el)) {
      const closedRoot = registry.get(el);
      if (closedRoot) {
        results.push(...deepQuerySelectorAllAcrossRealms(selector, closedRoot, depth + 1, maxDepth));
      }
    }

    // 3. Discover and Penetrate Accessible Child Iframes
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try {
        const iframe = el as HTMLIFrameElement;
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          results.push(...deepQuerySelectorAllAcrossRealms(selector, iframeDoc, depth + 1, maxDepth));
        }
      } catch {
        // Cross-origin iframe boundaries are resolved via separate target sessions in CDP
      }
    }
  }

  return results;
}