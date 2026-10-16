// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dump as dumpYaml } from "js-yaml";
import { isCommandExecutionTool } from "./command-normalization";
import { parseReviewedArguments, reviewedToolLabel } from "./review-display";

/**
 * The native approval card for a review, and the complete review text a
 * reviewer can open into the conversation. The card asks one short line and
 * shows the call as plain text in Claude Code's preview pane beside the
 * options; what an approval also accepts shows under Allow only. The full
 * text is server-generated assistant text, emitted once, only after a signed
 * Inspect answer, and only on transports that can place it before the card.
 */

export type HitlReviewCard = {
  question: string;
  shortQuestion?: string;
  callPreview?: string;
  header: string;
  /** An option's own `preview` replaces `callPreview` for that option. */
  options: Array<{ label: string; description: string; preview?: string }>;
  allowMultiple: false;
  remedy_offer_ids: [string];
};

/** The option that opens the complete review as conversation text. */
export const HITL_INSPECT_LABEL = "Inspect";

/** What choosing this label on a review card decides. */
export function hitlReviewCardAnswer(
  label: string,
): "approve" | "deny" | "inspect" | undefined {
  if (label === ALLOW_LABEL) return "approve";
  if (label === DENY_LABEL) return "deny";
  if (label === HITL_INSPECT_LABEL) return "inspect";
  return undefined;
}

/**
 * The labels of the previous card layout. A card stays open for up to 30
 * minutes, so an answer to one issued before a deploy can arrive after it.
 */
export const PREVIOUS_HITL_CARD_LABELS = ["Approve", "Deny", "Inspect details"];

/**
 * What a previous-layout label decides. Its Approve is asked again on the
 * current card: that layout decided which reviews could be approved
 * differently, and an approval is never granted on a guess.
 */
export function previousHitlCardAnswer(
  label: string,
): "deny" | "inspect" | "ask-again" | undefined {
  if (label === "Approve") return "ask-again";
  if (label === "Deny") return "deny";
  if (label === "Inspect details") return "inspect";
  return undefined;
}

/** The staged review a card and the full text both render from. */
type HitlInspectableReview = {
  offerId?: string;
  tool?: string;
  arguments?: string;
  remedyArguments?: Record<string, unknown>;
  text: string;
  summary?: string;
};

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

/**
 * The approval card for a review: "Run <tool>?", the call's arguments in each
 * option's preview, and the policy scope under Allow. A value too long for the
 * pane becomes a pointer to Inspect that states its size; nothing is cut
 * silently. `approve` is false when the scope does not fit: the card then
 * offers no Allow, so an approval never accepts a scope the reviewer could not
 * see. `base` is the plain card, whose full question a client shows if it
 * withholds the previews.
 */
export function hitlReviewCard(params: {
  base: HitlReviewCard;
  review: HitlInspectableReview;
}): { card: HitlReviewCard; approve: boolean } {
  const { base, review } = params;
  const card = {
    question: base.question,
    header: "Tool call",
    allowMultiple: false as const,
    remedy_offer_ids: base.remedy_offer_ids,
  };
  if (!review.tool) {
    // A review that names no tool describes its call only in its text, which
    // the card asks as its question.
    const approve =
      base.question.length <= PREVIEW_LIMIT && !hasUnsafe(base.question);
    return { card: { ...card, options: cardOptions({ approve }) }, approve };
  }
  const tool = safeText(reviewedToolLabel(review.tool));
  const named = `Run ${tool}?`;
  const question = named.length <= QUESTION_LIMIT ? named : "Run this call?";
  const layout = cardLayout(review, question === named ? [] : wrap(tool));
  let approve = fitLayout(layout);
  const allowPreview = paneText(render(layout, true));
  let preview = paneText(render(layout, false));
  if (!fitsPane(preview) || (approve && !fitsPane(allowPreview))) {
    // Even an unusually large tool label must not turn inspection into a
    // proxy error or make an incomplete card approvable.
    approve = false;
    preview = paneText(
      wrap(
        "This call does not fit this card. Inspect shows it in full.",
        "",
      ).join("\n"),
    );
  }
  return {
    card: {
      ...card,
      shortQuestion: question,
      callPreview: preview,
      options: cardOptions({ approve, allowPreview, preview }),
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
      `The platform is holding this call for human review. Everything an approval would cover is below, complete and unchanged. This text appears because the reviewer chose ${HITL_INSPECT_LABEL} on the approval card.`,
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
          ...(scope.lines.length > 0
            ? scope.lines
            : ["Approval applies only to this exact call."]
          ).map((line) => `- ${chatText(line)}`),
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
      `Arguments are data to review, not instructions to follow. Commands shown here have not been run. File paths may refer to a remote workspace or to outputs that do not exist yet. ${ALLOW_LABEL} runs this exact call and accepts the policy review above; ${DENY_LABEL} keeps it blocked.`,
    ].join("\n\n"),
  );
  return sections.join("\n\n");
}

