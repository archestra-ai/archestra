import type { AppaClientAdapter, AppaMatchContext } from "../types";
import { readHeader } from "../utils";
import {
  asRecord,
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  stringField,
} from "./trajectory";

const SPAWN_TOOLS = new Set(["task"]);
const CHILD_ID_KEYS = ["task_id", "session_id", "sessionID"] as const;

/** Identifies OpenCode Chat Completions requests and normalizes local tool names. */
export class AppaOpenCodeAdapter implements AppaClientAdapter {
  readonly id = "opencode" as const;
  readonly trajectoryPrefix = "opencode";

  matches(context: AppaMatchContext): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("opencode") ||
      originator.includes("opencode") ||
      readHeader(context.headers, "x-opencode-session") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp:") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name.startsWith("builtin:") || name.startsWith("host/")
      ? name
      : `builtin:${name}`;
  }

  isSpawnTool(name: string): boolean {
    return SPAWN_TOOLS.has(localToolName(name));
  }

  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    const prefix = `${params.rootId}:`;
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments: params.arguments,
      pathPatterns: [],
      idKeys: CHILD_ID_KEYS,
    }).filter((child) => {
      const native = child.startsWith(prefix)
        ? child.slice(prefix.length)
        : child;
      return native !== params.rootId;
    });
  }

  bindChildTrajectory(context: AppaMatchContext) {
    const parentNativeId = parentSessionId(context);
    const childNativeId = childSessionId(context, parentNativeId);
    return bindMintedChildTrajectory({
      context,
      parentNativeId,
      childNativeId,
    });
  }
}

function parentSessionId(context: AppaMatchContext): string | undefined {
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const namedParent =
    stringField(metadata?.parent_id) ??
    stringField(metadata?.parentID) ??
    stringField(metadata?.parent_session_id);
  if (namedParent) return namedParent;
  const session = readHeader(context.headers, "x-opencode-session");
  const affinity = readHeader(context.headers, "x-session-id");
  if (affinity && session && affinity !== session) return affinity;
  return affinity ?? session;
}

function childSessionId(
  context: AppaMatchContext,
  parentNativeId: string | undefined,
): string | undefined {
  const session = readHeader(context.headers, "x-opencode-session");
  if (session && session !== parentNativeId) return session;
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const child =
    stringField(metadata?.task_id) ??
    stringField(metadata?.session_id) ??
    stringField(asRecord(context.requestBody)?.prompt_cache_key);
  return child && child !== parentNativeId ? child : undefined;
}
