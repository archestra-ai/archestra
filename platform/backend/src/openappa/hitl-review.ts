import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { dump as dumpYaml } from "js-yaml";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { parseWorkloadPrincipal } from "@/services/agent-runtime/runtime-identity";
import { sessionCallerId } from "./actor";
import { isCommandExecutionTool } from "./command-normalization";
import {
  formatArgumentLines,
  parseReviewedArguments,
  reviewedToolLabel,
} from "./review-display";
import type { OpenAppaSession } from "./service";

type HitlRuling = "approve" | "deny" | "none";

export type HitlReviewOutcome =
  | "review_required"
  | "review_unanswered"
  | "review_cancelled"
  | "review_unavailable"
  | "review_invalid";

type PendingHitlReview = {
  offerId: string;
  text: string;
  tool?: string;
  arguments?: string;
  remedyArguments?: Record<string, unknown>;
};

type HitlAskUserArguments = {
  question: string;
  /** The one-line question for hosts with option previews (Claude Code). */
  shortQuestion?: string;
  /** The call in full, as markdown, for each option's preview. */
  callPreview?: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  allowMultiple: false;
  remedy_offer_ids: [string];
};

const HITL_REVIEW_TTL_MS = 10 * TimeInMs.Minute;
// Replay facts outlive live review claims, but abandoned history is not permanent.
const HITL_HISTORY_TTL_MS = 30 * TimeInMs.Day;
const HITL_RULINGS: readonly HitlRuling[] = ["approve", "none", "deny"];

/** Recovers the review cache scope from the proxy's current trajectory. */
export function reviewSessionFromTrajectory(params: {
  organizationId: string;
  trajectory: { session_id: string; parent_id?: string };
  context: { conversationId?: string; userId?: string };
}): OpenAppaSession {
  const separator = params.trajectory.session_id.indexOf("|");
  const prefix =
    separator > 0
      ? params.trajectory.session_id.slice(0, separator)
      : undefined;
  // Chat roots are unprefixed UUIDs. Only matching server-owned Chat context
  // can supply their caller; headers and child/foreign sessions cannot.
  const callerId =
    sessionCallerId(params.trajectory.session_id) ??
    (parseWorkloadPrincipal(prefix) ? prefix : undefined) ??
    (params.context.userId &&
    params.context.conversationId === params.trajectory.session_id &&
    !params.trajectory.parent_id
      ? `user:${params.context.userId}`
      : undefined);
  if (!callerId) {
    // An unscoped session hashes caller "" into every review key, so two
    // callers with the same trajectory would share one cache scope. Callers
    // that require a caller-bearing session must refuse such a session; the
    // recovery fallbacks above stay intact for paths that legitimately allow
    // an unscoped review session.
    logger.warn(
      {
        organizationId: params.organizationId,
        sessionId: params.trajectory.session_id,
        parentId: params.trajectory.parent_id,
      },
      "OpenAPPA review session has no resolvable caller and shares the unscoped cache scope",
    );
  }
  return {
    organization_id: params.organizationId,
    session_id: params.trajectory.session_id,
    ...(callerId ? { caller_id: callerId } : {}),
    ...(params.trajectory.parent_id
      ? { parent_id: params.trajectory.parent_id }
      : {}),
  };
}

export async function stageHitlReview(params: {
  session: OpenAppaSession;
  review: PendingHitlReview;
  callId?: string;
}): Promise<void> {
  const { review } = params;
  await cacheManager.withLock(
    stagePresenceKey(params.session, review.offerId),
    async (cache) => {
      await cache.set(
        stagePresenceKey(params.session, review.offerId),
        review,
        HITL_REVIEW_TTL_MS,
      );
      await cache.set(
        reviewKey(params.session, review.offerId),
        review,
        HITL_REVIEW_TTL_MS,
      );
    },
  );
  if (params.callId) {
    await recordHitlReviewResult({
      session: params.session,
      callId: params.callId,
      offerId: params.review.offerId,
      outcome: "review_required",
    });
  }
}