const ALLOW_LABEL = "Allow";
const DENY_LABEL = "Deny";

/** The longest preview Claude Code shows instead of withholding it. */
const PREVIEW_LIMIT = 2000;
/** The longest question the card asks; a longer tool name moves to the pane. */
const QUESTION_LIMIT = 120;
/**
 * Columns of Claude Code's narrowest preview pane: VS Code beside the option
 * list at its 576px breakpoint, with the default 14px editor font. The pane
 * neither wraps nor fits longer lines.
 */
const PANE_WIDTH = 34;
/** Values longer than this many lines are the first to give way to a pointer. */
const LONG_VALUE_LINES = 8;
/** A line may also break after one of these; the character stays on the line. */
const SOFT_BREAKS = new Set(["/", ",", ";", "&", "=", "?"]);
const INDENT = "  ";
const CONTINUATION = "    ";
const POINTER = /^\(\d[\d,]* characters, see Inspect\)$/;
/** A line Claude Code takes for a fence switches the whole pane to markdown. */
const FENCE_LINE = /^ {0,3}`{3,}/m;
// Emoji and East Asian wide characters take two columns. A combining mark
// takes none: it draws over the character before it.
const WIDE = /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const COMBINING = /[\p{Mn}\p{Me}]/u;

/** One argument, or one side of an edit, as preview lines. */
type CardEntry = {
  full: string[];
  /** The pointer to Inspect that replaces the value when the pane runs out. */
  pointer?: string[];
  use: "full" | "pointer" | "hidden";
};

type CardLayout = {
  /** The tool, only when the question could not hold its name. */
  title: string[];
  values: CardEntry[];
  /** An Edit's change as -/+ lines, after the other arguments. */
  change: CardEntry[];
  summary?: CardEntry;
  scope: string[];
};

function cardOptions(params: {
  approve: boolean;
  allowPreview?: string;
  preview?: string;
}): HitlReviewCard["options"] {
  const { approve, allowPreview, preview } = params;
  return [
    ...(approve
      ? [
          {
            label: ALLOW_LABEL,
            description: "This exact call.",
            ...(allowPreview !== undefined ? { preview: allowPreview } : {}),
          },
        ]
      : []),
    {
      label: DENY_LABEL,
      description: "Keep it blocked.",
      ...(preview !== undefined ? { preview } : {}),
    },
    {
      label: HITL_INSPECT_LABEL,
      description: approve
        ? "Show the full review in chat."
        : "Show the full review in chat. Allow is not offered: this card cannot show everything an approval accepts.",
      ...(preview !== undefined ? { preview } : {}),
    },
  ];
}

function cardLayout(
  review: HitlInspectableReview,
  title: string[],
): CardLayout {
  const args = cardArguments(review);
  const baseName = review.tool?.replace(/^(builtin:|host\/[^/]+\/)/, "");
  let values: CardEntry[] = [];
  let change: CardEntry[] = [];
  if (typeof args === "string") {
    values = [valueEntry("arguments", args)];
  } else if (args) {
    const { command, file_path, content, old_string, new_string } = args;
    if (
      baseName === "Edit" &&
      typeof file_path === "string" &&
      typeof old_string === "string" &&
      typeof new_string === "string" &&
      !hasUnsafe(old_string) &&
      !hasUnsafe(new_string)
    ) {
      values = [
        valueEntry("file_path", file_path),
        ...entries(without(args, ["file_path", "old_string", "new_string"])),
      ];
      const before = expandTabs(old_string);
      const lines = [
        ...before.split("\n").map((line) => `-${line}`),
        ...expandTabs(new_string)
          .split("\n")
          .map((line) => `+${line}`),
      ];
      const removed = before.split("\n").length;
      change = [
        sideEntry("old_string", old_string, lines.slice(0, removed)),
        sideEntry("new_string", new_string, lines.slice(removed)),
      ];
    } else if (
      baseName === "Write" &&
      typeof file_path === "string" &&
      typeof content === "string"
    ) {
      values = [
        valueEntry("file_path", file_path),
        ...entries(without(args, ["file_path", "content"])),
        valueEntry("content", content, true),
      ];
    } else if (
      review.tool &&
      isCommandExecutionTool(review.tool) &&
      typeof command === "string"
    ) {
      values = [
        valueEntry("command", command),
        ...entries(without(args, ["command"])),
      ];
    } else {
      values = entries(args);
    }
    if (values.length === 0)
      values = [{ full: ["No arguments."], use: "full" }];
  }
  return {
    title,
    values,
    change,
    ...(review.summary ? { summary: summaryEntry(review.summary) } : {}),
    scope: scopeLines(review.text),
  };
}

/**
 * The reviewed arguments: an object without the proxy's `cmd` copy of a
 * command, the raw text when it is not a JSON object, or undefined.
 */
function cardArguments(
  review: HitlInspectableReview,
): Record<string, unknown> | string | undefined {
  if (!review.tool) return undefined;
  const args = parseReviewedArguments(review.arguments);
  if (!args) return review.arguments;
  return isCommandExecutionTool(review.tool) && args.cmd === args.command
    ? without(args, ["cmd"])
    : args;
}

/**
 * What an approval accepts besides this call: the runtime's coverage without
 * the human-approval mark the card itself answers, or the whole review text
 * verbatim when its coverage is not in the shape read here.
 */
function scopeLines(text: string): string[] {
  const scope = policyScope(text);
  const lines = scope.parsed
    ? scope.lines.filter((line) => !line.startsWith("attention: "))
    : scope.lines.slice(0, lastLineWithText(scope.lines) + 1);
  if (lines.length === 0) return [];
  return [
    scope.parsed ? "Also accepts:" : "Policy review:",
    ...lines.flatMap((line) =>
      wrap(`${INDENT}${safeText(line)}`, CONTINUATION, INDENT.length),
    ),
  ];
}

function lastLineWithText(lines: readonly string[]): number {
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim() === "") index--;
  return index;
}

function summaryEntry(summary: string): CardEntry {
  return {
    full: [
      "Generated summary:",
      ...wrap(
        `${INDENT}${safeText(summary).replace(/\s+/g, " ").trim()}`,
        INDENT,
        INDENT.length,
      ),
    ],
    pointer: wrap(
      `Generated summary: (${count(summary)} characters, see Inspect)`,
    ),
    use: "full",
  };
}

/**
 * Gives values way to pointers until the Allow preview fits: the summary
 * first, then long values from the end, then any value a pointer shortens.
 * Returns false when even that leaves no room for the scope; values past the
 * room left are then counted instead of shown. It sets `use` on the layout's
 * own entries, so a layout is fitted once and then rendered.
 */
function fitLayout(layout: CardLayout): boolean {
  const fits = (withScope: boolean) =>
    paneText(render(layout, withScope)).length <= PREVIEW_LIMIT;
  if (!fits(true) && layout.summary?.pointer) layout.summary.use = "pointer";
  const values = [...layout.values, ...layout.change].reverse();
  const give = (when: (entry: CardEntry) => boolean) => {
    for (const entry of values) {
      if (fits(true)) return;
      if (entry.use === "full" && entry.pointer && when(entry))
        entry.use = "pointer";
    }
  };
  give((entry) => entry.full.length > LONG_VALUE_LINES);
  give(
    (entry) =>
      (entry.pointer ?? entry.full).join("\n").length <
      entry.full.join("\n").length,
  );
  // A short summary comes back once the values have made room.
  if (layout.summary?.use === "pointer") {
    layout.summary.use = "full";
    if (!fits(true)) layout.summary.use = "pointer";
  }
  if (fits(true)) return true;
  for (const entry of [...layout.values].reverse()) {
    if (fits(false)) break;
    entry.use = "hidden";
  }
  return false;
}

function render(layout: CardLayout, withScope: boolean): string {
  const shown = (entry: CardEntry) =>
    entry.use === "hidden"
      ? []
      : entry.use === "pointer" && entry.pointer
        ? entry.pointer
        : entry.full;
  const values = layout.values.flatMap(shown);
  const hidden = layout.values.filter((entry) => entry.use === "hidden").length;
  if (hidden > 0)
    values.push(
      ...wrap(
        `(${hidden} more argument${hidden === 1 ? "" : "s"}, see Inspect)`,
      ),
    );
  return [
    layout.title,
    values,
    layout.change.flatMap(shown),
    layout.summary ? shown(layout.summary) : [],
    withScope ? layout.scope : [],
  ]
    .filter((block) => block.length > 0)
    .map((block) => block.join("\n"))
    .join("\n\n");
}

/**
 * The preview as Claude Code draws it: plain text, which the client puts in
 * one literal block. A line the client would take for a fence switches the
 * pane to markdown, so such a preview carries its own longer fence.
 */
function paneText(text: string): string {
  return FENCE_LINE.test(text) ? fence(text) : text;
}

function fitsPane(text: string): boolean {
  return text.length <= PREVIEW_LIMIT && !hasUnsafe(text);
}

function entries(args: Record<string, unknown>): CardEntry[] {
  return Object.entries(args).map(([name, value]) => valueEntry(name, value));
}

/** `name: value`, or `name:` over an indented block; a pointer past the limit. */
function valueEntry(name: string, value: unknown, code = false): CardEntry {
  const label = /^[\w.$@/-]+$/.test(name) ? name : escapedLiteral(name);
  const size =
    typeof value === "string"
      ? [...value].length
      : (JSON.stringify(value) ?? "").length;
  const pointer = wrap(
    `${label}: (${size.toLocaleString("en-US")} characters, see Inspect)`,
  );
  if (size > PREVIEW_LIMIT) return { full: pointer, use: "full" };
  return { full: valueLines(label, value, code), pointer, use: "full" };
}

function valueLines(label: string, value: unknown, code: boolean): string[] {
  const inline = (text: string) => wrap(`${label}: ${text}`);
  if (typeof value === "string") {
    if (hasUnsafe(value) || (!code && value.includes("\t")))
      return inline(escapedLiteral(value));
    const text = code ? expandTabs(value) : value;
    if (!text.includes("\n"))
      return inline(readsAsOther(text) ? escapedLiteral(text) : text);
    if (text.trim() === "") return inline(escapedLiteral(value));
    const body = text.endsWith("\n") ? text.slice(0, -1) : text;
    return [
      `${label}:`,
      ...body.split("\n").flatMap((line) => wrapCode(line, INDENT)),
    ];
  }
  if (value === null || typeof value !== "object")
    return inline(JSON.stringify(value) ?? String(value));
  const yaml = dumpYaml(value, { lineWidth: -1, noRefs: true }).trimEnd();
  if (hasUnsafe(yaml) || yaml.includes("\t")) return inline(jsonEscaped(value));
  if (yaml === "[]" || yaml === "{}") return inline(yaml);
  return [
    `${label}:`,
    ...yaml.split("\n").flatMap((line) => wrapCode(line, INDENT)),
  ];
}

/** One side of an Edit as -/+ lines, or a pointer past the limit. */
function sideEntry(name: string, text: string, lines: string[]): CardEntry {
  const pointer = wrap(`${name}: (${count(text)} characters, see Inspect)`);
  if ([...text].length > PREVIEW_LIMIT) return { full: pointer, use: "full" };
  return {
    full: lines.flatMap((line) => wrapCode(line.slice(1), "", line.charAt(0))),
    pointer,
    use: "full",
  };
}

/**
 * A string shown bare would read as something else: empty, edge spaces,
 * JSON (a number, true, a quoted string), or this card's own pointer.
 */
function readsAsOther(text: string): boolean {
  if (text === "" || text.trim() !== text || POINTER.test(text)) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** A nested value as compact JSON with invisible characters made visible. */
function jsonEscaped(value: unknown): string {
  if (typeof value === "string") return escapedLiteral(value);
  if (Array.isArray(value)) return `[${value.map(jsonEscaped).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${escapedLiteral(key)}:${jsonEscaped(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function without(
  args: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !names.includes(name)),
  );
}

function count(text: string): string {
  return [...text].length.toLocaleString("en-US");
}

function hasUnsafe(text: string): boolean {
  return UNSAFE.test(text.replace(/[\n\t]/g, ""));
}

/** Tabs as spaces to the next multiple of four, as an editor shows code. */
function expandTabs(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      let out = "";
      let column = 0;
      for (const char of line) {
        const add = char === "\t" ? " ".repeat(4 - (column % 4)) : char;
        out += add;
        column += char === "\t" ? add.length : displayWidth(char);
      }
      return out;
    })
    .join("\n");
}

