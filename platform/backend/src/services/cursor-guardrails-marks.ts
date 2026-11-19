import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import OpenAppaSessionModel from "@/models/openappa-session";
import type { OpenAppaSession } from "@/openappa/service";
import {
  formatReceiptMark,
  formatSessionReceipt,
  receiptCodeOf,
} from "@/openappa/session-token";

/**
 * The marks a person sees in a Cursor chat that Guardrails check.
 *
 * For other clients the LLM proxy writes these marks into the model's reply.
 * A chat on one of Cursor's own models never passes through the proxy, and
 * Cursor gives a hook no way to show text in a chat: every hook answer either
 * blocks something or reaches the model only. So the model is told to show
 * the mark, and the answer Cursor reports afterwards says whether it did.
 *
 * A mark shows where its subject speaks: the session mark in the main chat,
 * a subagent's marks in that subagent's own view.
 *
 * Each mark is asked for as a small Markdown heading. Cursor renders answers
 * as Markdown, which joins two marks on neighbouring lines, or a mark and the
 * text under it, into one line unless the model leaves an empty line between
 * them, and a model often does not. A heading is a line of its own either
 * way.
 *
 * The one place a hook can tell the model anything is the context after a
 * tool result: Cursor 3.30 does not pass a new chat's opening context from
 * `sessionStart` on to the model. A chat therefore shows its session mark in
 * the first answer that follows a tool call, and a chat that calls no tool,
 * where Guardrails have nothing to check, shows none.
 */

/**
 * The request to show the chat's session mark, on each of the main agent's
 * tool results until an answer shows it. The first result says why; each
 * later one repeats the line, so the result that comes last before the
 * answer carries it too. A request made once, many tool calls before the
 * answer, was sometimes forgotten by then.
 */
export async function sessionMarkContext(
  session: OpenAppaSession,
): Promise<string | undefined> {
  const owed = await cacheManager.get<OwedMark>(owedMarkKey(session));
  if (owed)
    return `${guardrails()}: start your next answer to the person with this exact line, ${OWN_LINE}, unless an answer of yours in this chat already shows it: ${asOwnLine(owed.line)}`;
  if (await cacheManager.get<true>(sessionMarkAskedKey(session)))
    return undefined;
  const receipt = await OpenAppaSessionModel.ensureReceiptToken({
    organizationId: session.organization_id,
    sessionId: session.session_id,
  });
  // No record yet: the runtime has not seen this session, so the next
  // result asks again.
  if (!receipt) return undefined;
  await cacheManager.set<true>(
    sessionMarkAskedKey(session),
    true,
    SESSION_MARK_ASKED_LIFETIME_MS,
  );
  if (receipt.receiptIssuedAt) return undefined;
  const line = formatSessionReceipt(receipt.token);
  await cacheManager.set<OwedMark>(
    owedMarkKey(session),
    { line, missed: 0 },
    OWED_MARK_LIFETIME_MS,
  );
  return `${guardrails()} check this chat's tool calls. Show the person this exact line once, ${OWN_LINE}, at the start of your next answer to them, and do not repeat it later: ${asOwnLine(line)}`;
}

/**
 * What a subagent is told to show in its own view, the first time one of its
 * tool calls reports: the mark that it started, now, and the mark that it
 * finished, as the last line of its reply, so the view ends on it. A subagent that calls no tool shows
 * neither, and has nothing for Guardrails to check.
 *
 * Cursor reports no answer of a subagent to a hook, so these two marks are
 * asked for once and not checked.
 */
export async function subagentMarkContext(params: {
  session: OpenAppaSession;
  subagentId: string;
}): Promise<string | undefined> {
  const key = subagentMarkAskedKey(params.session, params.subagentId);
  if (await cacheManager.get<true>(key)) return undefined;
  // Marks are for a session the runtime knows, like the session mark itself.
  const known = await OpenAppaSessionModel.find({
    organizationId: params.session.organization_id,
    sessionId: params.session.session_id,
  });
  if (!known) return undefined;
  await cacheManager.set<true>(key, true, SUBAGENT_MARK_ASKED_LIFETIME_MS);
  const code = receiptCodeOf(
    createHash("sha256")
      .update(
        JSON.stringify([
          params.session.organization_id,
          params.session.session_id,
          params.subagentId,
        ]),
      )
      .digest(),
  );
  const started = formatReceiptMark(MARK_LABEL_STARTED, code);
  const finished = formatReceiptMark(MARK_LABEL_FINISHED, code);
  return `${guardrails()} check this subagent's tool calls in its chat's session. Show this exact line, ${OWN_LINE}, at the start of your next message: ${asOwnLine(started)} End your final reply with this exact line, ${OWN_LINE}, as its last line after everything else: ${asOwnLine(finished)} Both lines are Guardrails marks, not part of your answer: show them even when your task asks for an exact reply, with the reply your task asks for between them.`;
}

