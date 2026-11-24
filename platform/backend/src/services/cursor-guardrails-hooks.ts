import { createHash, randomBytes } from "node:crypto";
import {
  isYellToolShortName,
  SupportedProviders,
  TimeInMs,
  TOOL_ASK_USER_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { ConnectionSetupModel } from "@/models";
import { currentTrajectory } from "@/openappa/current-trajectory";
import { refusalAction, refusalGuidance } from "@/openappa/refusal-outcome";
import {
  endTurn,
  evaluateToolCalls,
  isWellFormedAppaId,
  notePrompt,
  type OpenAppaSession,
  openappaEnabled,
  processProxyResults,
  UNRELEASED_CALL_CODE,
  withCapturedGuardrailsActivation,
} from "@/openappa/service";
import {
  findUnenforcedCalls,
  observeUnenforcedSession,
  recordUnenforcedCalls,
  startedUnenforced,
} from "@/openappa/unenforced";
import { canonicalJson } from "@/openappa/wire";
import { rememberYellSession } from "@/openappa/yell-session";
import { CURSOR_GUARDRAILS_HOOK_STEPS } from "@/services/agent-connection-setup/payloads/cursor-guardrails-hook";
import {
  CURSOR_WEB_CALL_ARGUMENT,
  CURSOR_WEB_CLI_DATA_DIRNAME,
  CURSOR_WEB_FETCH_TOOL,
  CURSOR_WEB_SEARCH_TOOL,
  CURSOR_WEB_SETUP_TOOL,
} from "@/services/agent-connection-setup/payloads/cursor-web-tools";
import {
  sessionMarkContext,
  settleMarks,
  subagentMarkContext,
  subagentReplyNote,
} from "@/services/cursor-guardrails-marks";
import { CURSOR_WEB_SETUP_POLICY_TOOL } from "@/services/cursor-web-setup-tool-name";
import { getGuardrailsDeployment } from "@/services/guardrails-deployment";
import { ApiError } from "@/types";
import { disconnectReferenceInText } from "./connection-disconnect-reference";
import { verifyConnectionHooksToken } from "./connection-hooks-token";
import { verifyLiveConnectionInstallation } from "./connection-managed-instructions";

/**
 * Guardrails for Cursor chats that never reach the LLM proxy.
 *
 * Cursor's own models run on Cursor's service, so the proxy cannot see their
 * tool calls. Cursor runs hooks for every chat instead, and the hook helper
 * that setup installs posts each step here. This host drives the same runtime
 * events the proxy does: a prompt opens a turn, each tool call is ruled on
 * before it runs, each result is reported after, and `stop` closes the turn.
 * A chat on a Model Router model already passes through the proxy, so its
 * hooks get no ruling here.
 *
 * A subagent runs in its chat's session. Cursor shows no hook what a subagent
 * hands back and lets none replace it, so a return cannot be checked on its
 * way to the parent. Sharing the session keeps that sound: what a subagent
 * read restricts the chat that receives its answer, and a chat's restrictions
 * hold in every subagent it starts.
 *
 * Cursor's own web search and web fetch call no hook, so setup switches them
 * off and installs two MCP tools in their place. Each call of one starts a
 * headless Cursor CLI process that makes the native web call. The MCP call is
 * what Guardrails rule on and whose result they check, under the policy's
 * names for a web search and a URL fetch. The CLI process is that call's
 * subagent: an allowed call gets an id in its arguments, the process's hook
 * reports with it, and its steps are checked in the calling chat's session.
 *
 * The chat that disconnects Cursor is not checked, as the conversation that
 * runs a connect installer is not at the proxy: the cleanup removes the
 * gateway, and with it the tools a blocked step's remedy needs. The Connect
 * page gives the person a reference with the cleanup prompt, and the first
 * chat of theirs whose prompt holds it is left alone until it expires.
 */

export const CursorHookRequestSchema = z.object({
  step: z.enum(CURSOR_GUARDRAILS_HOOK_STEPS),
  event: z.record(z.string(), z.unknown()),
});
export type CursorHookRequest = z.infer<typeof CursorHookRequestSchema>;

/** What Cursor reads back; every field is optional for every step. */
export type CursorHookAnswer = {
  permission?: "allow" | "deny" | "ask";
  user_message?: string;
  agent_message?: string;
  updated_input?: Record<string, unknown>;
  /** Replaces what the model reads as an MCP tool's result. */
  updated_mcp_tool_output?: string;
  additional_context?: string;
};

/** What the hook prints for Cursor, and what the hook itself needs to know. */
interface CursorHookResult {
  answer: CursorHookAnswer;
  /**
   * Set for a step of the chat that is disconnecting Cursor: when its
   * exemption ends, in milliseconds since the epoch. The hook keeps it, so
   * the chat can finish when this deployment stops answering part-way.
   */
  disconnectUntil?: number;
}

const SESSION_CONTEXT = () =>
  guardrails() +
  " check every tool call in this chat against your organization's policy. " +
  "When a call is blocked, the block message says why and names the remedy plans that can unblock it; " +
  "call them with the archestra MCP server's execute_remedy_plan tool. " +
  "A subagent you start works inside this chat's session: it keeps this chat's restrictions, what it reads restricts this chat too, and what it returns needs no declaration. " +
  "A subagent cannot ask the person a question; it reports the blocked call and its offer_id to you. " +
  "When its report says the review is already open, ask the person with ask_user and that offer ID in remedy_offer_ids, then call execute_remedy_plan once the person has approved; otherwise call execute_remedy_plan first.";

/** The product's name in a message to the model: a deployment can carry its own. */
const guardrails = () => `${archestraMcpBranding.appName} Guardrails`;

const CONTROL_TOOL = "execute_remedy_plan";
const ASK_USER_TOOL = TOOL_ASK_USER_SHORT_NAME;
const MAX_REVIEW_OFFERS = 12;

// Room for the `call:` prefix inside the runtime's 512-byte identity limit.
const MAX_CURSOR_CALL_ID_LENGTH = 200;

export async function handleCursorHook(params: {
  token: string;
  request: CursorHookRequest;
  /** The id a web tool's CLI process reports with, when one sent the step. */
  parentCall?: string;
}): Promise<CursorHookResult> {
  const setupId = verifyConnectionHooksToken({
    token: params.token,
    secret: config.auth.secret ?? "",
  });
  if (!setupId) throw new ApiError(401, "Invalid hook credential");
  const setup = await ConnectionSetupModel.findById(setupId);
  if (!setup || setup.clientId !== "cursor" || setup.revokedAt)
    throw new ApiError(403, "Connection is no longer available");
  await verifyLiveConnectionInstallation(setup);

  const { step } = params.request;
  let { event } = params.request;
  if (!openappaEnabled() || routedThroughProxy(event.model))
    return { answer: {} };
  // A web tool's CLI process is a subagent of the chat whose call started
  // it. An id nobody issued names no chat, and the process is then a chat of
  // its own like any other Cursor CLI run.
  const webCall = params.parentCall
    ? await cacheManager.get<WebCall>(
        webCallKey({
          organizationId: setup.organizationId,
          callerId: callerIdOf(setup.userId),
          id: params.parentCall,
        }),
      )
    : undefined;
  if (webCall) {
    event = { ...event, parent_agent_id: webCall.agentId };
    logger.info(
      { sessionId: webCall.session.session_id, step },
      "A web tool's Cursor CLI process reported a step of its calling chat",
    );
  }
  const session =
    webCall?.session ??
    (await cursorSession({
      organizationId: setup.organizationId,
      userId: setup.userId,
      event,
      step,
    }));
  if (!session) return { answer: {} };

  const deployment = await getGuardrailsDeployment();
  if (!deployment.active) {
    // Enforcement is off: note what OpenAPPA must know when it turns on, the
    // way the proxy does. A chat that starts now stays unenforced, and a call
    // a governed chat makes now is ignored afterwards.
    if (deployment.featureEnabled) {
      const observed = await observeUnenforcedSession(session);
      const callId = cursorCallId(event);
      if (observed === "governed" && step === "preToolUse" && callId) {
        await recordUnenforcedCalls({
          organizationId: session.organization_id,
          sessionId: session.session_id,
          toolCallIds: [callId],
          reason: "made",
        });
      }
    }
    return { answer: {} };
  }
  if (await startedUnenforced(session)) return { answer: {} };
  const disconnectUntil = webCall
    ? undefined
    : await disconnecting({ setup, session, step, event });
  if (disconnectUntil !== undefined) return { answer: {}, disconnectUntil };

  const answer = await withCapturedGuardrailsActivation("active", () =>
    webCall
      ? answerWebChildStep({ step, event, session })
      : answerStep({ step, event, session }),
  );
  return { answer };
}

/**
 * When the exemption ends if the step belongs to the chat that is
 * disconnecting Cursor, and undefined for every other chat. A prompt that
 * holds the person's live disconnect reference gives its chat the exemption,
 * unless another chat presented that reference first. A call the exempt chat
 * makes is recorded as one the runtime did not see, so its result is ignored
 * if it arrives after the exemption ends.
 */
async function disconnecting(params: {
  setup: { organizationId: string; userId: string };
  session: OpenAppaSession;
  step: CursorHookRequest["step"];
  event: Record<string, unknown>;
}): Promise<number | undefined> {
  const { setup, session, step, event } = params;
  const chatKey = disconnectChatKey(session, "chat");
  const prompt =
    step === "beforeSubmitPrompt" && !isSubagentStep(event)
      ? stringField(event.prompt)
      : undefined;
  const reference = prompt
    ? disconnectReferenceInText({
        text: prompt,
        organizationId: setup.organizationId,
        userId: setup.userId,
        secret: config.auth.secret,
      })
    : undefined;
  if (reference) {
    const ownerKey = disconnectChatKey(
      { ...session, session_id: reference.reference },
      "owner",
    );
    const owned = await cacheManager.withLock(ownerKey, async (cache) => {
      const lifetime = reference.expiresAt - Date.now();
      if (lifetime <= 0) return false;
      const owner = await cache.get<string>(ownerKey);
      if (owner !== undefined) return owner === session.session_id;
      await cache.set<string>(ownerKey, session.session_id, lifetime);
      return true;
    });
    const lifetime = reference.expiresAt - Date.now();
    if (owned && lifetime > 0) {
      await cacheManager.set<number>(chatKey, reference.expiresAt, lifetime);
      logger.info(
        { sessionId: session.session_id },
        "OpenAPPA bypass active for a Cursor disconnect",
      );
    } else {
      logger.info(
        { sessionId: session.session_id },
        "OpenAPPA disconnect reference outside its chat; Guardrails apply",
      );
    }
  }
  const until = await cacheManager.get<number>(chatKey);
  if (until === undefined || until <= Date.now()) return undefined;
  const callId = step === "preToolUse" ? cursorCallId(event) : undefined;
  if (callId) {
    await recordUnenforcedCalls({
      organizationId: session.organization_id,
      sessionId: session.session_id,
      toolCallIds: [callId],
      reason: "made",
    });
  }
  return until;
}

/**
 * A step of the CLI process a web tool started. Its tool calls are ruled on
 * and their results checked in the calling chat's session, as a subagent's
 * are. Nothing else it reports concerns that chat: its prompt is the web
 * tool's own, its end is not the end of the chat's turn, and it shows no
 * marks, since no person reads its output.
 */
async function answerWebChildStep(params: {
  step: CursorHookRequest["step"];
  event: Record<string, unknown>;
  session: OpenAppaSession;
}): Promise<CursorHookAnswer> {
  const { step, event, session } = params;
  // The CLI keeps a copy of each web result in its own data folder and
  // reports the save as a write. The copy is the web tool's result, which
  // the calling chat's hook checks when the tool returns; nothing reads the
  // file, and a large result would not even fit a call's arguments.
  if (isWebResultCopy(event)) return {};
  switch (step) {
    case "preToolUse":
      return ruleOnCall({ session, event });
    case "postToolUse":
    case "postToolUseFailure":
      return reportResult(session, event, step === "postToolUseFailure");
    default:
      return {};
  }
}

/** A write of the CLI's own result copy, inside the web tools' data folder. */
function isWebResultCopy(event: Record<string, unknown>): boolean {
  if (stringField(event.tool_name) !== "Write") return false;
  const input = event.tool_input;
  const path =
    input && typeof input === "object"
      ? stringField(
          (input as Record<string, unknown>).file_path ??
            (input as Record<string, unknown>).path,
        )
      : undefined;
  return path !== undefined && WEB_RESULT_COPY.test(path.replace(/\\/g, "/"));
}

const WEB_RESULT_COPY = new RegExp(
  `/${CURSOR_WEB_CLI_DATA_DIRNAME}/projects/[^/]+/agent-tools/[^/]+$`,
);

async function answerStep(params: {
  step: CursorHookRequest["step"];
  event: Record<string, unknown>;
  session: OpenAppaSession;
}): Promise<CursorHookAnswer> {
  const { step, event, session } = params;
  const generationId = stringField(event.generation_id);
  switch (step) {
    case "sessionStart":
      // Cursor 3.30 accepts this context and does not pass it on to the
      // model, so nothing depends on it: a block message carries what the
      // model must do next, and a tool result's context carries the marks.
      return { additional_context: SESSION_CONTEXT() };
    case "beforeSubmitPrompt":
      // A prompt tells the runtime that the turn before it is over, and the
      // runtime then closes what that turn left open. A background subagent's
      // running call is not left over, so the prompt is not reported while
      // one runs: the runtime reads the new loop as more of the open turn.
      if (
        generationId &&
        (await openCalls(session, `turn_end:prompt:${generationId}`)) !==
          "subagent"
      )
        await notePrompt(session, `prompt:${generationId}`);
      return {};
    case "preToolUse":
      return ruleOnCall({ session, event });
    case "postToolUse":
    case "postToolUseFailure":
      return withMarks(
        session,
        event,
        await reportResult(session, event, step === "postToolUseFailure"),
      );
    case "afterAgentResponse":
      await settleMarks(session, stringField(event.text) ?? "");
      return {};
    case "stop":
      if (generationId) await endMainLoop(session, generationId);
      return {};
    case "subagentStart":
    case "subagentStop":
      return {};
  }
}

/**
 * Adds the Guardrails marks to what a tool result's hook answers. A subagent
 * is told to show its own marks in its own view. The main agent is told to
 * show the chat's session mark until an answer shows it, and that a
 * subagent's reply carries marks that are not part of the answer.
 */
async function withMarks(
  session: OpenAppaSession,
  event: Record<string, unknown>,
  answer: CursorHookAnswer,
): Promise<CursorHookAnswer> {
  const own = stringField(event.conversation_id);
  const subagent =
    stringField(event.tool_name) === SUBAGENT_TOOL
      ? startedSubagent(stringField(event.tool_output))
      : undefined;
  const context = [
    answer.additional_context,
    ...(isSubagentStep(event)
      ? [own && (await subagentMarkContext({ session, subagentId: own }))]
      : [await sessionMarkContext(session)]),
    subagent && (await subagentReplyNote({ session, ...subagent })),
  ].filter((part): part is string => Boolean(part));
  return context.length > 0
    ? { ...answer, additional_context: context.join("\n\n") }
    : answer;
}

/** The subagent a `Task` result names, when the call started one. */
function startedSubagent(
  output: string | undefined,
): { subagentId: string; background: boolean } | undefined {
  if (!output) return undefined;
  try {
    const result = JSON.parse(output) as Record<string, unknown>;
    const subagentId = stringField(result.agentId);
    if (!subagentId || result.status !== "success") return undefined;
    return { subagentId, background: result.isBackground === true };
  } catch {
    return undefined;
  }
}

/**
 * Cursor's main loop is over. A call of that loop still open then never
 * reports (the person refused or stopped it), so the runtime closes it
 * unreported. A background subagent keeps running past the main loop's end,
 * though: closing its open call would make the runtime refuse the result when
 * it arrives. The turn stays open while such a call runs, and the stop of the
 * loop Cursor starts when the subagents finish closes it.
 */
async function endMainLoop(
  session: OpenAppaSession,
  generationId: string,
): Promise<void> {
  const operationId = `turn_end:${generationId}`;
  if ((await openCalls(session, `${operationId}:hold`)) === "abandoned")
    await endTurn({ session, operationId });
}

/**
 * What the chat has open in the runtime: nothing, calls nobody will report
 * ("abandoned"), or a subagent's call that still runs.
 *
 * A chat no subagent called a tool in lately has no call that outlives its
 * loop, so whatever it has open is abandoned. Otherwise the runtime is asked
 * with a stop that holds on any open call; with nothing open that stop ends
 * the turn, which is over by then.
 */
async function openCalls(
  session: OpenAppaSession,
  operationId: string,
): Promise<"none" | "abandoned" | "subagent"> {
  if (!(await cacheManager.get<true>(subagentActiveKey(session))))
    return "abandoned";
  const stop = await endTurn({ session, operationId, answeredCallIds: [] });
  if (stop.decision !== "held") return "none";
  const running = await cacheManager.getMany<true>(
    stop.running.map((id) =>
      subagentOpenCallKey(session, id.replace(/^call:/, "")),
    ),
  );
  if (running.size === 0) return "abandoned";
  logger.debug(
    { sessionId: session.session_id, running: stop.running },
    "Guardrails keep a Cursor turn open while a subagent's call runs",
  );
  return "subagent";
}

async function ruleOnCall(params: {
  session: OpenAppaSession;
  event: Record<string, unknown>;
}): Promise<CursorHookAnswer> {
  const { session, event } = params;
  const id = cursorCallId(event);
  const rawName = stringField(event.tool_name);
  if (!id || !rawName) {
    return deny(
      "Cursor reported this tool call without an id or name, so Guardrails could not check it.",
    );
  }
  const unvouched = await cacheManager.get<UnvouchedReason | true>(
    unvouchedChatKey(session),
  );
  if (unvouched) return deny(UNVOUCHED_CHAT_REFUSAL(unvouched));
  const tool = cursorHookToolName(rawName);
  const input = policyInput(toolInput(event, tool));
  if (tool.gateway && isControlTool(tool.name)) {
    // Without an offer the call declares what a subagent may return, for
    // clients whose subagents get a session of their own. Here a subagent
    // shares the chat's session, so there is no return to declare.
    const offerId = stringField(input.offer_id);
    if (!offerId) return deny(RETURN_DECLARATION_REFUSAL());
    // An output sanitizer's plan promises the model the rewrite in place of
    // the raw result. Cursor hands the model the result of its own tools
    // before any hook sees it, so that promise cannot be kept for them.
    if (
      OUTPUT_SANITIZER_PLAN.test(stringField(input.plan) ?? "") &&
      (await cacheManager.get<true>(ownToolOfferKey(session, offerId)))
    )
      return deny(OUTPUT_SANITIZER_REFUSAL());
    // The gateway runs a remedy for the trajectory it names, the way the
    // proxy stamps it into the call. Model-written values are replaced.
    const {
      execution: _execution,
      trajectory: _trajectory,
      ...clientArguments
    } = input;
    return {
      updated_input: {
        ...clientArguments,
        execution: {
          v: 1,
          kind: "appa_remedy",
          call_id: id,
          tool_name: tool.name,
          original_arguments: JSON.stringify(clientArguments),
        },
        trajectory: currentTrajectory(session),
      },
    };
  }
  // Cursor shows a subagent's question only inside that subagent's own view,
  // and the main chat shows no sign of it, so the question usually waits out
  // its time unanswered. The subagent hands the matter to the agent that
  // started it instead: they share the chat's session, so that agent can run
  // the same plan and ask in the main chat.
  if (
    tool.gateway &&
    isGatewayTool(tool.name, ASK_USER_TOOL) &&
    isSubagentStep(event)
  )
    return deny(
      isReviewQuestion(tool.name, input)
        ? SUBAGENT_REVIEW_REFUSAL()
        : SUBAGENT_QUESTION_REFUSAL(),
    );
  const review = tool.gateway && isReviewQuestion(tool.name, input);
  // What the model wrote: a trajectory it supplied itself names no session.
  const { trajectory: _trajectory, ...clientArguments } = input;
  const [decision] = await evaluateToolCalls(
    session,
    [{ id, name: tool.name, arguments: review ? clientArguments : input }],
    { canonicalize: (name) => name },
  );
  if (decision.kind !== "deny") {
    // A subagent can outlive the loop that started it: its open call is
    // noted, so the end of that loop leaves it open (endMainLoop).
    if (isSubagentStep(event))
      await Promise.all(
        [subagentOpenCallKey(session, id), subagentActiveKey(session)].map(
          (key) =>
            cacheManager.set<true>(key, true, SUBAGENT_OPEN_CALL_LIFETIME_MS),
        ),
      );
    // The gateway runs a yell without this chat's session or call id, so
    // both wait for it under the arguments it does see, as the proxy leaves
    // them.
    if (tool.gateway)
      await rememberYellSession({
        session,
        call: { id, name: tool.name, arguments: input },
        resolution: GATEWAY_TOOL_NAMES,
      });
    // The CLI process this web call starts reports with the call's id.
    if (tool.web) {
      const webCallId = randomBytes(18).toString("base64url");
      await cacheManager.set<WebCall>(
        webCallKey({
          organizationId: session.organization_id,
          callerId: session.caller_id ?? "",
          id: webCallId,
        }),
        { session, agentId: stringField(event.conversation_id) ?? "" },
        WEB_CALL_LIFETIME_MS,
      );
      return {
        updated_input: { ...input, [CURSOR_WEB_CALL_ARGUMENT]: webCallId },
      };
    }
    // The gateway shows the review this chat's session holds for the offer,
    // and records the person's answer on it. The proxy names the session the
    // same way for its clients.
    return review
      ? {
          updated_input: {
            ...clientArguments,
            trajectory: currentTrajectory(session),
          },
        }
      : {};
  }
  if (decision.recorded) {
    // The call never runs, so its result is the ruling the runtime recorded.
    await processProxyResults({
      session,
      results: [{ id, name: tool.name, content: "", isError: true }],
      canonicalize: (name) => name,
    });
  }
  // The runtime's ruling states why it refused; a refusal before any ruling
  // carries its own guidance.
  const guidance = decision.recorded
    ? refusalGuidance(
        refusalAction({
          outcome: decision.outcome,
          offers: decision.offers,
          review: decision.review,
        }),
      )
    : "";
  // An MCP tool's result can be replaced before the model reads it, so every
  // plan of the ruling holds for a gateway tool and for a web tool.
  if (tool.gateway) return deny(decision.feedback + guidance);
  // The ruling names the call as policy does; the model knows the tool by
  // the name Cursor lists it under.
  if (tool.web)
    return deny(
      decision.feedback.replaceAll(
        new RegExp(`\\b${tool.name}\\b`, "g"),
        rawName.replace(/^mcp:/i, ""),
      ) + guidance,
    );
  // The offers of one of Cursor's own tools are remembered, so a sanitizer
  // plan among them is recognised when the model runs it.
  await Promise.all(
    (decision.offers ?? []).map((offerId) =>
      cacheManager.set<true>(
        ownToolOfferKey(session, offerId),
        true,
        OWN_TOOL_OFFER_LIFETIME_MS,
      ),
    ),
  );
  return deny(withoutOutputSanitizerPlans(decision.feedback) + guidance);
}

async function reportResult(
  session: OpenAppaSession,
  event: Record<string, unknown>,
  failed: boolean,
): Promise<CursorHookAnswer> {
  const id = cursorCallId(event);
  const rawName = stringField(event.tool_name);
  if (!id || !rawName) return {};
  if (isSubagentStep(event))
    await cacheManager.delete(subagentOpenCallKey(session, id));
  // A call that was refused, by Guardrails or by the person in Cursor's own
  // prompt, never ran: there is no result to check. Guardrails recorded its
  // own refusal when it ruled, and the turn's end closes a call a person
  // refused.
  if (failed && event.failure_type === "permission_denied") return {};
  const tool = cursorHookToolName(rawName);
  // The runtime released neither a remedy call nor a question, so it holds
  // no call to match their results against. A yell's result is the gateway's
  // own, which the model already has.
  if (
    tool.gateway &&
    (isControlTool(tool.name) ||
      isGatewayTool(tool.name, ASK_USER_TOOL) ||
      isYellToolShortName(archestraMcpBranding.getToolShortName(tool.name)))
  )
    return {};
  // The runtime never saw a call made while enforcement was off: nothing to
  // check it against.
  const unenforced = await findUnenforcedCalls({ session, toolCallIds: [id] });
  if (unenforced.reasons.has(id)) return {};
  const output = failed
    ? (stringField(event.error_message) ?? "")
    : (stringField(event.tool_output) ?? "");
  let toolResultUpdates: Awaited<
    ReturnType<typeof processProxyResults>
  >["toolResultUpdates"];
  try {
    ({ toolResultUpdates } = await processProxyResults({
      session,
      results: [
        {
          id,
          name: tool.name,
          arguments: policyInput(toolInput(event, tool)),
          content: output,
          isError: failed,
        },
      ],
      canonicalize: (name) => name,
    }));
  } catch (error) {
    // The proxy fails such a request; here the call already ran and its
    // output reached the model. The error's own advice, such as a retry, is
    // for a call that has not run, so the model gets none of it.
    if (!(error instanceof ApiError)) throw error;
    logger.warn(
      { err: error, sessionId: session.session_id, toolCallId: id },
      "Guardrails could not check a Cursor tool result",
    );
    return {
      additional_context: `${guardrails()} could not check the result of tool call ${id}. Treat that result as unchecked. The call already ran: do not make it again.`,
    };
  }
  const update = toolResultUpdates[id];
  const admitted =
    !update || (update.outputSource === "tool" && update.content === output);
  // A result matching no released call is only unchecked; any other refusal
  // withholds it.
  const withheld =
    !admitted &&
    update.refused === true &&
    update.code !== UNRELEASED_CALL_CODE;
  // The hook hands over only the start of a very long result, so the rest
  // was not checked. An MCP result is cut to the part that was. One of
  // Cursor's own tools has reached the model whole, like a withheld one. A
  // result the runtime refused is withheld whole, below.
  if (!failed && event.tool_output_truncated === true && !withheld) {
    logger.warn(
      { sessionId: session.session_id, toolCallId: id, checked: output.length },
      "Guardrails checked only the start of a Cursor tool result",
    );
    if (/^mcp:/i.test(rawName))
      return {
        updated_mcp_tool_output: `${update?.content ?? output}\n\n[${guardrails()} checked the first ${output.length} characters of this result and removed the rest, which was too long to check.]`,
      };
    await cacheManager.set<UnvouchedReason>(
      unvouchedChatKey(session),
      "unchecked",
      UNVOUCHED_CHAT_LIFETIME_MS,
    );
    return {
      additional_context: `${guardrails()} could check only the first ${output.length} characters of the result of tool call ${id}, and Cursor had already shown you all of it. Do not use the rest. ${UNVOUCHED_CHAT_REFUSAL("unchecked")}`,
    };
  }
  if (admitted) return {};
  logger.info(
    { sessionId: session.session_id, toolCallId: id },
    "Guardrails did not admit a Cursor tool result",
  );
  // Cursor lets a hook replace what the model reads of an MCP tool's result,
  // so the model gets what the runtime admitted.
  if (/^mcp:/i.test(rawName))
    return { updated_mcp_tool_output: update.content };
  // The model already has the output of one of Cursor's own tools. A result
  // the runtime knows nothing of is only unchecked. One the runtime withheld
  // or rewrote is different: the runtime keeps the chat's label as if the
  // model never read it, so nothing the chat does next can be vouched for.
  if (withheld) {
    await cacheManager.set<UnvouchedReason>(
      unvouchedChatKey(session),
      "withheld",
      UNVOUCHED_CHAT_LIFETIME_MS,
    );
    logger.warn(
      { sessionId: session.session_id, toolCallId: id },
      "A Cursor chat read a result that Guardrails withheld; its tool calls are refused from here on",
    );
    return {
      additional_context: `${guardrails()} withheld the result of tool call ${id}, but Cursor had already shown it to you: ${update.content} Do not use that result. ${UNVOUCHED_CHAT_REFUSAL()}`,
    };
  }
  return {
    additional_context: `${guardrails()} did not admit the result of tool call ${id}: ${update.content}`,
  };
}

/** Gateway tools reach a hook under the names the gateway gave them. */
const GATEWAY_TOOL_NAMES = {
  canonicalize: (name: string) => name,
  looseRunToolDispatch: false,
};

/** The runtime's wording of an output sanitizer's plan. */
const OUTPUT_SANITIZER_PLAN = /^Use sanitizer .+'s result$/;

const OUTPUT_SANITIZER_REFUSAL = () =>
  guardrails() +
  " did not run this plan: a sanitizer's rewrite would have to replace the tool's result before you read it, and Cursor gives its own tools' results to you directly. " +
  "Choose another plan from the block message, or stop and tell the user.";

/**
 * Why nothing a chat does next can be vouched for: it read a result the
 * runtime withheld, or one the hook could only hand over in part.
 */
type UnvouchedReason = "withheld" | "unchecked";

// `true` is what a chat was marked with before the reasons were told apart.
const UNVOUCHED_CHAT_REFUSAL = (reason: UnvouchedReason | true = "withheld") =>
  guardrails() +
  " refuses the tool calls of this chat: it read a tool result " +
  (reason === "unchecked"
    ? "that was too large to check, and Cursor gives its own tools' results to you before they are checked. "
    : "that your organization's policy required to be withheld, which Cursor does not allow for its own tools. ") +
  "Tell the user to continue in a new chat.";

const OWN_TOOL_OFFER_LIFETIME_MS = TimeInMs.Day;
const UNVOUCHED_CHAT_LIFETIME_MS = TimeInMs.Day * 30;

const RETURN_DECLARATION_REFUSAL = () =>
  guardrails() +
  " did not run this declaration: in Cursor a subagent works inside this chat's session, so what it returns needs none. " +
  "Start the subagent with the Task tool now. It keeps this chat's restrictions, and what it reads restricts this chat too.";

const SUBAGENT_QUESTION_UNSEEN = () =>
  guardrails() +
  " did not send this question: Cursor shows a subagent's question only inside the subagent's own view, where the person is unlikely to see it. ";

// The subagent's own execute_remedy_plan call already opened the review, so
// the agent that started it asks first: running the plan again before the
// question only answers that nothing was recorded.
const SUBAGENT_REVIEW_REFUSAL = () =>
  SUBAGENT_QUESTION_UNSEEN() +
  "Do not ask again and do not retry the blocked call. Finish with a report to the agent that started you: say which call is blocked, quote the offer_id and plan from its block message, and say that the review for that offer is already open. " +
  "That agent asks the person in the main chat with ask_user and the offer ID in remedy_offer_ids, and calls execute_remedy_plan only after the person has approved.";

const SUBAGENT_QUESTION_REFUSAL = () =>
  SUBAGENT_QUESTION_UNSEEN() +
  "Do not ask again. Finish with a report to the agent that started you and put the question in it: that agent can ask the person in the main chat.";

/** Cursor's tool that starts a subagent. */
const SUBAGENT_TOOL = "Task";

const SUBAGENT_ROOT_LIFETIME_MS = TimeInMs.Day * 7;
// Longer than a tool call runs: a call whose result never comes (Cursor was
// closed, the subagent was stopped) holds the turn open no longer than this.
const SUBAGENT_OPEN_CALL_LIFETIME_MS = TimeInMs.Hour;

/**
 * The session for one Cursor chat. Cursor names each chat with its own
 * conversation id, scoped here to the caller like a proxy session header. A
 * subagent has a conversation id of its own and names the agent that started
 * it, so its steps join that agent's chat.
 */
async function cursorSession(params: {
  organizationId: string;
  userId: string;
  event: Record<string, unknown>;
  step: CursorHookRequest["step"];
}): Promise<OpenAppaSession | undefined> {
  const { event } = params;
  const own = stringField(event.conversation_id);
  if (!own) return undefined;
  const parent = stringField(event.parent_agent_id);
  let conversationId = own;
  if (parent && parent !== own) {
    // The parent is a subagent itself when it started this one from a
    // subagent: Cursor names only the direct parent, so the chat is found
    // through what that parent left when it called its own Task.
    const scope = {
      organizationId: params.organizationId,
      userId: params.userId,
    };
    conversationId =
      (await cacheManager.get<string>(
        subagentRootKey({ ...scope, conversationId: parent }),
      )) ?? parent;
    if (
      params.step === "preToolUse" &&
      stringField(event.tool_name) === SUBAGENT_TOOL
    )
      await cacheManager.set<string>(
        subagentRootKey({ ...scope, conversationId: own }),
        conversationId,
        SUBAGENT_ROOT_LIFETIME_MS,
      );
  }
  const callerId = callerIdOf(params.userId);
  const sessionId = `${callerId}|cursor-${conversationId}`;
  if (!isWellFormedAppaId(sessionId)) return undefined;
  return {
    organization_id: params.organizationId,
    caller_id: callerId,
    session_id: sessionId,
    presenter: "attended",
  };
}

/**
 * A ruling without the plans that route a result through an output
 * sanitizer, and without the runtime's note about them: one of Cursor's own
 * tools cannot take such a plan, so the model is not offered it.
 */
function withoutOutputSanitizerPlans(feedback: string): string {
  const lines = feedback.split("\n");
  const kept = lines.filter(
    (line) =>
      !/^\s*- \S*execute_remedy_plan\(offer_id: "[^"]+", plan: "Use sanitizer .+'s result"\)\s*$/.test(
        line,
      ) && !/^\s*An output sanitizer above can admit this result\b/.test(line),
  );
  return kept.length === lines.length ? feedback : kept.join("\n");
}

