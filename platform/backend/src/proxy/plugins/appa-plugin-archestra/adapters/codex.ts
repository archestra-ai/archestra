import { codexClientMetadataSessionId } from "@archestra/shared";
import type { AppaClientAdapter, AppaMatchContext } from "../types";
import { readHeader } from "../utils";
import {
  asRecord,
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  parseJsonHeader,
  stringField,
} from "./trajectory";

const SPAWN_TOOLS = new Set(["spawn_agent"]);
const CHILD_ID_KEYS = ["agent_id", "thread_id", "receiver_thread_id"] as const;

/** Identifies Codex Responses requests and normalizes local tool names. */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex" as const;
  readonly trajectoryPrefix = "codex";

  matches(context: AppaMatchContext): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("codex") ||
      originator.includes("codex") ||
      readHeader(context.headers, "x-codex-turn-metadata") !== undefined
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp:") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    // Codex decorates local function tools with `functions.` before its native
    // namespace, so remove that decoration before preserving the native name.
    const stripped = name.startsWith("functions.")
      ? name.slice("functions.".length)
      : name;
    return stripped.startsWith("builtin:") || stripped.startsWith("host/")
      ? stripped
      : `builtin:${stripped}`;
  }

  isSpawnTool(name: string): boolean {
    return SPAWN_TOOLS.has(localToolName(name));
  }

  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments: params.arguments,
      pathPatterns: [],
      idKeys: CHILD_ID_KEYS,
    });
  }

  bindChildTrajectory(context: AppaMatchContext) {
    const parentNativeId = parentThreadId(context);
    const childNativeId = childThreadId(context, parentNativeId);
    return bindMintedChildTrajectory({
      context,
      parentNativeId,
      childNativeId,
    });
  }
}

function parentThreadId(context: AppaMatchContext): string | undefined {
  const turn = parseJsonHeader(context.headers, "x-codex-turn-metadata");
  const parent =
    stringField(turn?.parent_thread_id) ?? stringField(turn?.parent_id);
  if (parent) return parent;
  const body = asRecord(context.requestBody);
  const metadata = asRecord(body?.client_metadata) ?? asRecord(body?.metadata);
  return (
    stringField(metadata?.parent_thread_id) ??
    stringField(metadata?.thread_id) ??
    stringField(body?.prompt_cache_key) ??
    codexClientMetadataSessionId(body?.client_metadata) ??
    undefined
  );
}

function childThreadId(
  context: AppaMatchContext,
  parentNativeId: string | undefined,
): string | undefined {
  const turn = parseJsonHeader(context.headers, "x-codex-turn-metadata");
  const child =
    stringField(turn?.agent_id) ??
    stringField(turn?.thread_id) ??
    stringField(turn?.session_id);
  if (child && child !== parentNativeId) return child;
  const body = asRecord(context.requestBody);
  const metadata = asRecord(body?.client_metadata) ?? asRecord(body?.metadata);
  const fromMetadata =
    stringField(metadata?.agent_id) ?? stringField(metadata?.child_thread_id);
  return fromMetadata && fromMetadata !== parentNativeId
    ? fromMetadata
    : undefined;
}
