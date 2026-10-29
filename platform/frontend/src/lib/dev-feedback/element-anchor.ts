/**
 * Anchoring for feedback pins. A pin is tied to the page's structure, never
 * to its data: the route keeps its `[param]` placeholders, and the selector
 * uses test ids and element positions, not text or record ids. Two people
 * looking at different records of the same page see the same pins; the
 * screenshot in Slack carries the data.
 */

/** `/chat/8f3a…` with `{ conversationId: "8f3a…" }` → `/chat/[conversationId]`. */
export function toRoutePattern(params: {
  pathname: string;
  routeParams: Record<string, string | string[] | undefined>;
}): string {
  const segments = params.pathname.split("/");
  for (const [key, value] of Object.entries(params.routeParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const start = findSequence(segments, value);
      if (start >= 0) segments.splice(start, value.length, `[...${key}]`);
      continue;
    }
    const index = segments.findIndex(
      (segment) => safeDecode(segment) === value,
    );
    if (index >= 0) segments[index] = `[${key}]`;
  }
  return segments.join("/") || "/";
}

/**
 * Structural CSS selector for `element`. Walks up until a test id that is
 * unique in the document, else to `<body>`. Element ids, classes and test
 * ids that embed record ids are skipped: they change between renders or
 * between records.
 */
export function buildSelector(element: Element): string {
  const steps: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.body && node !== document.documentElement) {
    const testId = node.getAttribute("data-testid");
    if (testId && !embedsRecordId(testId)) {
      steps.unshift(`[data-testid="${CSS.escape(testId)}"]`);
      const selector = steps.join(" > ");
      if (document.querySelectorAll(selector).length === 1) return selector;
    } else {
      steps.unshift(positionalStep(node));
    }
    node = node.parentElement;
  }
  return ["body", ...steps].join(" > ");
}

/** Human breadcrumb: nearest named ancestor › tag "text…". */
export function describeElement(element: Element): string {
  const named = element.closest("[data-testid], [aria-label]");
  const name =
    named?.getAttribute("data-testid") ?? named?.getAttribute("aria-label");
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  const snippet = text
    ? ` "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`
    : "";
  const tag = element.tagName.toLowerCase();
  return name && named !== element
    ? `${name} › ${tag}${snippet}`
    : `${name ?? tag}${snippet}`;
}

export function findAnchorElement(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

// ===

function positionalStep(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter(
    (sibling) => sibling.tagName === element.tagName,
  );
  return sameTag.length > 1
    ? `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`
    : tag;
}

function embedsRecordId(value: string): boolean {
  return /[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{16,}|\d{4,}/i.test(value);
}

function findSequence(haystack: string[], needle: string[]): number {
  return haystack.findIndex((_, start) =>
    needle.every(
      (part, offset) => safeDecode(haystack[start + offset]) === part,
    ),
  );
}

function safeDecode(segment: string | undefined): string | undefined {
  if (segment === undefined) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