/** A history fact only: it neither stages a live review nor grants a ruling. */
export async function recordHitlReviewResult(params: {
  session: OpenAppaSession;
  callId: string;
  offerId: string;
  outcome: HitlReviewOutcome;
}): Promise<void> {
  await cacheManager.set(
    scopedKey(
      CacheKey.OpenAppaHitlReviewHistory,
      params.session,
      JSON.stringify([params.callId, params.offerId]),
    ),
    { callId: params.callId, offerId: params.offerId, outcome: params.outcome },
    HITL_HISTORY_TTL_MS,
  );
}

export async function getHitlReviewResult(params: {
  session: OpenAppaSession;
  callId: string;
  offerId: string;
}): Promise<HitlReviewOutcome | undefined> {
  const record = await cacheManager.get<{
    callId: string;
    offerId: string;
    outcome?: HitlReviewOutcome;
  }>(
    scopedKey(
      CacheKey.OpenAppaHitlReviewHistory,
      params.session,
      JSON.stringify([params.callId, params.offerId]),
    ),
    { throwOnError: true },
  );
  if (record?.callId !== params.callId || record.offerId !== params.offerId)
    return undefined;
  // Previously issued review-required facts did not carry an outcome.
  return record.outcome ?? "review_required";
}

export async function getHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<PendingHitlReview | undefined> {
  const review = await cacheManager.get<PendingHitlReview>(
    reviewKey(params.session, params.offerId),
  );
  if (review?.offerId === params.offerId) return review;
  // Native clients still need the exact review text to bind their following
  // remedy call. This immutable context is not a claimable pending stage.
  if ((await peekHitlRuling(params)) !== "approve") return undefined;
  const approved = await cacheManager.get<PendingHitlReview>(
    stagePresenceKey(params.session, params.offerId),
    { throwOnError: true },
  );
  return approved?.offerId === params.offerId ? approved : undefined;
}

/** Observe a human ruling without spending the remedy's one-time approval. */
export async function peekHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<HitlRuling | undefined> {
  for (const ruling of ["deny", "none", "approve"] as const) {
    const entry = await cacheManager.get<{
      offerId: string;
      ruling: HitlRuling;
    }>(rulingKey(params.session, params.offerId, ruling), {
      throwOnError: true,
    });
    if (entry?.offerId === params.offerId && entry.ruling === ruling)
      return ruling;
  }
  return undefined;
}

export async function getHitlAskUserArguments(params: {
  session: OpenAppaSession;
  offerIds: readonly string[];
}): Promise<HitlAskUserArguments | undefined> {
  if (params.offerIds.length !== 1) return undefined;
  const offerId = params.offerIds[0];
  const review = await getHitlReview({ session: params.session, offerId });
  if (!review) return undefined;
  const options = [
    { label: "Approve", description: "Allow this exact tool call." },
    { label: "Deny", description: "Keep this tool call blocked." },
  ];
  if (!review.tool) {
    return {
      question: formatReviewQuestion(review.text),
      header: "Approval",
      options,
      allowMultiple: false,
      remedy_offer_ids: [offerId],
    };
  }
  // Claude Code shows the call in full in each option's preview and asks one
  // line about it. Forms and other hosts ask the same call in one text. Both
  // keep what an approval accepts besides the call.
  const args = withoutCommandAlias(
    review.tool,
    parseReviewedArguments(review.arguments) ?? {},
  );
  const accepted = acceptedCoverage(review.text);
  const preview = callPreview(review.tool, args);
  return {
    question:
      approvalQuestion({ tool: review.tool, args, accepted }) ??
      formatReviewQuestion(review.text),
    shortQuestion: `Approve the ${preview.subject}?`,
    callPreview: previewText({ preview, accepted }),
    header: "Approval",
    options,
    allowMultiple: false,
    remedy_offer_ids: [offerId],
  };
}

