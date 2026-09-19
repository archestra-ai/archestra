import { createHash } from "node:crypto";
import { OpenAppaContextAnchorModel } from "@/models";
import OpenAppaSessionModel from "@/models/openappa-session";
import { clientSessionId } from "./actor";
import type { OpenAppaSession } from "./service";
import {
  type AppaWireFamily,
  historyTexts,
  requestTexts,
  responseTexts,
} from "./wire";

/**
 * Context anchors follow a session's context where its stamped tool calls do
 * not: a history compacted to a text summary, or a summary handed to a session
 * of its own, carries no call ids, but it does carry lines the session's model
 * wrote. Each substantial line of a response is recorded, as a digest, for the
 * session that produced it; a new session whose history repeats those lines
 * replays that session's context and opens as a fork of it. Clients reformat a
 * summary around its lines (a heading, a preamble, tags dropped) but keep the
 * lines themselves, so matching is per line rather than per message.
 */
export async function recordResponseAnchors(params: {
  session: OpenAppaSession;
  family: AppaWireFamily;
  requestBody: unknown;
  response: unknown;
}): Promise<void> {
  const callerId = params.session.caller_id;
  if (!callerId) return;
  const requestDigests = new Set(lineDigests(requestTexts(params.requestBody)));
  const digests = lineDigests(responseTexts(params))
    .filter((digest) => !requestDigests.has(digest))
    .slice(0, MAX_RECORDED_LINES);
  if (digests.length === 0) return;
  await OpenAppaContextAnchorModel.record({
    organizationId: params.session.organization_id,
    callerId,
    sessionId: params.session.session_id,
    digests,
  });
}

/**
 * The caller's sessions whose lines this history repeats, as client session
 * ids, each once, ordered by where its lines last appear: the last one wrote
 * the history's most recent content. A session needs two distinct, uniquely
 * owned matching lines; one line is too weak to identify a fork parent.
 */
export async function anchoredSessions(params: {
  organizationId: string;
  callerId: string;
  family: AppaWireFamily;
  body: unknown;
}): Promise<string[]> {
  const digests = tailLineDigests(historyTexts(params), MAX_LOOKED_UP_LINES);
  if (digests.length === 0) return [];
  const owners = await OpenAppaContextAnchorModel.sessionsFor({
    organizationId: params.organizationId,
    callerId: params.callerId,
    digests,
  });
  const started = await OpenAppaSessionModel.startedSessionIds({
    organizationId: params.organizationId,
    sessionIds: [...new Set([...owners.values()].flat())],
  });
  const matches = new Map<string, number>();
  for (const digest of digests) {
    const writers = owners.get(digest)?.filter((writer) => started.has(writer));
    if (writers?.length !== 1) continue;
    const session = clientSessionId(writers[0]);
    matches.set(session, (matches.get(session) ?? 0) + 1);
  }
  const sessions = new Set<string>();
  for (const digest of digests) {
    const writers = owners.get(digest)?.filter((writer) => started.has(writer));
    if (writers?.length !== 1) continue;
    const session = clientSessionId(writers[0]);
    if ((matches.get(session) ?? 0) < MIN_MATCHING_LINES) continue;
    sessions.delete(session);
    sessions.add(session);
  }
  return [...sessions];
}

// === Internal helpers ===

/** Shorter lines are too likely to repeat across unrelated sessions. */
const MIN_LINE_LENGTH = 64;
/** A response records at most this many lines. */
const MAX_RECORDED_LINES = 128;
/** A history is matched on at most its latest this many lines. */
const MAX_LOOKED_UP_LINES = 512;

/** Digests of the substantial lines of `texts`, each once, in order of last appearance. */
function lineDigests(texts: readonly string[]): string[] {
  const digests = new Set<string>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const normalized = line.replace(/\s+/g, " ").trim();
      if (normalized.length < MIN_LINE_LENGTH) continue;
      const digest = createHash("sha256").update(normalized).digest("hex");
      digests.delete(digest);
      digests.add(digest);
    }
  }
  return [...digests];
}

/** The latest distinct anchor lines, without hashing older history first. */
function tailLineDigests(texts: readonly string[], limit: number): string[] {
  const digests = new Set<string>();
  for (let textIndex = texts.length - 1; textIndex >= 0; textIndex--) {
    const lines = texts[textIndex].split("\n");
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
      const normalized = lines[lineIndex].replace(/\s+/g, " ").trim();
      if (normalized.length < MIN_LINE_LENGTH) continue;
      const digest = createHash("sha256").update(normalized).digest("hex");
      if (digests.has(digest)) continue;
      digests.add(digest);
      if (digests.size === limit) return [...digests].reverse();
    }
  }
  return [...digests].reverse();
}

/** Require more than one independently matching line to name a parent. */
const MIN_MATCHING_LINES = 2;
