import type { IncomingHttpHeaders } from "node:http";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { verifyChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { verifyDelegatedPrompt } from "@/openappa/delegation";
import { grokChildOutputs } from "@/openappa/grok-child-return";
import type { AppaSessionIdentity } from "@/openappa/wire";
import {
  grokCatalogToolHint,
  grokToolName,
} from "@/routes/mcp-gateway/grok-tool-names";
import { detectGrokClientId } from "@/routes/proxy/utils/headers/client-app";
import { ApiError } from "@/types/api";
import type { CommonToolResult } from "@/types/common-llm-format";
import { asRecord } from "@/utils/as-record";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaSpawnPromptField,
  AskUserArguments,
  NativeQuestionResult,
} from "../types";
import { readHeader, withoutCallerScope } from "../utils";
import {
  admitGrokRelayReport,
  grokRelayArrivals,
  grokRelayInputError,
  grokRelayMessage,
  isGrokRelayReceipt,
  isGrokRelayTool,
  rewriteGrokRelayMessage,
  stripGrokRelayHistory,
} from "./grok-relay";
import {
  bindMintedChildTrajectory,
  namesChildrenFromArguments,
} from "./trajectory";

export class AppaGrokAdapter implements AppaClientAdapter {
  readonly id = "grok-build";
  readonly trajectoryPrefix = "grok";
  readonly relayMessage = grokRelayMessage;
  readonly relayArrivals = grokRelayArrivals;
  readonly isRelayTool = isGrokRelayTool;
  readonly isRelayReceipt = isGrokRelayReceipt;
  readonly rewriteRelayMessage = rewriteGrokRelayMessage;
  readonly admitRelayReport = admitGrokRelayReport;
  readonly admitsFailedRelayReports = true;
  isUnattended(headers: IncomingHttpHeaders): boolean {
    return readHeader(headers, "x-grok-client-mode") === "headless";
  }
  readonly nativeQuestion = {
    toolName: "ask_user_question",
    supportsMultiple: true,
    isAvailable: (headers: IncomingHttpHeaders) =>
      readHeader(headers, "x-grok-client-mode") === "interactive",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          question: grokShownQuestion(args),
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
            ...((option.preview ?? args.plainCallPreview ?? args.callPreview)
              ? {
                  preview:
                    option.preview ?? args.plainCallPreview ?? args.callPreview,
                }
              : {}),
          })),
          multi_select: args.allowMultiple ?? false,
        },
      ],
    }),
    rulingFromResult: (
      result: NativeQuestionResult,
      asked: AskUserArguments,
    ) => {
      if (result.isError) return "unavailable" as const;
      for (const answer of ["Approve", "Deny"]) {
        const option = asked.options.find((option) => option.label === answer);
        if (!option) continue;
        const preview =
          option.preview ?? asked.plainCallPreview ?? asked.callPreview;
        const opening = `User has answered your questions: "${grokShownQuestion(asked)}"="${answer}"`;
        const ending =
          ". You can now continue with the user's answers in mind.";
        if (
          result.content === `${opening}${ending}` ||
          (preview &&
            result.content ===
              `${opening} selected preview:\n${preview}${ending}`)
        )
          return answer === "Approve"
            ? ("approve" as const)
            : ("deny" as const);
      }
      if (result.content === "User dismissed the question.")
        return "declined" as const;
      return "unrecognized" as const;
    },
  };

  matches(context: AppaMatchContext): boolean {
    return (
      detectGrokClientId(context.headers) !== undefined ||
      readHeader(context.headers, "x-archestra-agent-id") === this.id
    );
  }

  classifyToolName(name: string, namespace?: string): "gateway" | "local" {
    if (name === "use_tool") return "local";
    return name.includes("__") ||
      name.startsWith("mcp:") ||
      namespace?.startsWith("mcp")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    return GROK_TOOL_ALIASES[name] ?? name;
  }

  nativeDispatch(call: {
    name: string;
    arguments: string | object;
    namespace?: string;
  }): { toolCallName: string; toolCallArgs: string } | undefined {
    if (call.name !== "use_tool") return;
    if (
      this.blockedToolReason(
        call.name,
        typeof call.arguments === "string"
          ? call.arguments
          : (asRecord(call.arguments) ?? {}),
      )
    )
      return;
    const input = asRecord(
      typeof call.arguments === "string"
        ? JSON.parse(call.arguments)
        : call.arguments,
    );
    if (!input) return;
    return {
      // A host spelling must fit the runtime's segment grammar. Encoding also
      // prevents an unverified target from acquiring an MCP or control identity.
      toolCallName: `unverified.${grokToolName(String(input.tool_name))}`,
      toolCallArgs: JSON.stringify(input.tool_input),
    };
  }

  blockedToolReason(
    name: string,
    args: string | Record<string, unknown> = {},
  ): string | undefined {
    if (this.classifyToolName(name) === "gateway") return undefined;
    if (name === "send_subagent_message") return grokRelayInputError(args);
    if (name === "use_tool") {
      let input: Record<string, unknown> | undefined;
      try {
        input = asRecord(typeof args === "string" ? JSON.parse(args) : args);
      } catch {
        input = undefined;
      }
      if (
        !input ||
        typeof input.tool_name !== "string" ||
        !/^[A-Za-z0-9_.:-]+__[A-Za-z0-9_.:-]+$/.test(input.tool_name) ||
        !asRecord(input.tool_input) ||
        /(?:^|__)(?:use_tool|run_tool|spawn_subagent|send_subagent_message|workflow|monitor|scheduler_create|scheduler_delete)$/.test(
          input.tool_name,
        )
      )
        return "Grok use_tool must target a namespaced MCP tool with object tool_input. Native tools and nested local dispatch are not accepted through this wrapper. The gateway checks the target call in the same session; this wrapper grants no remedy authority.";
      if (
        archestraMcpBranding.isToolName(input.tool_name) ||
        archestraMcpBranding.isToolName(
          grokCatalogToolHint(input.tool_name) ?? "",
        )
      )
        return "This use_tool target is a gateway tool name, not a verified Grok catalog name. Use native search_tool to find the gateway run_tool entry point, then copy its complete tool_name into use_tool unchanged. Put this gateway target in tool_input.tool_name and its arguments in tool_input.tool_args. Remedy and approval tools need their own discovered entry points. The call did not run.";
    }
    if (UNSUPPORTED_TOOLS.has(name))
      return `Grok ${name} is blocked: workflows, monitors and scheduled runs do not yet carry a verified policy trajectory. Use protected subagents or direct tools in this session instead.`;
    if (!KNOWN_TOOLS.has(name))
      return `Unrecognized Grok native tool ${name}. Update the Grok integration before using this tool.`;
    return undefined;
  }

  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const values = Object.entries(context.headers)
      .filter(([name]) => name.toLowerCase() === "x-grok-session-id")
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
    const sessionId = values[0];
    if (values.length === 0 || values.every((value) => value === "")) {
      const tools = asRecord(context.requestBody)?.tools;
      if (
        !Array.isArray(tools) ||
        tools.every((tool) => {
          const entry = asRecord(tool);
          return (
            (asRecord(entry?.function)?.name ?? entry?.name) === "session_title"
          );
        })
      )
        return undefined;
      throw new ApiError(
        400,
        "Grok native tools require x-grok-session-id. Start a new Grok session after connecting.",
      );
    }
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,512}$/.test(sessionId) ||
      values.some((value) => value !== sessionId)
    )
      throw new ApiError(
        400,
        "Grok sent an invalid or contradictory native session ID.",
      );
    return { sessionId, provenance: "grok-session-header" };
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    // Resume keeps the governed actor even though Grok assigns a new ID.
    // In Agent Runtime, the root parent's trajectory segment is the bound
    // workspace name rather than Grok's ephemeral native session UUID.
    const childSegment = this.bindChildTrajectory(context)
      ?.sessionId.split(":")
      .at(-1);
    if (childSegment) return childSegment;
    const trusted = context.trustedContext;
    if (trusted?.runtimeSessionId) {
      return withoutCallerScope(trusted.session, trusted.runtimeSessionId)
        ?.split(":")
        .at(-1);
    }
    return this.extractSessionIdentity(context)?.sessionId;
  }

  gatewayToolsHint(serverName: string): string {
    return `Open /mcps in Grok, select ${serverName} and press i to authorize it in your browser, then start a new session. grok mcp doctor ${serverName} diagnoses connectivity but does not sign in. Grok discovers MCP tools with search_tool and calls them with use_tool; do not rename them to native tools.`;
  }

  gatewayToolsSearch(serverName: string) {
    return {
      name: "search_tool",
      arguments: JSON.stringify({
        query: `${serverName} remedy`,
        limit: 8,
      }),
    };
  }

  readonly resumesForBackgroundReturns = true;
  readonly repeatsChildReturns = true;
  readonly childTranscriptPaths = [
    { prefix: ".grok/sessions/", suffix: "" },
    { prefix: ".archestra/grok/native/sessions/", suffix: "" },
  ];

  isSpawnTool(name: string, namespace?: string, args?: unknown): boolean {
    return (
      !namespace &&
      name === "spawn_subagent" &&
      !argumentRecord(args)?.resume_from
    );
  }
  isChildContinuationTool(
    name: string,
    namespace?: string,
    args?: unknown,
  ): boolean {
    return (
      !namespace &&
      name === "spawn_subagent" &&
      Boolean(argumentRecord(args)?.resume_from)
    );
  }
  spawnPromptField(
    name: string,
    args: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined {
    return this.isSpawnTool(name, undefined, args) &&
      typeof args.prompt === "string"
      ? { field: "prompt", kind: "text" }
      : undefined;
  }
  unsupportedSpawnFields(params: {
    name: string;
    arguments: unknown;
  }): string[] | undefined {
    if (!this.isSpawnTool(params.name)) return undefined;
    const args = argumentRecord(params.arguments);
    return args?.resume_from !== undefined &&
      args.resume_from !== null &&
      (typeof args.resume_from !== "string" ||
        !/^[0-9a-f-]{36}$/.test(args.resume_from))
      ? ["resume_from"]
      : undefined;
  }
  normalizeChildLaunchResult(result: CommonToolResult): string | undefined {
    if (result.name !== "spawn_subagent" || result.namespace || result.isError)
      return undefined;
    const text = resultText(result.content);
    const record = argumentRecord(result.content) ?? argumentRecord(text);
    if (record?.status === "running" && typeof record.subagent_id === "string")
      return JSON.stringify({
        subagent_id: record.subagent_id,
        status: "running",
      });
    const status = asRecord(record?.status);
    const pending = Object.entries(status ?? {}).filter(
      ([, entry]) => asRecord(entry)?.state === "running",
    );
    if (pending.length === 1)
      return JSON.stringify({ subagent_id: pending[0][0], status: "running" });
    const launch = text ? grokChildOutputs(text) : undefined;
    if (launch?.length !== 1 || launch[0].status !== "running")
      return undefined;
    return JSON.stringify({ subagent_id: launch[0].id, status: "running" });
  }
  isChildCompletionResult(result: CommonToolResult): boolean {
    if (
      result.namespace ||
      result.isError ||
      !["spawn_subagent", "get_command_or_subagent_output"].includes(
        result.name,
      )
    )
      return false;
    const text = resultText(result.content);
    const record = argumentRecord(result.content) ?? argumentRecord(text);
    const status = asRecord(record?.status);
    if (status)
      return Object.values(status).some(
        (entry) =>
          typeof asRecord(entry)?.completed === "string" ||
          typeof asRecord(entry)?.failed === "string",
      );
    if (record?.status === "running" && typeof record.subagent_id === "string")
      return false;
    const outputs = text === undefined ? undefined : grokChildOutputs(text);
    // Unknown successful envelopes still require return admission. A CLI
    // format change must never turn child text into an ordinary TaskOutput.
    return outputs
      ? outputs.some((entry) => entry.status === "completed")
      : true;
  }
  formatChildReturn(params: {
    childNativeId: string | undefined;
    value: string;
  }): string {
    return JSON.stringify({
      subagent_id: params.childNativeId,
      output: params.value,
    });
  }
  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    const args = argumentRecord(params.arguments);
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments:
        args && Array.isArray(args.task_ids)
          ? args.task_ids.map((task_id) => ({ task_id }))
          : params.arguments,
      pathPatterns: [],
      idKeys: ["task_id", "subagent_id", "resume_from"],
    });
  }
  bindChildTrajectory(context: AppaMatchContext) {
    const childNativeId = this.extractSessionIdentity(context)?.sessionId;
    if (!childNativeId) return undefined;
    const trusted = context.trustedContext;
    const markers = trusted?.request.delegation?.markers ?? [];
    for (const marker of [...markers].reverse()) {
      const parentNativeId = marker.parentId.split(":").at(-1);
      if (!trusted || !parentNativeId || parentNativeId === childNativeId)
        continue;
      if (
        !verifyDelegatedPrompt({
          marker,
          organizationId: trusted.session.organization_id,
          callerId: trusted.session.caller_id,
          spawnerNativeId: parentNativeId,
        })
      )
        continue;
      const matching = (trusted.request.childTrajectoryReceipts ?? []).filter(
        (receipt) =>
          receipt.parentId === marker.parentId &&
          receipt.spawnCallId === marker.spawnCallId &&
          (receipt.childNativeId === undefined ||
            receipt.childNativeId === childNativeId) &&
          verifyChildTrajectoryReceipt({
            receipt,
            organizationId: trusted.session.organization_id,
            callerId: trusted.session.caller_id,
            spawnerNativeId: parentNativeId,
          }),
      );
      return bindMintedChildTrajectory({
        context: {
          ...context,
          trustedContext: {
            ...trusted,
            request: {
              ...trusted.request,
              delegation: { markers: [marker] },
              childTrajectoryReceipts: matching,
            },
          },
        },
        parentNativeId,
        childNativeId,
        preserveRecordedChildId: true,
      });
    }
    const receipts = trusted?.request.childTrajectoryReceipts ?? [];
    if (receipts.some((receipt) => receipt.childNativeId === childNativeId))
      return bindMintedChildTrajectory({
        context,
        parentNativeId: undefined,
        childNativeId,
        preserveRecordedChildId: true,
      });
    if (markers.length)
      throw new ApiError(
        409,
        "OpenAPPA could not verify the Grok child's spawn prompt.",
      );
    return undefined;
  }
  stripCarrierMetadata(request: unknown): void {
    stripGrokRelayHistory(request);
  }
}