export async function recordHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
  ruling: HitlRuling;
}): Promise<boolean> {
  const recorded = await cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      // Validation and commit share the consumer's lock across replicas.
      const issued = await cache.get<{ offerId: string }>(
        stagePresenceKey(params.session, params.offerId),
      );
      if (issued?.offerId !== params.offerId) return false;
      const pending = await cache.getAndDelete<PendingHitlReview>(
        reviewKey(params.session, params.offerId),
      );
      // A genuine later denial can revoke an unspent approval; a timeout cannot.
      if (pending?.offerId !== params.offerId && params.ruling !== "deny")
        return false;
      await cache.set(
        rulingKey(params.session, params.offerId, params.ruling),
        { offerId: params.offerId, ruling: params.ruling },
        HITL_REVIEW_TTL_MS,
      );
      if (params.ruling !== "approve") {
        await cache.delete(
          rulingKey(params.session, params.offerId, "approve"),
        );
      }
      return true;
    },
  );
  if (!recorded) return false;
  logger.info(
    {
      sessionId: params.session.session_id,
      callerId: params.session.caller_id,
      ruling: params.ruling,
    },
    "OpenAPPA human-review ruling recorded",
  );
  return true;
}

export async function consumeHitlRuling(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<HitlRuling | undefined> {
  return cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      const keys = HITL_RULINGS.map((ruling) =>
        rulingKey(params.session, params.offerId, ruling),
      );
      const entries = new Map(
        (
          await cache.getAndDeleteMany<{
            offerId?: unknown;
            ruling?: unknown;
          }>(keys)
        ).map((entry) => [entry.key, entry.value]),
      );
      const recorded = HITL_RULINGS.filter((ruling) => {
        const entry = entries.get(
          rulingKey(params.session, params.offerId, ruling),
        );
        return entry?.offerId === params.offerId && entry.ruling === ruling;
      });
      const selected = recorded.includes("deny")
        ? "deny"
        : recorded.includes("none")
          ? "none"
          : recorded.includes("approve")
            ? "approve"
            : undefined;
      if (!selected) return undefined;
      await cache.delete(reviewKey(params.session, params.offerId));
      await cache.delete(stagePresenceKey(params.session, params.offerId));
      return selected;
    },
  );
}

export async function clearHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<void> {
  await cacheManager.withLock(
    stagePresenceKey(params.session, params.offerId),
    async (cache) => {
      await cache.getAndDeleteMany([
        reviewKey(params.session, params.offerId),
        stagePresenceKey(params.session, params.offerId),
        ...HITL_RULINGS.map((ruling) =>
          rulingKey(params.session, params.offerId, ruling),
        ),
      ]);
    },
  );
}

/**
 * Asks a pending review once more through the gateway's MCP form, where the
 * choice comes back as data. For an answer the proxy could not read.
 */
export async function askHitlReviewInForm(params: {
  session: OpenAppaSession;
  offerId: string;
}): Promise<void> {
  await cacheManager.set(
    formKey(params.session, params.offerId),
    { offerId: params.offerId },
    HITL_REVIEW_TTL_MS,
  );
}

export async function hitlReviewAskedInForm(params: {
  session: OpenAppaSession;
  offerIds: readonly string[];
}): Promise<boolean> {
  for (const offerId of params.offerIds) {
    const entry = await cacheManager.get<{ offerId: string }>(
      formKey(params.session, offerId),
    );
    if (entry?.offerId === offerId) return true;
  }
  return false;
}

export function hitlRulingFromLabels(
  labels: readonly string[],
): HitlRuling | undefined {
  if (labels.length !== 1) return undefined;
  if (labels[0] === "Approve") return "approve";
  if (labels[0] === "Deny") return "deny";
  return undefined;
}

/**
 * The review as one question: the call by the name the user knows it under,
 * its arguments as named values, and what an approval accepts besides the
 * person's attention, such as a wider audience. Undefined when the review
 * text's coverage is not in the shape read here, so the full text is shown
 * and nothing it covers is left out.
 */
