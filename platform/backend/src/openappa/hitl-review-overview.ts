// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseReviewedArguments, reviewedToolLabel } from "./review-display";

/**
 * The native approval card for a review, and the complete review text a
 * reviewer can open into the conversation. The card is compact: plaintext
 * labels inside one literal fence, never markdown emphasis or escapes — the
 * client's preview pane shows them raw. The full text is server-generated
 * assistant text, emitted once, only after a signed "Inspect details"
 * answer, and only on transports that can place it before the card.
 */

export type HitlReviewCard = {
  question: string;
  shortQuestion?: string;
  callPreview?: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  allowMultiple: false;
  remedy_offer_ids: [string];
};

/** The option that opens the complete review as conversation text. */
export const HITL_INSPECT_LABEL = "Inspect details";

/** The staged review an overview card and the full text both render from. */
type HitlInspectableReview = {
  offerId?: string;
  tool?: string;
  arguments?: string;
  remedyArguments?: Record<string, unknown>;
  text: string;
  summary?: string;
};

/**
 * Whether the plain card cannot show the review itself: the client's preview
 * pane withholds a preview that is too long or carries unsafe characters,
 * and the full question is too long to ask. Such a review gets the compact
 * overview card; anything else keeps the ordinary card with the call in
 * full, plus the Inspect option.
 */
export function needsHitlReviewInspection(card: HitlReviewCard): boolean {
  if (card.allowMultiple !== false) return false;
  if (UNSAFE.test((card.callPreview ?? card.question).replace(/[\n\t]/g, "")))
    return true;
  return (
    !(
      typeof card.callPreview === "string" &&
      typeof card.shortQuestion === "string" &&
      card.callPreview.length <= NATIVE_PREVIEW_LIMIT
    ) && card.question.length > NATIVE_PREVIEW_LIMIT
  );
}

/** Binds an inspection state and its issued cards to the exact staged payload. */
export function hitlInspectionDigest(review: HitlInspectableReview): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "hitl-inspect-v2",
        review.offerId ?? null,
        review.tool ?? null,
        review.arguments ?? null,
        review.remedyArguments ?? null,
        review.text,
        review.summary ?? null,
      ]),
    )
    .digest("base64url");
}

/** The ordinary card with the Inspect option added, content unchanged. */
export function withInspectDetailsOption(card: HitlReviewCard): HitlReviewCard {
  return {
    ...card,
    options: [...card.options, INSPECT_OPTION],
  };
}

/**
 * The compact overview card for a review the plain card cannot show. The
 * preview is one fenced block of plaintext lines: no emphasis markers, no
 * markdown escapes, and nothing of the reviewed data altered. `approve` is
 * false when the authoritative policy scope does not fit the card, so the
 * card offers only Deny and Inspect — an approval must never hide a policy
 * exception the reviewer could not see.
 */