function ownToolOfferKey(
  session: OpenAppaSession,
  offerId: string,
): AllowedCacheKey {
  return `${CacheKey.CursorOwnToolOffer}-${sessionDigest(session, offerId)}`;
}

function subagentOpenCallKey(
  session: OpenAppaSession,
  callId: string,
): AllowedCacheKey {
  return `${CacheKey.CursorSubagentOpenCall}-${sessionDigest(session, callId)}`;
}

function subagentActiveKey(session: OpenAppaSession): AllowedCacheKey {
  return `${CacheKey.CursorSubagentActive}-${sessionDigest(session)}`;
}

function unvouchedChatKey(session: OpenAppaSession): AllowedCacheKey {
  return `${CacheKey.CursorUnvouchedChat}-${sessionDigest(session)}`;
}

function sessionDigest(session: OpenAppaSession, ...rest: string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([session.organization_id, session.session_id, ...rest]),
    )
    .digest("base64url");
}

/** A step of a subagent: Cursor names the agent that started it. */
function isSubagentStep(event: Record<string, unknown>): boolean {
  const parent = stringField(event.parent_agent_id);
  return parent !== undefined && parent !== stringField(event.conversation_id);
}

function subagentRootKey(params: {
  organizationId: string;
  userId: string;
  conversationId: string;
}): AllowedCacheKey {
  return `${CacheKey.CursorSubagentRoot}-${createHash("sha256")
    .update(
      JSON.stringify([
        params.organizationId,
        params.userId,
        params.conversationId,
      ]),
    )
    .digest("base64url")}`;
}

