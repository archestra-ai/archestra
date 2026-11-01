import { isCopilotCliClientAgentId } from "@archestra/shared/interactions/client";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types/api";
import type { CommonToolResult } from "@/types/common-llm-format";
import { asRecord } from "@/utils/as-record";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaSpawnModel,
  AppaSpawnPromptField,
  AskUserArguments,
  NativeQuestionReading,
  NativeQuestionResult,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import {
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
} from "./trajectory";

/** The connect setup's agent id header names the client; its User-Agent is the OpenAI SDK's. */
const AGENT_ID_HEADER = "x-archestra-agent-id";
/** Copilot marks a subagent's model requests; the parent's turns say `conversation-user`. */
const INTERACTION_TYPE_HEADER = "x-interaction-type";
const SUBAGENT_INTERACTION = "conversation-subagent";
/** The `task` tool starts a subagent; `read_agent` and `write_agent` name one. */
const SPAWN_TOOL = "task";
const READ_AGENT_TOOL = "read_agent";
const CHILD_ID_KEYS = ["agent_id"] as const;
/** The field Copilot's `ask_user` form submits; its value comes back as `User responded: <value>`. */
const QUESTION_FIELD = "archestra_decision";
const QUESTION_HEADER_MAX_LENGTH = 40;
/** `prompt_cache_key` as Copilot sends it: 32 hex characters, stable per session. */
const SESSION_KEY = /^[A-Za-z0-9_.:-]{1,512}$/;
const BACKGROUND_LAUNCH =
  /^Agent started in background with agent_id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./;
/** Copilot opens every user message, a child's included, with the current time. */
const OPENING_PREAMBLE =
  /^<current_datetime>[^<]*<\/current_datetime>\r?\n\r?\n/;
/** `read_agent` reports a finished child; `running` and `cancelled` reports carry no return. */
const AGENT_REPORT_DONE = /^Agent (?:is idle|completed|has completed)\b/;

/**
 * GitHub Copilot CLI on the proxy's OpenAI Responses wire.
 *
 * Copilot names a conversation only there, as `prompt_cache_key`: one value
 * per session, kept across turns and `--resume`, and shared by the session's
 * subagents. Its Chat Completions requests carry no conversation identity, so
 * this adapter binds no session for them and the request counts as one from
 * an unrecognized client. A subagent request says so in `x-interaction-type`
 * and carries no native id of its own: it binds through the delegation marker
 * the proxy appended to the `task` prompt that started it, or is refused.
 */
export class AppaCopilotCliAdapter implements AppaClientAdapter {
  readonly id = "copilot-cli" as const;
  readonly trajectoryPrefix = "copilot";

  // Interactive sessions declare `ask_user`, a form with one field per
  // question; one-shot (`-p`) sessions do not. Copilot's MCP client declares
  // elicitation but declines the gateway's form ("no elicitation consumer is
  // attached", Copilot CLI 1.0.105), so a review has no second surface here.
  readonly nativeQuestion = {
    toolName: "ask_user",
    supportsMultiple: false,
    fromAskUser: (args: AskUserArguments) => ({
      message: args.question,
      requestedSchema: {
        properties: {
          [QUESTION_FIELD]: {
            type: "string",
            title: questionHeader(args.header, QUESTION_HEADER_MAX_LENGTH),
            description: "Choose one of the options.",
            oneOf: args.options.map((option) => ({
              const: option.label,
              title: option.description
                ? `${option.label}: ${option.description}`
                : option.label,
            })),
          },
        },
      },
    }),
    rulingFromResult: (
      result: NativeQuestionResult,
      asked: AskUserArguments,
    ): NativeQuestionReading => readCopilotAnswer(result, asked),
  };

  // A running Copilot session does not pick up an MCP sign-in or config change.
  gatewayToolsHint(serverName: string): string {
    return `Run /mcp in Copilot and check "${serverName}": sign in or reconnect it there. If it is missing, connect Copilot CLI again. Then start a new session with /new.`;
  }

  matches(context: AppaMatchContext): boolean {
    return isCopilotCliClientAgentId(
      readHeader(context.headers, AGENT_ID_HEADER),
    );
  }

  classifyToolName(name: string): "gateway" | "local" {
    // Copilot spells an MCP tool `<server>-<advertised name>` and keeps the
    // gateway's `<catalog>__<tool>` spelling in the advertised part. Its own
    // tools (`bash`, `view`, `task`, ...) and other MCP servers' tools carry no
    // double underscore.
    return name.includes("__") ? "gateway" : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name;
  }

