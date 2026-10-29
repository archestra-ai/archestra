import { isKimiCodeUserAgent, KIMI_CODE_CLIENT_ID } from "@archestra/shared";
import { EXTERNAL_AGENT_ID_HEADER } from "@archestra/shared/consts";
import type { AppaSessionIdentity } from "@/openappa/wire";
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
import {
  kimiCodeQuestionRuling,
  kimiCodeQuestionSelection,
} from "./native-question-ruling";
import { bindMintedChildTrajectory, nativeId, stringField } from "./trajectory";

/** `Agent` starts one subagent; `AgentSwarm` starts several from a template. */
const SPAWN_TOOLS = new Set(["Agent", "AgentSwarm"]);
/**
 * A subagent's own record (`agents/agent-N/wire.jsonl`) and a background
 * task's output and state (`agents/main/tasks/agent-<id>/output.log`,
 * `agents/main/tasks/agent-<id>.json`) hold unchecked child output.
 */
const CHILD_PATHS = [
  { prefix: "agents/agent-", suffix: "/wire.jsonl" },
  { prefix: "tasks/agent-", suffix: "/output.log" },
  { prefix: "tasks/agent-", suffix: ".json" },
] as const;
const LAUNCH_AGENT_ID = /^agent-[A-Za-z0-9_-]{1,64}$/;

/**
 * Identifies Kimi Code (Moonshot's `kimi` CLI) requests.
 *
 * Kimi Code sends its session id as `prompt_cache_key` on every model request:
 * the main agent, its subagents, compaction and a resumed session all send the
 * same value. A subagent is therefore bound only by the signed delegation
 * marker on the prompt of the `Agent` call that started it.
 */
