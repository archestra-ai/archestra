import { posix } from "node:path";
import { APPA_PARENT_HEADER, APPA_SESSION_HEADER } from "@archestra/shared";
import { verifyChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { verifyDelegationMarker } from "@/openappa/delegation";
import { isWellFormedAppaId } from "@/openappa/service";
import { ApiError } from "@/types";
import type { AppaChildTrajectory, AppaMatchContext } from "../types";
import { readHeader, withCallerScope } from "../utils";

/** Recognizes native transcript paths even when their child id is a glob. */
export function referencesChildTranscriptPath(params: {
  arguments: unknown;
  pathPatterns: ReadonlyArray<{ prefix: string; suffix: string }>;
}): boolean {
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") {
      // Tokenizes once to prevent quadratic scanning.
      // Normalizes path separators and relative segments before inspection.
      return value.split(/\s+/u).some((token) => {
        const path = posix.normalize(token.replaceAll("\\", "/"));
        return params.pathPatterns.some(({ prefix, suffix }) => {
          const start = path.indexOf(prefix);
          return start >= 0 && path.indexOf(suffix, start + prefix.length) >= 0;
        });
      });
    }
    if (Array.isArray(value)) return value.some(visit);
    const record = asRecord(value);
    return record !== undefined && Object.values(record).some(visit);
  };
  return visit(params.arguments);
}

export function localToolName(name: string): string {
  const withoutFunctions = name.startsWith("functions.")
    ? name.slice("functions.".length)
    : name;
  for (const prefix of [
    "host/claude-code/",
    "host/archestra/",
    "builtin:",
    "host/",
  ]) {
    if (withoutFunctions.startsWith(prefix)) {
      return withoutFunctions.slice(prefix.length);
    }
  }
  return withoutFunctions;
}

export function namesChildrenFromArguments(params: {
  rootId: string;
  arguments: unknown;
  pathPatterns: ReadonlyArray<{ prefix: string; suffix: string }>;
  idKeys?: readonly string[];
}): string[] {
  const agents: string[] = [];
  collectNamedChildren(
    params.arguments,
    agents,
    params.pathPatterns,
    params.idKeys,
  );
  const rootNativeId = params.rootId.slice(params.rootId.lastIndexOf(":") + 1);
  const unique = [...new Set(agents)].filter(
    (agent) => agent !== params.rootId && agent !== rootNativeId,
  );
  unique.sort();
  return unique.map((agent) =>
    mintChildTrajectoryId({ parentId: params.rootId, childNativeId: agent }),
  );
}

/**
 * Binds a child under verified trajectory evidence or trusted native metadata.
 * The signed child ID stays stable when native metadata appears after compaction.
 * An actual native child ID is optional correlation metadata.
 */
export function bindMintedChildTrajectory(params: {
  context: AppaMatchContext;
  parentNativeId: string | undefined;
  childNativeId: string | undefined;
}): AppaChildTrajectory | undefined {
  const claims = claimedIds(params.context);
  const childNativeId = nativeId(params.childNativeId);
  const parentNativeId =
    nativeId(params.parentNativeId) ??
    recordedNativeParent({ context: params.context, childNativeId });

  if (!parentNativeId) {
    if (!childNativeId && !claims.parentId) return undefined;
    throw correlationError(
      "OpenAPPA child trajectory is missing a server-minted parent id",
    );
  }
  if (childNativeId === parentNativeId) {
    throw correlationError(
      "OpenAPPA child trajectory cannot reuse the parent id",
    );
  }

  const delegated = delegatedParent({
    context: params.context,
    parentNativeId,
    childNativeId,
  });
  const recorded = recordedChild({
    context: params.context,
    parentNativeId,
    childNativeId,
    expectedParentId: delegated?.parentId,
  });
  const parentId = delegated?.parentId ?? recorded?.parentId ?? parentNativeId;
  const sessionId =
    recorded?.childId ??
    (childNativeId
      ? mintChildTrajectoryId({ parentId, childNativeId })
      : delegated?.spawnCallId
        ? mintChildTrajectoryId({
            parentId,
            childNativeId: delegated.spawnCallId,
          })
        : undefined);
  if (!sessionId) {
    if (claims.parentId) {
      throw correlationError(
        "OpenAPPA child trajectory is missing a server-minted child id",
      );
    }
    return undefined;
  }
  const resolvedChildNativeId = childNativeId ?? recorded?.childNativeId;
  return {
    ...bindChildLineage({ context: params.context, parentId, sessionId }),
    lineage: {
      source: recorded ? "receipt" : delegated ? "marker" : "native",
      nativeParentId: parentNativeId,
      ...(resolvedChildNativeId
        ? { childNativeId: resolvedChildNativeId }
        : {}),
      ...(delegated?.spawnCallId
        ? { spawnCallId: delegated.spawnCallId }
        : recorded?.spawnCallId
          ? { spawnCallId: recorded.spawnCallId }
          : {}),
    },
  };
}