  /**
   * The session is the Responses `prompt_cache_key`. A Chat Completions
   * request names no session: it is left to the generic fallbacks, which find
   * nothing either. A key of another shape is refused rather than bound.
   */
  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const key = sessionKey(context);
    return key
      ? { sessionId: key, provenance: "copilot-cli-prompt-cache-key" }
      : undefined;
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    return sessionKey(context);
  }

  /** The `task` prompt as the spawner wrote it, after Copilot's datetime line. */
  childOpeningPrompt(text: string): string {
    return text.replace(OPENING_PREAMBLE, "");
  }

  isSpawnTool(name: string, namespace?: string): boolean {
    return namespace === undefined && localToolName(name) === SPAWN_TOOL;
  }

  spawnPromptField(
    name: string,
    args: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined {
    return localToolName(name) === SPAWN_TOOL && typeof args.prompt === "string"
      ? { field: "prompt", kind: "text" }
      : undefined;
  }

  /**
   * Copilot runs a `task` subagent on its own subagent model unless the call
   * names one. Signed in to GitHub, that default is a GitHub-hosted model
   * whose requests go to GitHub directly: the child runs out of Guardrails'
   * sight, and its result is withheld from the parent. The `task`
   * declaration lists the models a call may name. The ones this proxy routes
   * are the session's own provider's, listed as `<provider>/<model>`, the
   * provider this request came through. A call with no model gets the
   * session's own; one that names another model is refused with the models
   * that keep the child governed.
   */
  spawnModel(params: {
    requestBody: unknown;
    model: string;
    name: string;
    arguments: Record<string, unknown>;
  }): AppaSpawnModel | undefined {
    if (localToolName(params.name) !== SPAWN_TOOL) return undefined;
    const choices = taskModelChoices(params.requestBody);
    const own = choices && sessionModelChoice(choices, params.model);
    if (!choices || !own) return undefined;
    const provider = own.slice(0, own.indexOf("/") + 1);
    const routed = choices.filter((choice) => choice.startsWith(provider));
    const asked = params.arguments.model;
    if (asked === undefined || asked === null) return { stamp: { model: own } };
    if (typeof asked === "string" && routed.includes(asked)) return undefined;
    return {
      refusal: `[appa] Blocked: ${params.name} would start its subagent on ${JSON.stringify(asked)}, a model whose requests do not go through the ${archestraMcpBranding.appName} LLM proxy, so Guardrails could not check the subagent's work. The call did not run. Call ${params.name} again without model, or with model set to one of: ${routed.join(", ")}.`,
    };
  }

  // Copilot announces a finished background agent itself and reads its
  // report with read_agent, in a request it sends without the user.
  readonly resumesForBackgroundReturns = true;

  /**
   * A background launch answers with the client's own acknowledgment, which
   * the child never wrote: keep it when it has that shape, and withhold any
   * other text that stands where the acknowledgment belongs. A sync launch
   * answers with the child's return and is left to child-return admission.
   */
  normalizeChildLaunchResult(result: CommonToolResult): string | undefined {
    if (!this.isSpawnTool(result.name, result.namespace) || result.isError)
      return undefined;
    const text = resultText(result.content);
    if (text === undefined) return undefined;
    const launch = BACKGROUND_LAUNCH.exec(text);
    if (!launch) return undefined;
    if (text.length > 4096 || /<[a-z_]+>/i.test(text)) {
      throw new ApiError(
        409,
        "OpenAPPA withheld an invalid Copilot CLI child launch acknowledgment",
      );
    }
    return text;
  }

  /** A sync `task` result, or a `read_agent` report of a finished child. */
  isChildCompletionResult(result: CommonToolResult): boolean {
    if (result.namespace !== undefined || result.isError) return false;
    const text = resultText(result.content);
    const name = localToolName(result.name);
    if (name === SPAWN_TOOL)
      return text === undefined || !BACKGROUND_LAUNCH.test(text);
    return (
      name === READ_AGENT_TOOL &&
      text !== undefined &&
      AGENT_REPORT_DONE.test(text)
    );
  }

  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    // write_agent addresses several children in `agent_ids`; the collector
    // reads ids by key, so each entry is given its own.
    const args = asRecord(params.arguments);
    const ids = Array.isArray(args?.agent_ids) ? args.agent_ids : undefined;
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments: ids
        ? { ...args, agent_ids: ids.map((agent_id) => ({ agent_id })) }
        : params.arguments,
      pathPatterns: [],
      idKeys: CHILD_ID_KEYS,
    });
  }

  /**
   * Copilot's subagents share the session key and report no id of their own,
   * so a child binds only through the delegation marker in its opening prompt
   * (or the receipt it earned). A request Copilot marks as a subagent's that
   * carries neither is refused: fleet mode, dynamic workflows and agents
   * started outside a released `task` call have no governed parent.
   */
  bindChildTrajectory(context: AppaMatchContext) {
    const subagent =
      readHeader(context.headers, INTERACTION_TYPE_HEADER) ===
      SUBAGENT_INTERACTION;
    const parentNativeId = sessionKey(context);
    if (!parentNativeId) {
      if (subagent) {
        throw new ApiError(
          400,
          "OpenAPPA cannot bind a Copilot CLI subagent without a session: Copilot names its session only on the Responses API. Connect Copilot CLI again.",
        );
      }
      return undefined;
    }
    const child = bindMintedChildTrajectory({
      context,
      parentNativeId,
      childNativeId: undefined,
    });
    if (!child && subagent) {
      throw new ApiError(
        400,
        "OpenAPPA cannot bind this Copilot CLI subagent: its prompt carries no delegation marker from a task call the proxy released. Subagents started by fleet mode, dynamic workflows, or outside the task tool have no governed parent.",
      );
    }
    return child;
  }

  stripCarrierMetadata(): void {}
}

