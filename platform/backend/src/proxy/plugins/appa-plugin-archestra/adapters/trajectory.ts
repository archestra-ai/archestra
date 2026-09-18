import { APPA_PARENT_HEADER, APPA_SESSION_HEADER } from "@archestra/shared";
import { ApiError } from "@/types";
import type { AppaChildTrajectory, AppaMatchContext } from "../types";
import { readHeader } from "../utils";

export function localToolName(name: string): string {
  const withoutFunctions = name.startsWith("functions.")
    ? name.slice("functions.".length)
    : name;
  for (const prefix of ["host/claude-code/", "builtin:", "host/"]) {
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
  agents.sort();
  const unique = [...new Set(agents)];
  return unique.map((agent) =>
    mintChildTrajectoryId({ parentId: params.rootId, childNativeId: agent }),
  );
}

export function bindMintedChildTrajectory(params: {
  context: AppaMatchContext;
  parentNativeId: string | undefined;
  childNativeId: string | undefined;
}): AppaChildTrajectory | undefined {
  const claimedSession = claimedHeader(params.context, APPA_SESSION_HEADER);
  const claimedParent = claimedHeader(params.context, APPA_PARENT_HEADER);
  const parentNativeId = nativeId(params.parentNativeId);
  const childNativeId = nativeId(params.childNativeId);

  if (!childNativeId) {
    if (claimedParent) {
      throw correlationError(
        "OpenAPPA child trajectory is missing a server-minted child id",
      );
    }
    return undefined;
  }
  if (!parentNativeId) {
    throw correlationError(
      "OpenAPPA child trajectory is missing a server-minted parent id",
    );
  }
  if (childNativeId === parentNativeId) {
    throw correlationError(
      "OpenAPPA child trajectory cannot reuse the parent id",
    );
  }

  const parentId = parentNativeId;
  const sessionId = mintChildTrajectoryId({
    parentId,
    childNativeId,
  });
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

function claimedHeader(
  context: AppaMatchContext,
  name: string,
): string | undefined {
  return nativeId(readHeader(context.headers, name));
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
    while (length < rest.length && isIdChar(rest[length] ?? "")) length += 1;
    const id = rest.slice(0, length);
    const tail = rest.slice(length);
    if (
      id.length > 0 &&
      tail.startsWith(suffix) &&
      !isNameChar(tail[suffix.length] ?? "")
    ) {
      ids.push(id);
    }
    from = at + prefix.length;
  }
  return ids;
}
