import { load } from "cheerio";
import {
  applyStrReplaceEdits,
  type StrReplaceEdit,
} from "@/archestra-mcp-server/str-replace-edits";
import { ApiError } from "@/types";

/**
 * Managed app documents: the platform-owned HTML shell whose four sections
 * (title, css, body, javascript) an author edits by value instead of matching
 * raw HTML. A managed document carries exactly one of each owned node — a
 * `<title>`/`<style>` in `<head>` and a `<main id="app">`/`<script>` in
 * `<body>`, each tagged with a private `data-archestra-app-*` attribute — so
 * managedness is a structural property, recomputed from the document, never a
 * stored flag. This module is the single source of truth for the shell and for
 * all parse/splice logic; the sections mode of edit_app, the starter template,
 * and the section-read path all go through it.
 *
 * Parsing uses cheerio with sourceCodeLocationInfo, which runs parse5's
 * (browser-equivalent) HTML5 tree construction and exposes source offsets. Two
 * consequences the design relies on: script/style content tokenizes as RAWTEXT
 * exactly as a browser would (so a literal `</script>` closes the owned node —
 * we reject that up front), and section extraction slices the original source
 * between the owned node's tag boundaries rather than re-serializing the DOM,
 * so authored bytes are preserved exactly.
 */

// ============================================================================
// Public surface
// ============================================================================

export type SectionKey = "title" | "css" | "body" | "javascript";

/**
 * The four authored section values. The shape `parseManagedSections` returns and
 * `composeManagedDocument` accepts.
 *
 * @public — the module's core type; currently consumed by its test only, which
 * knip's production pass ignores.
 */
export type ManagedSections = {
  /** Decoded plain text (not HTML). */
  title: string;
  /** Raw CSS source. */
  css: string;
  /** Raw body HTML source. */
  body: string;
  /** Raw JavaScript source. */
  javascript: string;
};

/** A section value to write: replace it wholesale, or str_replace-patch it. */
export type SectionSource = { replace: string } | { patch: StrReplaceEdit[] };

/** The four section names, in document order — the tool's advertised set. */
export const MANAGED_SECTION_KEYS = [
  "title",
  "css",
  "body",
  "javascript",
] as const satisfies readonly SectionKey[];

/**
 * Build a complete managed document from four section values. Used to seed the
 * starter template (the only shell definition) and available for a full compose.
 * Rejects section content that would break out of its owned node.
 */