export class AppaKimiCodeAdapter implements AppaClientAdapter {
  readonly id = KIMI_CODE_CLIENT_ID;
  readonly trajectoryPrefix = "kimi";
  readonly childTranscriptPaths = CHILD_PATHS;
  // Kimi Code cuts every tool-call ID to 64 characters before each request.
  readonly maxToolCallIdLength = 64;
  readonly nativeQuestion = {
    toolName: "AskUserQuestion",
    // Kimi Code refuses AskUserQuestion in its auto ("Never Ask") mode, which
    // delegated runtime turns and `kimi -p` use. A review then stays on the
    // gateway's ask_user.
    isAvailable: (_headers: unknown, requestBody?: unknown) =>
      !autoModeActive(requestBody),
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: args.question,
          // Kimi Code's question tab label is at most 12 characters.
          header: questionHeader(args.header, 12),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? "",
          })),
          multi_select: args.allowMultiple === true,
        },
      ],
    }),
    rulingFromResult: (result: NativeQuestionResult, asked: AskUserArguments) =>
      kimiCodeQuestionRuling(result, asked.question),
    selectionFromResult: kimiCodeQuestionSelection,
  };

  matches(context: AppaMatchContext): boolean {
    return (
      isKimiCodeUserAgent(readHeader(context.headers, "user-agent")) ||
      readHeader(context.headers, EXTERNAL_AGENT_ID_HEADER)
        ?.trim()
        .toLowerCase() === KIMI_CODE_CLIENT_ID
    );
  }

  // Kimi Code names a gateway tool `mcp__<server>__<tool>`, with each run of
  // underscores in a name part cut to one. The proxy still resolves gateway
  // tools by their attestation, so only the prefix matters here.
  classifyToolName(name: string): "gateway" | "local" {
    return name.startsWith("mcp__") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name;
  }

  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const sessionId = nativeId(
      asRecord(context.requestBody)?.prompt_cache_key,
      "Kimi Code session id",
    );
    return sessionId
      ? { sessionId, provenance: "kimi-code-cache-key" }
      : undefined;
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    return this.extractSessionIdentity(context)?.sessionId;
  }

  gatewayToolsHint(serverName: string): string {
    return `Run /mcp-config in Kimi Code. If "${serverName}" needs authentication, run /mcp-config login ${serverName} and sign in. If it is not listed, connect Kimi Code again and start a new session. Then send your message again.`;
  }

  isSpawnTool(name: string): boolean {
    return SPAWN_TOOLS.has(name);
  }

  /**
   * A marker binds one child to the prompt it was signed for, so only a new,
   * foreground `Agent` call can start a governed child. A resumed subagent
   * would take the parent's new prompt without a marker; a background one
   * returns through a file the parent reads; `AgentSwarm` builds each child's
   * prompt from a template the marker was not signed for.
   */
  unsupportedSpawnFields(params: {
    name: string;
    arguments: unknown;
  }): string[] | undefined {
    if (!this.isSpawnTool(params.name)) return undefined;
    const args = argumentRecord(params.arguments) ?? {};
    if (params.name === "AgentSwarm") {
      const fields = Object.keys(args)
        .filter((key) => key !== "description" && key !== "subagent_type")
        .sort();
      return fields.length > 0 ? fields : ["description"];
    }
    const fields = [
      ...(stringField(args.resume)?.trim() ? ["resume"] : []),
      ...(args.run_in_background === true ? ["run_in_background"] : []),
    ];
    return fields.length > 0 ? fields : undefined;
  }

  spawnPromptField(
    name: string,
    args: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined {
    return name === "Agent" && typeof args.prompt === "string"
      ? { field: "prompt", kind: "text" }
      : undefined;
  }

  isChildCompletionResult(result: CommonToolResult): boolean {
    return (
      result.name === "Agent" &&
      !result.isError &&
      this.normalizeChildLaunchResult(result) === undefined
    );
  }

  /** A background launch reports `status: running`; its output comes later. */
  normalizeChildLaunchResult(result: CommonToolResult): string | undefined {
    if (result.name !== "Agent" || result.isError) return undefined;
    const text = resultText(result.content);
    if (!text || !/^status: running$/m.test(text)) return undefined;
    const agentId = /^agent_id: (\S+)$/m.exec(text)?.[1];
    return agentId && LAUNCH_AGENT_ID.test(agentId)
      ? `status: running\nagent_id: ${agentId}`
      : "status: running";
  }

  // Children are minted from the spawn call, never named by native ids.
  namesChildren(): string[] {
    return [];
  }

  bindChildTrajectory(context: AppaMatchContext) {
    // A shared session id cannot tell a child from its parent, so a receipt
    // quoted in the parent's history must not bind the request. Only a signed
    // marker on the child's opening prompt does.
    const trusted = context.trustedContext;
    return bindMintedChildTrajectory({
      context: trusted
        ? {
            ...context,
            trustedContext: {
              ...trusted,
              request: { ...trusted.request, childTrajectoryReceipts: [] },
            },
          }
        : context,
      parentNativeId: this.extractSessionIdentity(context)?.sessionId,
      childNativeId: undefined,
    });
  }

  stripCarrierMetadata(): void {}
}

/**
 * Whether Kimi Code's newest permission-mode reminder in the conversation
 * says auto mode is on. Kimi Code adds one when the mode starts and one when
 * it ends.
 */
function autoModeActive(requestBody: unknown): boolean {
  const messages = asRecord(requestBody)?.messages;
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = asRecord(messages[index]);
    if (message?.role !== "user") continue;
    const text = resultText(message.content) ?? "";
    if (text.includes(AUTO_MODE_EXIT)) return false;
    if (text.includes(AUTO_MODE_ENTER)) return true;
  }
  return false;
}

const AUTO_MODE_ENTER = "<system-reminder>\nAuto permission mode is active.";
const AUTO_MODE_EXIT =
  "<system-reminder>\nAuto permission mode is no longer active.";

function argumentRecord(args: unknown): Record<string, unknown> | undefined {
  const raw = stringField(args);
  if (!raw) return asRecord(args);
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function resultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((part) => {
    const text = asRecord(part)?.text;
    return typeof text === "string" ? [text] : [];
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}