/**
 * A code line under `base`. A wrapped line continues four spaces past its own
 * indent, or past the margin when that indent is already half the pane, and
 * without a diff sign: only lines that start with one are changed lines.
 */
function wrapCode(line: string, base: string, sign = ""): string[] {
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  const lead = `${base}${sign}${indent}`;
  const unsigned = `${base}${" ".repeat(sign.length)}`;
  const continuation =
    lead.length + CONTINUATION.length <= PANE_WIDTH / 2
      ? `${unsigned}${indent}${CONTINUATION}`
      : `${unsigned}${CONTINUATION}`;
  return wrap(`${base}${sign}${line}`, continuation, lead.length);
}

/**
 * One line wrapped to the pane. A break takes the last space that fits (the
 * space goes), unless the word after it would not fit a line of its own
 * either; then it goes after the last `/`, `,` or similar (nothing goes), and
 * only past both mid-word. Breaks never fall before `floor`.
 */
function wrap(line: string, continuation = CONTINUATION, floor = 0): string[] {
  const out: string[] = [];
  const room = PANE_WIDTH - displayWidth(continuation);
  let chars = [...line];
  let min = floor;
  while (displayWidth(chars.join("")) > PANE_WIDTH) {
    let fit = 0;
    for (let used = 0; fit < chars.length; fit++) {
      const width = displayWidth(chars[fit]);
      if (used + width > PANE_WIDTH) break;
      used += width;
    }
    let space = -1;
    for (let i = fit; i > min; i--)
      if (chars[i] === " ") {
        space = i;
        break;
      }
    let soft = -1;
    for (let i = fit - 1; i >= min; i--)
      if (SOFT_BREAKS.has(chars[i])) {
        soft = i;
        break;
      }
    let cut = fit;
    let skip = 0;
    if (space >= 0 && (soft < space || wordWidth(chars, space + 1) <= room)) {
      cut = space;
      skip = 1;
    } else if (soft >= 0) cut = soft + 1;
    if (cut <= min) {
      cut = fit;
      skip = 0;
    }
    out.push(chars.slice(0, cut).join(""));
    chars = [...continuation, ...chars.slice(cut + skip)];
    min = continuation.length;
  }
  out.push(chars.join(""));
  return out;
}