/** The models Copilot's `task` declaration lets a call name, when it lists them. */
function taskModelChoices(requestBody: unknown): string[] | undefined {
  const tools = asRecord(requestBody)?.tools;
  if (!Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    const record = asRecord(tool);
    // Responses declares a function flat; Chat Completions nests it.
    const declaration = asRecord(record?.function) ?? record;
    if (declaration?.name !== SPAWN_TOOL) continue;
    const properties = asRecord(asRecord(declaration.parameters)?.properties);
    const choices = asRecord(properties?.model)?.enum;
    if (!Array.isArray(choices)) return undefined;
    const models = choices.filter(
      (choice): choice is string => typeof choice === "string",
    );
    return models.length > 0 ? models : undefined;
  }
  return undefined;
}

/**
 * The choice naming the model this request came through. Copilot lists a
 * provider's model as `<provider>/<model id>` and asks the provider for the
 * bare id. Undefined when no choice, or more than one, names it.
 */
function sessionModelChoice(
  choices: readonly string[],
  model: string,
): string | undefined {
  const matching = choices.filter((choice) => {
    const slash = choice.indexOf("/");
    return slash > 0 && choice.slice(slash + 1) === model;
  });
  return matching.length === 1 ? matching[0] : undefined;
}

function sessionKey(context: AppaMatchContext): string | undefined {
  const key = asRecord(context.requestBody)?.prompt_cache_key;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== "string" || !SESSION_KEY.test(key)) {
    throw new ApiError(
      400,
      "OpenAPPA cannot read the Copilot CLI session: prompt_cache_key is not a valid session key.",
    );
  }
  return key;
}

/**
 * Copilot answers its `ask_user` form in one line: `User responded: <value>`
 * with the chosen option's value, or the text the person typed under "Other",
 * which Copilot adds to every choice field. Only a listed option is a choice:
 * typed text is the person's answer without a decision, never an approval,
 * and reaches the model as written. Escape cancels; Ctrl-D declines with a
 * text that tells the model to work on alone, which is never an approval.
 */
function readCopilotAnswer(
  result: NativeQuestionResult,
  asked: AskUserArguments,
): NativeQuestionReading {
  if (result.isError) return "unavailable";
  const content = result.content.trim();
  if (content === "User cancelled the request.") return "cancelled";
  if (content.startsWith("The user is not available to respond"))
    return "declined";
  const answered = /^User responded: (.*)$/s.exec(content);
  if (!answered) return "unrecognized";
  const value = answered[1].trim();
  if (!value) return "unrecognized";
  if (!asked.options.some((option) => option.label === value)) return "none";
  if (value === "Approve") return "approve";
  if (value === "Deny") return "deny";
  return "none";
}

/** The text of a tool result as the Responses or Chat Completions wire carries it. */
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