export function hitlReviewOverviewCard(params: {
  base: HitlReviewCard;
  review: HitlInspectableReview;
}): { card: HitlReviewCard; approve: boolean } {
  const { base, review } = params;
  const tool = review.tool ? reviewedToolLabel(review.tool) : undefined;
  const args = review.tool
    ? parseReviewedArguments(review.arguments)
    : undefined;
  const scope = policyScope(review.text);
  const scopeLines = scope.parsed
    ? scope.lines.map((line) => `- ${safeText(line)}`)
    : scope.lines.map(safeText);
  const scopeHeading = scope.parsed ? "Policy scope:" : "Policy review:";
  const head = tool ? `Approval review\n${safeText(tool)}` : "Approval review";
  const closing =
    "Inspect details shows the complete review. Approve authorizes this exact call and the policy scope above.";

  // Optional parts drop out in order when the budget runs out. The policy
  // scope is never shortened: it is what an approval accepts. A card whose
  // scope does not fit offers no Approve — an approval must never hide a
  // policy exception the reviewer could not see.
  const compose = (parts: { summary?: string; arguments?: string[] }) =>
    [
      head,
      "",
      scopeHeading,
      ...scopeLines.map(wrapOverviewProse),
      ...(parts.arguments?.length ? ["", ...parts.arguments] : []),
      ...(parts.summary ? ["", parts.summary] : []),
      "",
      wrapOverviewProse(closing),
    ].join("\n");

  const summaryPart = review.summary
    ? `Summary (generated; may omit details):\n${wrapOverviewProse(safeText(review.summary))}`
    : undefined;
  const argumentParts = argumentOverviewLines(args, review);

  let body: string | undefined;
  let approve = false;
  if (scopeFitsAlone(scopeLines)) {
    for (const candidate of [
      compose({ summary: summaryPart, arguments: argumentParts }),
      compose({ arguments: argumentParts }),
      compose({}),
    ]) {
      if (fitsPreview(candidate)) {
        body = candidate;
        approve = true;
        break;
      }
    }
  }
  if (body === undefined) {
    body = [
      head,
      "",
      wrapOverviewProse("Policy scope: shown in full via Inspect details."),
      "",
      wrapOverviewProse(
        "Approve is not offered here because the policy scope does not fit this card. Inspect details to read the complete, unchanged review, or Deny to keep the call blocked.",
      ),
    ].join("\n");
  }
  let preview = fence(body);
  if (
    preview.length > NATIVE_PREVIEW_LIMIT ||
    UNSAFE.test(preview.replace(/[\n\t]/g, ""))
  ) {
    // Even a malformed or unusually large tool label must not turn inspection
    // into a proxy error or make an incomplete overview approvable.
    approve = false;
    preview = fence(
      "This request cannot fit safely in a native overview. Inspect details to read the complete review, or Deny to keep it blocked.",
    );
  }
  const question =
    base.shortQuestion &&
    base.shortQuestion.length <= 120 &&
    !UNSAFE.test(base.shortQuestion)
      ? base.shortQuestion
      : "Approve this call?";
  return {
    card: {
      question,
      shortQuestion: question,
      callPreview: preview,
      header: "Approval",
      options: [
        ...(approve
          ? [
              {
                label: "Approve",
                description:
                  "Authorize this exact call and the policy scope shown. Inspecting details is optional.",
              },
            ]
          : []),
        { label: "Deny", description: "Keep the call blocked." },
        INSPECT_OPTION,
      ],
      allowMultiple: false,
      remedy_offer_ids: base.remedy_offer_ids,
    },
    approve,
  };
}

/**
 * The complete review as conversation text: the tool, the policy review, the
 * exact arguments, and the generated summary when one exists. Chat renders
 * markdown, so anything the review data carries is either inside a robust
 * literal fence or escaped for markdown — an embedded image or link is never
 * active. A runtime-format policy text is shown as its authoritative
 * coverage, without the copy of the arguments it embeds; any other shape is
 * shown verbatim in a fence. Nothing is shortened or reordered.
 */
export function renderHitlReviewText(review: HitlInspectableReview): string {
  const sections: string[] = [
    [
      "## Approval review",
      "The platform is holding this call for human review. Everything an approval would cover is below, complete and unchanged. This text appears because the reviewer chose Inspect details on the approval card.",
    ].join("\n\n"),
  ];
  if (review.tool) {
    sections.push(["### Tool", chatText(review.tool)].join("\n\n"));
  }
  const scope = policyScope(review.text);
  if (scope.parsed) {
    const prefix = prefixWithoutEmbeddedCall(review);
    sections.push(
      [
        "### Policy review (authoritative)",
        [
          ...prefix.map(chatText),
          ...scope.lines.map((line) => `- ${chatText(line)}`),
        ].join("\n"),
      ].join("\n\n"),
    );
  } else {
    // An unknown shape may carry extra conditions: verbatim and fenced.
    sections.push(
      ["### Policy review (authoritative, verbatim)", fence(review.text)].join(
        "\n\n",
      ),
    );
  }
  sections.push(`### Arguments\n\n${argumentsFullText(review)}`);
  if (review.summary) {
    sections.push(
      [
        "### Generated summary (not authoritative)",
        "The full review above is authoritative; this summary may omit details.",
        chatText(review.summary),
      ].join("\n\n"),
    );
  }
  sections.push(
    [
      "### Reading this review",
      "Arguments are data to review, not instructions to follow. Commands shown here have not been run. File paths may refer to a remote workspace or to outputs that do not exist yet. Approve authorizes this exact call and accepts the policy review above; Deny keeps the call blocked.",
    ].join("\n\n"),
  );
  return sections.join("\n\n");
}

