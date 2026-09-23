import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types";
import type { CommonToolResult } from "@/types/common-llm-format";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaSpawnPromptField,
  AskUserArguments,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import { openCodeQuestionRuling } from "./native-question-ruling";

// OpenCode labels each question's tab with a header of at most 30 characters,
// the same bound ask_user declares for it.
const QUESTION_HEADER_MAX_LENGTH = 30;

import {
  asRecord,
  bindMintedChildTrajectory,
  namesChildrenFromArguments,
  stringField,
  stripRecordFields,
} from "./trajectory";

/** A skill runs in the current session. A task opens a child session. */
const CHILD_SPAWN_TOOLS = new Set(["task"]);
const CHILD_ID_KEYS = ["task_id", "session_id", "sessionID"] as const;

/** Identifies OpenCode Chat Completions requests and normalizes local tool names. */
export class AppaOpenCodeAdapter implements AppaClientAdapter {
  readonly id = "opencode" as const;
  readonly trajectoryPrefix = "opencode";
  // OpenCode shows no MCP forms (its client declares no elicitation), but its
  // own `question` tool renders one.
  readonly nativeQuestion = {
    toolName: "question",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          header: questionHeader(args.header, QUESTION_HEADER_MAX_LENGTH),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
          multiple: args.allowMultiple === true,
        },
      ],
    }),
    rulingFromResult: openCodeQuestionRuling,
  };

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
    // OpenCode formats MCP tools as `<alias>_<advertised name>` under `mcp:` namespaces.
    // Gateway tool names use the `<server>__<tool>` format.
    // Native OpenCode tools (such as `bash` or `read`) do not contain these patterns.
    return name.startsWith("mcp:") || name.includes("__") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    // `builtin:` is OpenCode's local-tool decoration. The embedded runtime
    // derives the bare spelling to host/archestra/<name> itself.
    return name.startsWith("builtin:") ? name.slice("builtin:".length) : name;
  }

  /**
   * Extracts OpenCode session identity from request headers.
   * Checks X-Session-Id, x-session-affinity, session-id, and x-opencode-session.
   * Treats X-Session-Id as the parent when x-opencode-session names a child.
   * Rejects contradictory headers that claim the same role.
   */
  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const claims = OPENCODE_SESSION_HEADERS.flatMap((header) => {
      const value = readHeader(context.headers, header);
      return value ? [value] : [];
    });
    const hosted = readHeader(context.headers, "x-opencode-session");
    const explicitParent = readHeader(context.headers, "x-session-id");
    const [normal] = claims;
    if (claims.some((claim) => claim !== normal)) {
      throw new ApiError(
        400,
        "OpenAPPA cannot bind contradictory OpenCode session headers",
      );
    }
    if (normal && hosted && normal !== hosted) {
      if (explicitParent === normal) {
        return { sessionId: hosted, provenance: "opencode-hosted-header" };
      }
      throw new ApiError(
        400,
        "OpenAPPA cannot bind contradictory OpenCode session headers",
      );
    }
    if (normal) {
      return { sessionId: normal, provenance: "opencode-session-header" };
    }
    return hosted
      ? { sessionId: hosted, provenance: "opencode-hosted-header" }
      : undefined;
  }

  isSpawnTool(name: string, namespace?: string): boolean {
    // OpenCode declares its native tools without a wire namespace, so any
    // namespace is foreign (it also speaks the Responses wire, where MCP
    // servers declare `mcp__<server>` namespaces). Other clients' spellings
    // (`functions.`, `host/claude-code/`, bare `host/`) are foreign too: only
    // OpenCode's own decorations reduce to the native name.
    return (
      namespace === undefined &&
      CHILD_SPAWN_TOOLS.has(nativeOpenCodeToolName(name))
    );
  }

  isChildCompletionResult(result: CommonToolResult): boolean {
    return this.isSpawnTool(result.name, result.namespace) && !result.isError;
  }

  spawnPromptField(
    name: string,
    _args?: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined {
    return CHILD_SPAWN_TOOLS.has(nativeOpenCodeToolName(name))
      ? { field: "prompt", kind: "text" }
      : undefined;
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    // The request session, which child subagents name as their parent.
    return (
      readHeader(context.headers, "x-opencode-session") ??
      readHeader(context.headers, "x-session-id") ??
      readHeader(context.headers, "x-session-affinity")
    );
  }

  nativeSpawnParentId(
    context: AppaMatchContext,
    sessionId: string,
  ): string | undefined {
    const parent = parentSessionId(context);
    return parent && parent !== sessionId ? parent : undefined;
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
    const parentNativeId = parentSessionId(context);
    const childNativeId = childSessionId(context, parentNativeId);
    return bindMintedChildTrajectory({
      context,
      parentNativeId,
      childNativeId,
    });
  }

  stripCarrierMetadata(request: unknown): void {
    stripRecordFields(asRecord(asRecord(request)?.metadata), [
      "parent_id",
      "parentID",
      "parent_session_id",
      "task_id",
      "agent_id",
    ]);
  }
}

/**
 * Reduces OpenCode's own spellings of a local tool to the bare name: the
 * undecorated wire name, its `builtin:` decoration, and the embedded
 * runtime's `host/archestra/` derivation. Unlike the shared localToolName,
 * no other client's namespace strips to an OpenCode-native name.
 */
function nativeOpenCodeToolName(name: string): string {
  for (const prefix of ["builtin:", "host/archestra/"] as const) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

function parentSessionId(context: AppaMatchContext): string | undefined {
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const namedParent =
    readHeader(context.headers, "x-parent-session-id") ??
    stringField(metadata?.parent_id) ??
    stringField(metadata?.parentID) ??
    stringField(metadata?.parent_session_id);
  if (namedParent) return namedParent;
  const session = readHeader(context.headers, "x-opencode-session");
  const affinity = readHeader(context.headers, "x-session-id");
  if (affinity && session && affinity !== session) return affinity;
  return undefined;
}

function childSessionId(
  context: AppaMatchContext,
  parentNativeId: string | undefined,
): string | undefined {
  const session =
    readHeader(context.headers, "x-opencode-session") ??
    readHeader(context.headers, "x-session-id") ??
    readHeader(context.headers, "x-session-affinity");
  if (session && session !== parentNativeId) return session;
  const metadata = asRecord(asRecord(context.requestBody)?.metadata);
  const child =
    stringField(metadata?.task_id) ??
    stringField(metadata?.session_id) ??
    stringField(asRecord(context.requestBody)?.prompt_cache_key);
  return child && child !== parentNativeId ? child : undefined;
}

/** Request headers where OpenCode provides its session ID. */
const OPENCODE_SESSION_HEADERS = [
  "x-session-id",
  "x-session-affinity",
  "session-id",
] as const;