function grokShownQuestion(args: AskUserArguments): string {
  return args.plainCallPreview && args.shortQuestion
    ? args.shortQuestion
    : args.question;
}

const GROK_TOOL_ALIASES: Record<string, string> = {
  run_terminal_command: "Bash",
  search_tool: "ToolSearch",
  search_replace: "Edit",
  list_dir: "Glob",
  write: "Write",
  grep: "Grep",
  web_search: "WebSearch",
  todo_write: "TodoWrite",
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  kill_command_or_subagent: "TaskStop",
  scheduler_list: "CronList",
  send_feedback: "SendFeedback",
  spawn_subagent: "Agent",
  get_command_or_subagent_output: "TaskOutput",
  send_subagent_message: "SendMessage",
};

const KNOWN_TOOLS = new Set([
  "run_terminal_command",
  "read_file",
  "search_replace",
  "list_dir",
  "grep",
  "web_search",
  "kill_command_or_subagent",
  "todo_write",
  "scheduler_list",
  "search_tool",
  "use_tool",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
  "send_feedback",
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "write",
  "session_title",
  "spawn_subagent",
  "get_command_or_subagent_output",
  "send_subagent_message",
]);

const UNSUPPORTED_TOOLS = new Set([
  "workflow",
  "monitor",
  "scheduler_create",
  "scheduler_delete",
]);

function argumentRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    return asRecord(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return undefined;
  }
}

function resultText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((part) => asRecord(part)?.text ?? "").join("\n");
  return undefined;
}