export function composeManagedDocument(sections: ManagedSections): string {
  const normalized: ManagedSections = {
    ...sections,
    title: normalizeTitle(sections.title),
  };
  assertSectionValueSafe("css", normalized.css);
  assertSectionValueSafe("body", normalized.body);
  assertSectionValueSafe("javascript", normalized.javascript);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title ${OWNED.title.attr}>${escapeTitleText(normalized.title)}</title>
<style ${OWNED.css.attr}>${normalized.css}</style>
</head>
<body>
<main id="app" ${OWNED.body.attr}>${normalized.body}</main>
<script ${OWNED.javascript.attr}>${normalized.javascript}</script>
</body>
</html>
`;
  // The shell is controlled, but a section could still carry markup that
  // reshapes the tree past the delimiter checks; verify the result is managed
  // and round-trips before handing it back.
  assertManagedRoundTrip(html, normalized);
  return html;
}

/**
 * Extract the four authored section values from a document, or return null when
 * it is not a managed document (missing, duplicated, or misplaced owned node).
 * Extraction slices original source between tag boundaries, so css/body/js are
 * byte-exact; title is returned as decoded text.
 */
export function parseManagedSections(html: string): ManagedSections | null {
  // Fast path: the owned markers are a necessary condition, so a raw/legacy
  // document is rejected by a cheap substring scan without invoking the parser —
  // keeping read_app/edit_app on raw documents parser-free.
  if (!hasAllOwnedMarkers(html)) return null;
  const $ = load(html, { sourceCodeLocationInfo: true });
  const nodes: Record<SectionKey, ManagedNode> = {} as Record<
    SectionKey,
    ManagedNode
  >;
  for (const key of MANAGED_SECTION_KEYS) {
    const node = findOwnedNode($, OWNED[key]);
    if (!node) return null;
    nodes[key] = node;
  }
  return {
    title: decodeOwnedTitle($),
    css: innerSource(html, nodes.css),
    body: innerSource(html, nodes.body),
    javascript: innerSource(html, nodes.javascript),
  };
}

export function isManagedDocument(html: string): boolean {
  return parseManagedSections(html) !== null;
}

/**
 * Apply per-section replacements/patches to a managed base document, splicing
 * new inner source into the owned nodes and leaving everything else (including
 * out-of-band edits made through raw edit_app) untouched. Throws ApiError(400)
 * when the base is not managed, a section would break out of its node, or the
 * spliced result does not round-trip. Returns the new HTML and which sections
 * actually changed (net-no-op sections are excluded).
 */
export function applySectionMutations(
  baseHtml: string,
  mutations: SectionMutations,
): { html: string; changed: SectionKey[] } {
  const $ = load(baseHtml, { sourceCodeLocationInfo: true });
  const nodes: Record<SectionKey, ManagedNode> = {} as Record<
    SectionKey,
    ManagedNode
  >;
  for (const key of MANAGED_SECTION_KEYS) {
    const node = findOwnedNode($, OWNED[key]);
    if (!node) {
      throw new ApiError(
        400,
        "This app is not a managed-sections document, so it has no editable sections. Edit it with edits or replacementHtml instead.",
      );
    }
    nodes[key] = node;
  }

  const current: ManagedSections = {
    title: decodeOwnedTitle($),
    css: innerSource(baseHtml, nodes.css),
    body: innerSource(baseHtml, nodes.body),
    javascript: innerSource(baseHtml, nodes.javascript),
  };

  // Resolve each requested section to its final stored inner source, once. A
  // patch's str_replace may throw ApiError(400) here (non-matching old_str),
  // before any splice. title stores escaped, normalized text; css/body/js store
  // raw source, which is checked for a node breakout before it is spliced.
  const newInner: Partial<Record<SectionKey, string>> = {};
  const changed: SectionKey[] = [];
  for (const key of MANAGED_SECTION_KEYS) {
    const resolved = resolveSection(key, mutations, current);
    if (resolved === undefined) continue;
    assertSectionValueSafe(key, resolved.raw);
    const priorStored =
      key === "title" ? escapeTitleText(current.title) : current[key];
    if (resolved.stored !== priorStored) {
      newInner[key] = resolved.stored;
      changed.push(key);
    }
  }

  if (changed.length === 0) return { html: baseHtml, changed: [] };

  // Splice right-to-left so earlier offsets stay valid.
  const splices = changed
    .map((key) => ({
      start: nodes[key].innerStart,
      end: nodes[key].innerEnd,
      value: newInner[key] as string,
    }))
    .sort((a, b) => b.start - a.start);
  let html = baseHtml;
  for (const s of splices) {
    html = html.slice(0, s.start) + s.value + html.slice(s.end);
  }

  // The spliced document must still be managed, and every changed section must
  // re-extract to exactly what we intended to store — the authoritative guard
  // against content that reshaped the tree (a stray close tag, a nested owned
  // node) despite passing the delimiter checks.
  const reparsed = parseManagedSections(html);
  if (!reparsed) {
    throw new ApiError(400, ROUND_TRIP_ERROR);
  }
  for (const key of changed) {
    const got =
      key === "title" ? escapeTitleText(reparsed.title) : reparsed[key];
    if (got !== newInner[key]) {
      throw new ApiError(400, ROUND_TRIP_ERROR);
    }
  }
  return { html, changed };
}

export type SectionMutations = {
  title?: string;
  css?: SectionSource;
  body?: SectionSource;
  javascript?: SectionSource;
};

// ============================================================================
// Internals
// ============================================================================

const OWNED: Record<SectionKey, { attr: string; tag: string; parent: string }> =
  {
    title: { attr: "data-archestra-app-title", tag: "title", parent: "head" },
    css: { attr: "data-archestra-app-css", tag: "style", parent: "head" },
    body: { attr: "data-archestra-app-body", tag: "main", parent: "body" },
    javascript: {
      attr: "data-archestra-app-script",
      tag: "script",
      parent: "body",
    },
  };

const ROUND_TRIP_ERROR =
  "The section content would corrupt the managed document (it closes or duplicates a platform-owned element). Nothing was saved. Check for a stray </main>, </script>, or </style>, or edit with replacementHtml.";

// The source offsets of an owned node's inner content (between its tags).
type ManagedNode = {
  innerStart: number;
  innerEnd: number;
};

// A cheerio/domhandler node with the fields this module reads.
type DomNode = {
  name?: string;
  parent?: { name?: string } | null;
  sourceCodeLocation?: {
    startTag?: { endOffset: number };
    endTag?: { startOffset: number };
  } | null;
};

/** Decoded text of the owned title node (validated present by the caller). */
function decodeOwnedTitle($: ReturnType<typeof load>): string {
  return $(`[${OWNED.title.attr}]`).first().text();
}

/** Cheap necessary-condition check: all four owned attributes appear verbatim. */
function hasAllOwnedMarkers(html: string): boolean {
  return MANAGED_SECTION_KEYS.every((key) => html.includes(OWNED[key].attr));
}

function findOwnedNode(
  $: ReturnType<typeof load>,
  spec: { attr: string; tag: string; parent: string },
): ManagedNode | null {
  const matches = $(`[${spec.attr}]`).toArray() as unknown as DomNode[];
  if (matches.length !== 1) return null;
  const el = matches[0];
  if (el.name !== spec.tag) return null;
  if (el.parent?.name !== spec.parent) return null;
  const loc = el.sourceCodeLocation;
  const start = loc?.startTag?.endOffset;
  const end = loc?.endTag?.startOffset;
  // A managed node always has an explicit end tag; a missing one means the tree
  // closed it implicitly (malformed) — treat as not managed.
  if (start === undefined || end === undefined) return null;
  return { innerStart: start, innerEnd: end };
}

function innerSource(html: string, node: ManagedNode): string {
  return html.slice(node.innerStart, node.innerEnd);
}

/**
 * Resolve a requested section to its final stored inner source (and the raw,
 * pre-escape value used for the breakout check), or undefined when the section
 * was not part of this mutation. A patch's str_replace runs here and throws
 * ApiError(400) on a non-matching old_str.
 */
function resolveSection(
  key: SectionKey,
  mutations: SectionMutations,
  current: ManagedSections,
): { stored: string; raw: string } | undefined {
  if (key === "title") {
    if (mutations.title === undefined) return undefined;
    const raw = normalizeTitle(mutations.title);
    return { stored: escapeTitleText(raw), raw };
  }
  const mutation = mutations[key];
  if (mutation === undefined) return undefined;
  if ("replace" in mutation)
    return { stored: mutation.replace, raw: mutation.replace };
  const { content } = applyStrReplaceEdits(current[key], mutation.patch, {
    sourceNoun: `${key} section`,
    rereadHint: `Read the current source with read_app (format: "sections", section: "${key}").`,
  });
  return { stored: content, raw: content };
}

/**
 * Reject section content whose raw text would terminate its owned node early:
 * `</style`/`</script` (as a browser tokenizes RAWTEXT) or a stray `</main>`.
 * title is escaped before it is written, so it can never break out. An injected
 * *owned* node (e.g. a nested `<main data-archestra-app-body>`) is left to the
 * round-trip backstop, which rejects it as a duplicate — checking the attribute
 * as a substring here would also reject innocent body text that merely mentions
 * it. These checks only add a precise, early message ahead of that backstop.
 */
function assertSectionValueSafe(key: SectionKey, value: string): void {
  switch (key) {
    case "css":
      if (/<\/style[\s/>]/i.test(value)) {
        throw new ApiError(400, breakoutError("css", "</style>"));
      }
      return;
    case "javascript":
      if (/<\/script[\s/>]/i.test(value)) {
        throw new ApiError(400, breakoutError("javascript", "</script>"));
      }
      return;
    case "body":
      if (/<\/main[\s/>]/i.test(value)) {
        throw new ApiError(400, breakoutError("body", "</main>"));
      }
      return;
    case "title":
      return;
  }
}

function breakoutError(key: SectionKey, delimiter: string): string {
  return `The ${key} section contains "${delimiter}", which would end the platform-owned element and corrupt the document. Nothing was saved. Escape it (e.g. \\u003C in JavaScript, \\3C in CSS) or split the string.`;
}

function assertManagedRoundTrip(html: string, sections: ManagedSections): void {
  const parsed = parseManagedSections(html);
  if (
    !parsed ||
    parsed.css !== sections.css ||
    parsed.body !== sections.body ||
    parsed.javascript !== sections.javascript ||
    parsed.title !== sections.title
  ) {
    throw new ApiError(400, ROUND_TRIP_ERROR);
  }
}

/** Title is stored HTML-escaped; parse5 normalizes newlines, so do we, once. */
function normalizeTitle(title: string): string {
  return title.replace(/\r\n?/g, "\n");
}

function escapeTitleText(title: string): string {
  return title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