/**
 * What the agent that started a subagent is told about the marks in that
 * subagent's reply, which Cursor hands over as written. A foreground
 * subagent has replied by the time its `Task` call reports; a background
 * one replies later.
 */
export async function subagentReplyNote(params: {
  session: OpenAppaSession;
  subagentId: string;
  background: boolean;
}): Promise<string | undefined> {
  if (
    !params.background &&
    !(await cacheManager.get<true>(
      subagentMarkAskedKey(params.session, params.subagentId),
    ))
  )
    return undefined;
  return `${guardrails()}: this subagent's reply ${params.background ? "may carry" : "carries"} lines that read "${MARK_LABEL_STARTED}" or "${MARK_LABEL_FINISHED}" after a block mark, the second as its last line. Those lines are Guardrails marks for the person who opens the subagent's view, not part of its answer: leave them out when you use or quote the reply.`;
}

/**
 * Reads the answer Cursor reports at the end of the main agent's loop. An
 * answer that shows the session mark settles it. After a few answers without
 * it the chat is no longer asked.
 */
export async function settleMarks(
  session: OpenAppaSession,
  answer: string,
): Promise<void> {
  const owed = await cacheManager.get<OwedMark>(owedMarkKey(session));
  if (!owed) return;
  if (showsMark(answer, owed.line)) {
    await OpenAppaSessionModel.markReceiptIssued({
      organizationId: session.organization_id,
      sessionId: session.session_id,
    });
    await cacheManager.delete(owedMarkKey(session));
    return;
  }
  const missed = owed.missed + 1;
  if (missed > MAX_ANSWERS_WITHOUT_MARK) {
    logger.info(
      { sessionId: session.session_id },
      "A Cursor chat did not show its Guardrails session mark",
    );
    await cacheManager.delete(owedMarkKey(session));
    return;
  }
  await cacheManager.set<OwedMark>(
    owedMarkKey(session),
    { ...owed, missed },
    OWED_MARK_LIFETIME_MS,
  );
}

// === Internal helpers ===

/** The session mark the model was told to show and no reported answer has shown yet. */
type OwedMark = {
  line: string;
  /** Answers that ended without showing it. */
  missed: number;
};

const OWN_LINE = "on a line of its own and with its six # signs";

/** A mark as the model is asked to write it: see the note on headings above. */
function asOwnLine(mark: string): string {
  return `###### ${mark}`;
}

const MARK_LABEL_STARTED = "started subagent";
const MARK_LABEL_FINISHED = "finished subagent";
const SUBAGENT_MARK_ASKED_LIFETIME_MS = TimeInMs.Day * 7;
const MAX_ANSWERS_WITHOUT_MARK = 2;
const OWED_MARK_LIFETIME_MS = TimeInMs.Day;
// A chat is asked once; the session's record keeps whether it showed the mark.
const SESSION_MARK_ASKED_LIFETIME_MS = TimeInMs.Day * 30;

/**
 * Whether an answer shows a mark. A webview can join the mark's two spaces or
 * wrap the line in emphasis, so what counts is the label and its code.
 */
function showsMark(answer: string, line: string): boolean {
  const [label, code] = [
    line.slice(0, line.lastIndexOf(" ")),
    line.slice(line.lastIndexOf(" ") + 1),
  ];
  const words = label.replace(/^\S+\s+/, "");
  return new RegExp(
    `${escapeRegExp(words)}\\s+\\W{0,2}${escapeRegExp(code)}`,
  ).test(answer);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function owedMarkKey(session: OpenAppaSession): AllowedCacheKey {
  return `${CacheKey.CursorOwedMarks}-${sessionDigest(session)}`;
}

function sessionMarkAskedKey(session: OpenAppaSession): AllowedCacheKey {
  return `${CacheKey.CursorSessionMarkAsked}-${sessionDigest(session)}`;
}

function subagentMarkAskedKey(
  session: OpenAppaSession,
  subagentId: string,
): AllowedCacheKey {
  return `${CacheKey.CursorSubagentMarkAsked}-${createHash("sha256")
    .update(
      JSON.stringify([session.organization_id, session.session_id, subagentId]),
    )
    .digest("base64url")}`;
}

function sessionDigest(session: OpenAppaSession): string {
  return createHash("sha256")
    .update(JSON.stringify([session.organization_id, session.session_id]))
    .digest("base64url");
}

/** The product's name in a message to the model: a deployment can carry its own. */
function guardrails(): string {
  return `${archestraMcpBranding.appName} Guardrails`;
}