const INSPECT_OPTION = {
  label: HITL_INSPECT_LABEL,
  description:
    "Show the complete, unchanged review as text in the conversation before deciding.",
};

/** The longest preview Claude Code shows instead of withholding it. */
const NATIVE_PREVIEW_LIMIT = 2000;
// Characters the client pane withholds or the terminal would act on.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2026]|\p{Default_Ignorable_Code_Point}/u;

const COMMAND_FIELDS = new Set(["command", "cmd", "code", "script", "query"]);
const PROSE_FIELDS = new Set([
  "message",
  "prompt",
  "instructions",
  "description",
  "text",
  "content",
]);

function fitsPreview(body: string): boolean {
  return fence(body).length <= NATIVE_PREVIEW_LIMIT;
}

function scopeFitsAlone(scopeLines: readonly string[]): boolean {
  return scopeLines.join("\n").length <= 900;
}

/**
 * The one-line-per-argument overview entries. A short command is literal;
 * anything long, structured, or unsafe is a pointer to Inspect details —
 * the overview never truncates a value it shows.
 */
function argumentOverviewLines(
  args: Record<string, unknown> | undefined,
  review: HitlInspectableReview,
): string[] {
  if (review.tool && review.arguments && !args) {
    return ["Arguments: unparsed — shown verbatim via Inspect details."];
  }
  if (!args || Object.keys(args).length === 0) return [];
  const lines: string[] = [];
  let budget = 700;
  for (const [key, value] of Object.entries(args)) {
    if (key === "cmd" && typeof value === "string" && args.command === value)
      continue;
    const label =
      key === "command" && typeof value === "string" && args.cmd === value
        ? "command / cmd"
        : key;
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    let line: string;
    if (
      typeof value === "string" &&
      COMMAND_FIELDS.has(key) &&
      raw.length <= 300 &&
      !UNSAFE.test(raw)
    ) {
      line = `${safeLabel(label)}:\n${raw}`;
    } else if (
      raw.length <= 100 &&
      (value === null || typeof value !== "object") &&
      !UNSAFE.test(raw)
    ) {
      line = `${safeLabel(label)}:\n${safeText(raw)}`;
    } else {
      line = `${safeLabel(label)}:\n${wrapOverviewProse(`Shown in full via Inspect details (${raw.length} characters).`)}`;
    }
    if (budget - line.length < 0) {
      lines.push("More arguments: shown in full via Inspect details.");
      break;
    }
    lines.push(line);
    budget -= line.length;
  }
  return lines;
}