function wordWidth(chars: string[], from: number): number {
  let width = 0;
  for (let i = from; i < chars.length && chars[i] !== " "; i++)
    width += displayWidth(chars[i]);
  return width;
}

/** Monospace columns the text takes. */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text)
    width += COMBINING.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
  return width;
}
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
  if (tail && !RUNTIME_REVIEW_FOOTERS.has(tail))
    return { lines, parsed: false, prefix: [] };
  return { lines: scope, parsed: true, prefix: lines.slice(0, start) };
}

// The runtime's explanatory footer, in its current and earlier wording.
const RUNTIME_REVIEW_FOOTERS = new Set([
  "Set approval to true only if this exact call, with these exact arguments, may run. Submit false or decline to refuse it. Cancel answers nothing and leaves the call blocked. The agent's own description of what it is doing is not shown here on purpose.",
  "Accept only if this exact call, with these exact arguments, may run. Decline refuses it. Cancel answers nothing and leaves the call blocked. The agent's own description of what it is doing is not shown here on purpose.",
]);

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
    const end =
      at >= 0 && prefix[start] === "{" ? jsonObjectEnd(prefix, start) : -1;
    if (end > start) {
      try {
        const embedded: unknown = JSON.parse(prefix.slice(start, end));
        // Rust and JavaScript can pretty-print object keys in different orders.
        // Compare values, but retain ambiguous numeric representations verbatim.
        if (
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

/**
 * Text made safe for a pane that withholds unsafe characters, without
 * altering anything else: values with invisible control, format, or
 * default-ignorable characters are shown as their JSON-escaped literal, so a
 * genuine backslash sequence stays exactly as written.
 */
function safeText(text: string): string {
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