/**
 * Validates an exact server-minted parent and child binding against claims.
 */
function bindChildLineage(params: {
  context: AppaMatchContext;
  parentId: string;
  sessionId: string;
}): { sessionId: string; parentId: string } {
  const { parentId, sessionId } = params;
  const claims = claimedIds(params.context);
  const claimedSession = claims.sessionId;
  const claimedParent = claims.parentId;
  const prefix = `${parentId}:`;
  const childIdentity = sessionId.startsWith(prefix)
    ? sessionId.slice(prefix.length)
    : undefined;
  if (
    !childIdentity ||
    `:${parentId}:`.includes(`:${childIdentity}:`) ||
    sessionId === parentId
  ) {
    throw correlationError(
      "OpenAPPA child trajectory cannot reuse the parent id",
    );
  }
  const session = params.context.trustedContext?.session;
  if (
    !isWellFormedAppaId(
      session ? withCallerScope(session, sessionId) : sessionId,
    )
  ) {
    throw correlationError(
      "OpenAPPA child trajectory exceeds the session id limit",
    );
  }
  if (claimedParent && claimedParent !== parentId) {
    throw correlationError(
      "OpenAPPA parent trajectory is not bound to this server-minted root",
    );
  }
  if (claimedSession && claimedSession !== sessionId) {
    throw correlationError(
      "OpenAPPA child trajectory does not match the server-minted child id",
    );
  }
  if (claimedSession === parentId) {
    throw correlationError(
      "OpenAPPA child trajectory cannot reuse the parent id",
    );
  }
  return { sessionId, parentId };
}