function approvalQuestion(params: {
  tool: string;
  args: Record<string, unknown>;
  accepted: string[] | undefined;
}): string | undefined {
  if (!params.accepted) return undefined;
  const argumentLines = formatArgumentLines(params.args);
  return [
    `Approve ${reviewedToolLabel(params.tool)}?`,
    ...(argumentLines ? [argumentLines] : []),
    ...acceptedBlock(params.accepted),
    "Approve lets this exact call run. Deny keeps it blocked.",
  ].join("\n\n");
}

/**
 * What an approval accepts besides the person's attention, or undefined when
 * the review text's coverage is not in the shape read here.
 */
function acceptedCoverage(text: string): string[] | undefined {
  return reviewCoverage(text)?.filter(
    (line) => !line.startsWith("attention: "),
  );
}

function acceptedBlock(accepted: string[] | undefined): string[] {
  if (!accepted || accepted.length === 0) return [];
  return [
    ["Approving also accepts:", ...accepted.map((line) => `  - ${line}`)].join(
      "\n",
    ),
  ];
}

/**
 * The proxy evaluates command tools with `command` and `cmd` set to one value,
 * so policies match either spelling. The reviewer sees that value once.
 */
function withoutCommandAlias(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!isCommandExecutionTool(tool) || args.cmd !== args.command) return args;
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => name !== "cmd"),
  );
}

/** The runtime's "What this ruling would cover" lines, or undefined. */
function reviewCoverage(text: string): string[] | undefined {
  const lines = text.split("\n");
  const start = lines.indexOf(COVERAGE_HEADING);
  if (start < 0) return undefined;
  const coverage: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") return coverage;
    if (line === "  (none)") continue;
    if (!line.startsWith("  - ")) return undefined;
    coverage.push(line.slice("  - ".length));
  }
  return coverage;
}

const COVERAGE_HEADING = "What this ruling would cover:";

/**
 * The reviewed call as Claude Code previews it: a title naming the call, the
 * call in full, and what an approval also accepts. The preview has its own
 * code blocks, so Claude Code renders it as markdown.
 */
function previewText(params: {
  preview: CallPreview;
  accepted: string[] | undefined;
}): string {
  const accepted = params.accepted ?? [];
  return [
    `**${escapeMarkdown(params.preview.subject)}**`,
    ...params.preview.body,
    ...(accepted.length > 0
      ? [
          [
            "Approving also accepts:",
            ...accepted.map((line) => `- ${escapeMarkdown(line)}`),
          ].join("\n"),
        ]
      : []),
  ].join("\n\n");
}

type CallPreview = { subject: string; body: string[] };

/**
 * The call in the form a person reads it in. A command is shown exactly as
 * it runs, a file write as the file's content, an edit as a diff, and any
 * other call as its arguments in YAML. Nothing is wrapped or shortened: a
 * code block scrolls instead, and a line break could read as a new command.
 */
function callPreview(tool: string, args: Record<string, unknown>): CallPreview {
  const label = reviewedToolLabel(tool);
  const name = tool.replace(/^(builtin:|host\/[^/]+\/)/, "");
  const { command, description, file_path, content, old_string, new_string } =
    args;
  if (isCommandExecutionTool(tool) && typeof command === "string") {
    const summary =
      typeof description === "string"
        ? description.replace(/\s+/g, " ").trim()
        : "";
    return {
      subject: `${label} command`,
      body: [
        codeBlock(command, "sh"),
        ...(summary ? [`Description: ${escapeMarkdown(summary)}`] : []),
        ...argumentsBlock(
          without(args, summary ? ["command", "description"] : ["command"]),
        ),
      ],
    };
  }
  const subject = `${label} call`;
  if (typeof file_path === "string") {
    const file = `File: ${escapeMarkdown(file_path)}`;
    if (name === "Write" && typeof content === "string")
      return {
        subject,
        body: [
          file,
          codeBlock(content, languageOf(file_path)),
          ...argumentsBlock(without(args, ["file_path", "content"])),
        ],
      };
    if (
      name === "Edit" &&
      typeof old_string === "string" &&
      typeof new_string === "string"
    )
      return {
        subject,
        body: [
          file,
          codeBlock(diff(old_string, new_string), "diff"),
          ...argumentsBlock(
            without(args, ["file_path", "old_string", "new_string"]),
          ),
        ],
      };
    const edits = args.edits;
    if (name === "MultiEdit" && Array.isArray(edits) && edits.every(isEdit))
      return {
        subject,
        body: [
          file,
          ...edits.map((edit) =>
            codeBlock(diff(edit.old_string, edit.new_string), "diff"),
          ),
          ...argumentsBlock(without(args, ["file_path", "edits"])),
        ],
      };
  }
  const body = argumentsBlock(args);
  return {
    subject,
    body: body.length > 0 ? body : ["This call has no arguments."],
  };
}