/**
 * The id Guardrails knows a Cursor tool call by: Cursor's id, the tool's name
 * and a digest of the call's input. Cursor's id alone does not name one call.
 * It gives one id to a read and the write that follows it, and one id to
 * every file it saves a web result into, so two calls of one tool can share
 * it. It also joins two ids with a line break for some calls, which the
 * runtime refuses; those get a digest in place of the id. A call's input is
 * the same before and after it runs, so both steps name it alike.
 */
function cursorCallId(event: Record<string, unknown>): string | undefined {
  const id = stringField(event.tool_use_id);
  const tool = stringField(event.tool_name);
  if (!id || !tool) return undefined;
  // A web call's result names the call with the id Guardrails added to its
  // arguments, which is no part of what the model asked for.
  const hookTool = cursorHookToolName(tool);
  const input = createHash("sha256")
    .update(
      canonicalJson(
        hookTool.web ? toolInput(event, hookTool) : (event.tool_input ?? null),
      ),
    )
    .digest("hex")
    .slice(0, 12);
  const readable = `${id}:${tool}:${input}`;
  if (
    isWellFormedAppaId(readable) &&
    readable.length <= MAX_CURSOR_CALL_ID_LENGTH
  )
    return readable;
  return `cursor-call-${createHash("sha256").update(`${id}\0${tool}\0${input}`).digest("hex").slice(0, 32)}`;
}

