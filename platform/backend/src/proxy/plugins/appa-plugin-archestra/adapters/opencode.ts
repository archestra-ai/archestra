import { EXTERNAL_AGENT_ID_HEADER } from "@archestra/shared/consts";
import {
  isKiloClientAgentId,
  isKiloUserAgent,
} from "@archestra/shared/interactions/client";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types";
import type { CommonToolResult } from "@/types/common-llm-format";
import { asRecord } from "@/utils/as-record";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaSpawnPromptField,
  AskUserArguments,
  NativeQuestionResult,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import { openCodeQuestionRuling } from "./native-question-ruling";

// OpenCode labels each question's tab with a header of at most 30 characters,
// the same bound ask_user declares for it.
const QUESTION_HEADER_MAX_LENGTH = 30;

import {
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
  readonly id: "opencode" | "kilo" = "opencode";
  readonly trajectoryPrefix: string = "opencode";
  /** The client named in errors about its session headers. */
  protected readonly clientLabel: string = "OpenCode";
  /** The command a person runs, named in sign-in instructions. */
  protected readonly cliBinary: string = "opencode";
  protected readonly provenance: {
    session: NonNullable<AppaSessionIdentity["provenance"]>;
    hosted: NonNullable<AppaSessionIdentity["provenance"]>;
  } = { session: "opencode-session-header", hosted: "opencode-hosted-header" };
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
    rulingFromResult: (result: NativeQuestionResult, asked: AskUserArguments) =>
      openCodeQuestionRuling(result, asked.question),
  };

  // A running session does not pick up a sign-in or a config change.
  gatewayToolsHint(serverName: string): string {
    return `Run ${this.cliBinary} mcp auth ${serverName} and finish the sign-in in your browser. If "${serverName}" is not configured, connect ${this.clientLabel} again. Then start a new session.`;
  }

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
    const contradiction = `OpenAPPA cannot bind contradictory ${this.clientLabel} session headers`;
    if (claims.some((claim) => claim !== normal)) {
      throw new ApiError(400, contradiction);
    }
    if (normal && hosted && normal !== hosted) {
      if (explicitParent === normal) {
        return { sessionId: hosted, provenance: this.provenance.hosted };
      }
      throw new ApiError(400, contradiction);
    }
    if (normal) {
      return { sessionId: normal, provenance: this.provenance.session };
    }
    return hosted
      ? { sessionId: hosted, provenance: this.provenance.hosted }
      : undefined;
  }

  isSpawnTool(name: string, namespace?: string): boolean {
    // OpenCode declares native tools without a wire namespace.
    // Rejects foreign namespaces and tool prefixes from other clients.
    return (
      namespace === undefined &&
      CHILD_SPAWN_TOOLS.has(nativeOpenCodeToolName(name))
    );
  }

  isChildCompletionResult(result: CommonToolResult): boolean {
    const text = resultText(result.content);
    return (
      this.isSpawnTool(result.name, result.namespace) &&
      !result.isError &&
      !(
        text !== undefined &&
        /^\s*<task\b[^>]*\bstate\s*=\s*(["'])(?:running|pending|queued)\1[^>]*>/.test(
          text,
        )
      )
    );
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
 * Kilo Code's CLI, an OpenCode fork: the same session headers, `task` and
 * `question` tools, answer wording and `<task>` framing. Only its identity
 * differs: a `kilo/…` User-Agent, or the agent id its setup sends. Its
 * ChatGPT-login OpenAI requests carry OpenCode's identity and match the
 * OpenCode adapter instead.
 */
export class AppaKiloAdapter extends AppaOpenCodeAdapter {
  override readonly id = "kilo" as const;
  override readonly trajectoryPrefix = "kilo";
  protected override readonly clientLabel = "Kilo Code";
  protected override readonly cliBinary = "kilo";
  protected override readonly provenance = {
    session: "kilo-session-header",
    hosted: "kilo-hosted-header",
  } as const;

  override matches(context: AppaMatchContext): boolean {
    return (
      isKiloUserAgent(readHeader(context.headers, "user-agent")) ||
      isKiloClientAgentId(readHeader(context.headers, EXTERNAL_AGENT_ID_HEADER))
    );
  }
}

/**
 * Normalizes OpenCode tool names by removing builtin: and host/archestra/ prefixes.
 * Leaves other tool prefixes unchanged.
 */
function nativeOpenCodeToolName(name: string): string {
  for (const prefix of ["builtin:", "host/archestra/"] as const) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/**
 * The text of a tool result as a provider wire carries it: a string, text
 * parts, or an object that wraps either in `content` (Gemini's
 * functionResponse, as the Model Router translates a tool message).
 */
function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.flatMap((part) => {
      const text = typeof part === "string" ? part : asRecord(part)?.text;
      return typeof text === "string" ? [text] : [];
    });
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  const wrapped = asRecord(content)?.content;
  return wrapped === undefined ? undefined : resultText(wrapped);
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