/** The arguments as YAML in a block, or nothing when there are none. */
function argumentsBlock(args: Record<string, unknown>): string[] {
  if (Object.keys(args).length === 0) return [];
  // No folding: a folded line would read as a line break in the value.
  return [
    codeBlock(
      dumpYaml(args, { lineWidth: -1, noRefs: true }).trimEnd(),
      "yaml",
    ),
  ];
}

function without(
  args: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !names.includes(name)),
  );
}

function isEdit(
  value: unknown,
): value is { old_string: string; new_string: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).old_string === "string" &&
    typeof (value as Record<string, unknown>).new_string === "string"
  );
}

/** The replaced lines with "-", the new ones with "+". */
function diff(before: string, after: string): string {
  return [
    ...before.split("\n").map((line) => `-${line}`),
    ...after.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

/** A code block language from the file's extension, for highlighting only. */
function languageOf(path: string): string {
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1];
  return extension ? extension.toLowerCase() : "text";
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>#~|]/g, "\\$&");
}

/**
 * The text as a fenced block. Claude Code renders previews as markdown, so
 * outside a block it would drop the `**`, `__` and backticks of a reviewed
 * command. The fence is longer than any backtick run in the text, so the
 * text cannot end the block early.
 */
function codeBlock(text: string, language = "text"): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function formatReviewQuestion(text: string): string {
  // Native question renderers fold/indent rows independently, breaking pixel art.
  // Replace only the runtime's decorative prefix, never the reviewed payload.
  return text.startsWith(PIXEL_REVIEW_HEADING)
    ? `[OpenAPPA] Approve this call?\n${text.slice(PIXEL_REVIEW_HEADING.length)}`
    : text;
}

const PIXEL_REVIEW_HEADING =
  "\u2584\u2588\u2584\u2584\u2584\u2588\u2584  \u2580\u2580\u2588  Approve this call?\n" +
  "\u2588\u2588\u2584\u2588\u2584\u2588\u2588   \u2584   ";

function stagePresenceKey(
  session: OpenAppaSession,
  offerId: string,
): AllowedCacheKey {
  return scopedKey(
    CacheKey.OpenAppaHitlRuling,
    session,
    `${offerId}:stage-presence`,
  );
}

function formKey(session: OpenAppaSession, offerId: string): AllowedCacheKey {
  return scopedKey(CacheKey.OpenAppaHitlRuling, session, `${offerId}:form`);
}

function reviewKey(session: OpenAppaSession, offerId: string): AllowedCacheKey {
  return scopedKey(CacheKey.OpenAppaHitlReview, session, offerId);
}

function rulingKey(
  session: OpenAppaSession,
  offerId: string,
  ruling: HitlRuling,
): AllowedCacheKey {
  return scopedKey(
    CacheKey.OpenAppaHitlRuling,
    session,
    `${offerId}:${ruling}`,
  );
}

function scopedKey(
  prefix:
    | typeof CacheKey.OpenAppaHitlReview
    | typeof CacheKey.OpenAppaHitlRuling
    | typeof CacheKey.OpenAppaHitlReviewHistory,
  session: OpenAppaSession,
  offerId: string,
): AllowedCacheKey {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        session.organization_id,
        session.caller_id ?? "",
        session.session_id,
        session.parent_id ?? "",
        offerId,
      ]),
    )
    .digest("base64url");
  return `${prefix}-${scope}`;
}