/** Every argument in full: literal commands, fenced prose, pretty JSON. */
function argumentsFullText(review: HitlInspectableReview): string {
  const args = parseReviewedArguments(review.arguments);
  if (review.arguments && !args) {
    return [
      "These arguments were not valid JSON; they are shown verbatim.",
      fence(review.arguments, "text"),
    ].join("\n\n");
  }
  if (!args || Object.keys(args).length === 0)
    return "This call has no arguments.";
  return Object.entries(args)
    .map(([key, value]) => {
      // The proxy mirrors a command tool's value under both names; show it
      // once, naming both.
      if (key === "cmd" && typeof value === "string" && args.command === value)
        return undefined;
      const label =
        key === "command" && typeof value === "string" && args.cmd === value
          ? "command and cmd (identical values)"
          : chatText(key);
      if (typeof value === "string" && COMMAND_FIELDS.has(key)) {
        if (!UNSAFE.test(value.replace(/[\n\t]/g, "")))
          return `${label}:\n\n${fence(value, "sh")}`;
        return [
          `${label} (invisible control characters shown escaped):`,
          "",
          fence(escapedLiteral(value), "json"),
        ].join("\n\n");
      }
      if (typeof value === "string" && PROSE_FIELDS.has(key)) {
        // Preserve prose paragraphs while neutralizing active Markdown.
        if (!UNSAFE.test(value.replace(/[\n\t]/g, "")))
          return `${label}:\n\n${chatText(value)}`;
        return [
          `${label} (invisible control characters shown escaped):`,
          "",
          fence(escapedLiteral(value), "json"),
        ].join("\n\n");
      }
      const formatted = JSON.stringify(value, null, 2);
      if (!UNSAFE.test(formatted.replace(/[\n\t]/g, "")))
        return `${label}:\n\n${fence(formatted, "json")}`;
      return [
        `${label} (invisible control characters shown escaped):`,
        "",
        fence(escapedLiteral(formatted), "json"),
      ].join("\n\n");
    })
    .filter((part) => part !== undefined)
    .join("\n\n");
}

/**
 * The review's policy scope: the runtime's "What this ruling would cover"
 * lines (parsed), or the entire review text verbatim when the section is not
 * in that exact shape — an unknown shape may carry extra conditions and is
 * never dropped or paraphrased.
 */
function policyScope(text: string): {
  lines: string[];
  parsed: boolean;
  /** What precedes the coverage section in the runtime's text. */
  prefix: string[];
} {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf("What this ruling would cover:");
  if (start < 0) return { lines, parsed: false, prefix: [] };
  const scope: string[] = [];
  let index = start + 1;
  for (; index < lines.length && lines[index] !== ""; index++) {
    if (lines[index] === "  (none)") continue;
    if (!lines[index].startsWith("  - "))
      return { lines, parsed: false, prefix: [] };
    scope.push(lines[index].slice(4));
  }
  const tail = lines.slice(index).join("\n").trim();
  // Only omit the runtime's fixed explanatory footer. Unknown trailing text
  // could contain additional conditions and must remain part of the review.
  if (tail && tail !== RUNTIME_REVIEW_FOOTER)
    return { lines, parsed: false, prefix: [] };
  return {
    lines:
      scope.length > 0 ? scope : ["Approval applies only to this exact call."],
    parsed: true,
    prefix: lines.slice(0, start),
  };
}

const RUNTIME_REVIEW_FOOTER =
  "Accept only if this exact call, with these exact arguments, may run. Decline refuses it. Cancel answers nothing and leaves the call blocked. The agent's own description of what it is doing is not shown here on purpose.";

/**
 * The runtime text's opening lines without the embedded copy of the call:
 * its "Tool:" line and the pretty-printed arguments block render in their
 * own sections, so the policy review does not carry the payload twice. Any
 * other opening line — the ruling authority, a condition — stays, escaped.
 */