/**
 * A Model Router model, `<provider>:<model>`, sends the chat through the LLM
 * proxy, which rules on it. Cursor's own model names have no provider prefix.
 */
function routedThroughProxy(model: unknown): boolean {
  const name = stringField(model);
  if (!name) return false;
  const separator = name.indexOf(":");
  return (
    separator > 0 &&
    separator < name.length - 1 &&
    SupportedProviders.some((provider) => provider === name.slice(0, separator))
  );
}

/**
 * Cursor reports an MCP tool as `MCP:<tool>`. Gateway tools carry their
 * catalog in the tool name (`<catalog>__<tool>`); any other name is one of
 * Cursor's own tools, which policy names `host/archestra/<tool>`.
 *
 * The two web tools setup installs stand in for Cursor's own web search and
 * web fetch, so policy reads them under those tools' names: the rules a
 * policy has for a web search and for a URL fetch are the ones that apply.
 */
function cursorHookToolName(raw: string): CursorHookTool {
  const mcp = /^mcp:/i.exec(raw);
  const name = mcp ? raw.slice(mcp[0].length) : raw;
  const web = mcp ? WEB_TOOL_POLICY_NAMES.get(name) : undefined;
  if (web) return { name: web, gateway: false, web: true };
  // Their setup tool reads nothing from the web and starts no CLI process
  // that reports here; policy names it like one of Cursor's own tools.
  if (mcp && name === CURSOR_WEB_SETUP_TOOL)
    return { name: CURSOR_WEB_SETUP_POLICY_TOOL, gateway: false, web: false };
  return { name, gateway: mcp !== null || name.includes("__"), web: false };
}