export function stripRecordFields(
  value: unknown,
  keys: readonly string[],
): void {
  const record = asRecord(value);
  if (!record) return;
  for (const key of keys) {
    delete record[key];
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseJsonHeader(
  headers: AppaMatchContext["headers"],
  name: string,
): Record<string, unknown> | undefined {
  const raw = readHeader(headers, name);
  if (!raw) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Recovers a client parent only from a verified full receipt. */
function recordedNativeParent(params: {
  context: AppaMatchContext;
  childNativeId: string | undefined;
}): string | undefined {
  const trusted = params.context.trustedContext;
  if (!trusted) return undefined;
  for (const receipt of trusted.request.childTrajectoryReceipts ?? []) {
    const spawnerNativeId = nativeId(receipt.spawnerNativeId);
    if (
      spawnerNativeId &&
      verifyChildTrajectoryReceipt({
        receipt,
        organizationId: trusted.session.organization_id,
        callerId: trusted.session.caller_id,
        spawnerNativeId,
        childNativeId: params.childNativeId,
      })
    ) {
      return spawnerNativeId;
    }
  }
  return undefined;
}

/** Reads a signed child binding preserved across compaction. */
function recordedChild(params: {
  context: AppaMatchContext;
  parentNativeId: string;
  childNativeId: string | undefined;
  expectedParentId: string | undefined;
}):
  | {
      parentId: string;
      childId: string;
      childNativeId?: string;
      spawnCallId?: string;
    }
  | undefined {
  const trusted = params.context.trustedContext;
  if (!trusted) return undefined;
  for (const receipt of trusted.request.childTrajectoryReceipts ?? []) {
    if (
      !verifyChildTrajectoryReceipt({
        receipt,
        organizationId: trusted.session.organization_id,
        callerId: trusted.session.caller_id,
        spawnerNativeId: params.parentNativeId,
        childNativeId: params.childNativeId,
      })
    ) {
      continue;
    }
    if (params.expectedParentId && receipt.parentId !== params.expectedParentId)
      continue;
    return {
      parentId: receipt.parentId,
      childId: receipt.childId,
      ...(receipt.childNativeId
        ? { childNativeId: receipt.childNativeId }
        : {}),
      ...(receipt.spawnCallId ? { spawnCallId: receipt.spawnCallId } : {}),
    };
  }
  return undefined;
}

/**
 * Finds the delegation marker in opening user messages signed for the native parent.
 * Inspecting only opening messages prevents later reminders or notifications
 * from altering child lineage.
 */
function delegatedParent(params: {
  context: AppaMatchContext;
  parentNativeId: string;
  childNativeId: string | undefined;
}): { parentId: string; spawnCallId?: string } | undefined {
  const trusted = params.context.trustedContext;
  if (!trusted) return undefined;
  for (const marker of trusted.request.delegation?.markers ?? []) {
    if (
      !verifyDelegationMarker({
        marker,
        organizationId: trusted.session.organization_id,
        callerId: trusted.session.caller_id,
        spawnerNativeId: params.parentNativeId,
      })
    )
      continue;
    const childIdentity = params.childNativeId ?? marker.spawnCallId;
    if (childIdentity && `:${marker.parentId}:`.includes(`:${childIdentity}:`))
      continue;
    return {
      parentId: marker.parentId,
      ...(marker.spawnCallId ? { spawnCallId: marker.spawnCallId } : {}),
    };
  }
  return undefined;
}

/** Returns explicit IDs claimed by the client, excluding derived proxy IDs. */
function claimedIds(context: AppaMatchContext): {
  sessionId?: string;
  parentId?: string;
} {
  const claims = context.trustedContext?.claims;
  return {
    sessionId: nativeId(
      claims
        ? claims.sessionId
        : readHeader(context.headers, APPA_SESSION_HEADER),
    ),
    parentId: nativeId(
      claims
        ? claims.parentId
        : readHeader(context.headers, APPA_PARENT_HEADER),
    ),
  };
}

function nativeId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /\p{Cc}/u.test(value)
  ) {
    throw correlationError(
      "OpenAPPA requires a well-formed child trajectory id",
    );
  }
  return value;
}

function correlationError(message: string): ApiError {
  return new ApiError(400, message);
}

function mintChildTrajectoryId(params: {
  parentId: string;
  childNativeId: string;
}): string {
  return `${params.parentId}:${params.childNativeId}`;
}

function collectNamedChildren(
  value: unknown,
  agents: string[],
  pathPatterns: ReadonlyArray<{ prefix: string; suffix: string }>,
  idKeys: readonly string[] | undefined,
): void {
  if (typeof value === "string") {
    for (const pattern of pathPatterns) {
      agents.push(...agentFileIds(value, pattern.prefix, pattern.suffix));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNamedChildren(item, agents, pathPatterns, idKeys);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, field] of Object.entries(record)) {
    if (idKeys?.includes(key)) {
      const id = stringField(field);
      if (id) agents.push(id);
    }
    collectNamedChildren(field, agents, pathPatterns, idKeys);
  }
}

function agentFileIds(text: string, prefix: string, suffix: string): string[] {
  const isIdChar = (c: string) => /[A-Za-z0-9_-]/.test(c);
  const isNameChar = (c: string) => isIdChar(c) || c === ".";
  const ids: string[] = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(prefix, from);
    if (at === -1) break;
    const previous = at === 0 ? undefined : text[at - 1];
    if (previous && isNameChar(previous)) {
      from = at + prefix.length;
      continue;
    }
    const rest = text.slice(at + prefix.length);
    let length = 0;
    while (length < rest.length && isIdChar(rest.charAt(length))) length += 1;
    const id = rest.slice(0, length);
    const tail = rest.slice(length);
    if (
      id.length > 0 &&
      tail.startsWith(suffix) &&
      !isNameChar(tail.charAt(suffix.length))
    ) {
      ids.push(id);
    }
    from = at + prefix.length;
  }
  return ids;
}