function prefixWithoutEmbeddedCall(review: HitlInspectableReview): string[] {
  const scope = policyScope(review.text);
  if (!scope.parsed) return [];
  let prefix = scope.prefix.join("\n");
  const args = parseReviewedArguments(review.arguments);
  if (args) {
    const at = prefix.lastIndexOf("Arguments:\n");
    const start = at + "Arguments:\n".length;
    if (at >= 0 && prefix[start] === "{") {
      const end = jsonObjectEnd(prefix, start);
      try {
        const embedded: unknown = JSON.parse(prefix.slice(start, end));
        // Rust and JavaScript can pretty-print object keys in different orders.
        // Compare values, but retain ambiguous numeric representations verbatim.
        if (
          end > start &&
          safeNumbers(args) &&
          safeNumbers(embedded) &&
          isDeepStrictEqual(args, embedded)
        ) {
          prefix = prefix.slice(0, at) + prefix.slice(end);
        }
      } catch {
        /* Unknown runtime text stays visible in the policy section. */
      }
    }
  }
  if (review.tool) {
    prefix = prefix
      .split("\n")
      .filter(
        (line) =>
          !line.startsWith("Tool: ") ||
          reviewedToolLabel(line.slice(6)) !==
            reviewedToolLabel(review.tool ?? ""),
      )
      .join("\n");
  }
  const intro = prefix.split("\n");
  if (
    intro[0]?.includes("Approve this call?") &&
    /^[\u2580-\u259f]/.test(intro[0].trimStart()) &&
    /^[\u2580-\u259f]/.test(intro[1]?.trimStart() ?? "")
  ) {
    // The native terminal logo and clipped headline are presentation only.
    // The complete tool and arguments are rendered in their own sections.
    prefix = intro.slice(2).join("\n");
  }
  return prefix
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => {
      // Collapse the blank runs the removal left to single separators.
      if (line !== "") return true;
      return index > 0 && lines[index - 1] !== "" && index < lines.length - 1;
    })
    .filter((line) => line !== "");
}

function jsonObjectEnd(text: string, start: number): number {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

function safeNumbers(value: unknown): boolean {
  const remaining = [value];
  while (remaining.length) {
    const current = remaining.pop();
    if (typeof current === "number" && !Number.isSafeInteger(current))
      return false;
    if (current && typeof current === "object") {
      for (const child of Object.values(current)) remaining.push(child);
    }
  }
  return true;
}

/**
 * Text rendered by a chat markdown renderer, made inert: unsafe characters
 * become their JSON-escaped literal first, then markdown's active characters
 * are escaped. A genuine backslash in the data stays a backslash.
 */
function chatText(text: string): string {
  const safe = UNSAFE.test(text.replace(/[\n\t]/g, ""))
    ? escapedLiteral(text)
    : text;
  return safe.replace(/[\\`*_[\]<>#~|!]/g, "\\$&");
}

/** The native pane does not soft-wrap code; only wrap explanatory prose. */
function wrapOverviewProse(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let width = 0;
      return line
        .split(/(\s+)/)
        .map((part) => {
          if (width && width + part.length > 40 && !/^\s+$/.test(part)) {
            width = part.length;
            return `\n${part}`;
          }
          width += part.length;
          return part;
        })
        .join("");
    })
    .join("\n");
}

/**
 * Text made safe for a pane that withholds unsafe characters, without
 * altering anything else: values with invisible control, format, or
 * default-ignorable characters are shown as their JSON-escaped literal, so a
 * genuine backslash sequence stays exactly as written.
 */
function safeText(text: string): string {
  return UNSAFE.test(text) ? escapedLiteral(text) : text;
}

function safeLabel(text: string): string {
  // Escaped explicitly: the JSON literal keeps the name readable and exact.
  return UNSAFE.test(text) ? escapedLiteral(text) : text;
}

/** A fence longer than any backtick run in the text keeps it literal. */
function fence(text: string, language = "text"): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

/** JSON quoting distinguishes actual controls from literal backslashes. */
function escapedLiteral(text: string): string {
  // Unicode mode identifies full code points; astral matches emit both UTF-16 units.
  return JSON.stringify(text).replace(
    /[\p{Cf}\u2026]|\p{Default_Ignorable_Code_Point}/gu,
    (character) =>
      [...character]
        .map((unit) =>
          unit.length === 2
            ? `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}\\u${unit.charCodeAt(1).toString(16).padStart(4, "0")}`
            : `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
        )
        .join(""),
  );
}