type CursorHookTool = {
  name: string;
  gateway: boolean;
  /** One of the web tools setup installs. */
  web: boolean;
};

const WEB_TOOL_POLICY_NAMES = new Map([
  [CURSOR_WEB_SEARCH_TOOL, "WebSearch"],
  [CURSOR_WEB_FETCH_TOOL, "WebFetch"],
]);

/** The calling chat's session and agent, kept under a web call's id. */
type WebCall = { session: OpenAppaSession; agentId: string };

// Longer than a web call runs, CLI startup and a slow search included.
const WEB_CALL_LIFETIME_MS = TimeInMs.Minute * 10;

/** A web call's id names a chat only to the caller whose chat it is. */
function webCallKey(params: {
  organizationId: string;
  callerId: string;
  id: string;
}): AllowedCacheKey {
  return `${CacheKey.CursorWebCall}-${createHash("sha256")
    .update(JSON.stringify([params.organizationId, params.callerId, params.id]))
    .digest("base64url")}`;
}

/** Scoped to the caller: a chat id or a reference names nothing to anyone else. */
function disconnectChatKey(
  session: OpenAppaSession,
  kind: "chat" | "owner",
): AllowedCacheKey {
  return `${CacheKey.CursorDisconnectChat}-${createHash("sha256")
    .update(
      JSON.stringify([
        kind,
        session.organization_id,
        session.caller_id,
        session.session_id,
      ]),
    )
    .digest("base64url")}`;
}

function callerIdOf(userId: string): string {
  return `user:${userId}`;
}

/**
 * A call's arguments as the model wrote them. The id Guardrails add to an
 * allowed web call is not one of them: Cursor reports the call's result with
 * the id in place, and a model may not supply one.
 */
function toolInput(
  event: Record<string, unknown>,
  tool: CursorHookTool,
): Record<string, unknown> {
  const input = objectField(event.tool_input) ?? {};
  if (!tool.web || !(CURSOR_WEB_CALL_ARGUMENT in input)) return input;
  const { [CURSOR_WEB_CALL_ARGUMENT]: _webCall, ...written } = input;
  return written;
}

/**
 * The arguments as the policy reads them. On Windows Cursor spells a file
 * path with backslashes, and the policy's path selectors read `/`.
 */
function policyInput(input: Record<string, unknown>): Record<string, unknown> {
  const filePath = input.file_path;
  return typeof filePath === "string" && filePath.includes("\\")
    ? { ...input, file_path: filePath.replaceAll("\\", "/") }
    : input;
}

function isControlTool(name: string): boolean {
  return isGatewayTool(name, CONTROL_TOOL);
}

function isGatewayTool(name: string, shortName: string): boolean {
  return archestraMcpBranding.getToolShortName(name) === shortName;
}

/**
 * An ask_user call that names remedy offers asks for a review's answer. The
 * bounds are the proxy's: one to twelve distinct offer ids, nothing else.
 */
function isReviewQuestion(
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (!isGatewayTool(name, ASK_USER_TOOL)) return false;
  const ids = input.remedy_offer_ids;
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= MAX_REVIEW_OFFERS &&
    ids.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(ids).size === ids.length
  );
}

/**
 * Cursor gives the model only `user_message` of a denied call, as
 * "Rejected: <user_message>", and shows the same text to the person. So the
 * whole ruling goes there: the model needs the reason and the remedy plans.
 * `agent_message` repeats it for a Cursor that reads it.
 */
function deny(feedback: string): CursorHookAnswer {
  return {
    permission: "deny",
    user_message: feedback,
    agent_message: feedback,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
