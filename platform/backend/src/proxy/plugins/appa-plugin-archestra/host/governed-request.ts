import logger from "@/logging";
import { prepareAppaRequest } from "@/openappa/request";
import {
  refuseSoftBlock,
  softBlocksAllowed,
  waiveSoftBlock,
} from "@/openappa/soft-block";
import {
  echoedCallsMessage,
  GovernedThread,
  readThreadRequest,
  type ThreadRecord,
  threadAlreadyContinuedBody,
  threadNotFoundBody,
  threadStates,
  threadToolsOf,
  threadUnsupportedBody,
  toolSkeletonOf,
} from "@/openappa/thread-state";
import { type AppaSessionIdentity, declaredToolEntries } from "@/openappa/wire";
import type { OpenappaAdmission } from "@/proxy/plugins/appa-plugin-archestra/host/admission";
import type { OpenappaIngress } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import {
  APPA_PLUGIN_RETAINED_SHAPE,
  APPA_PLUGIN_TRUSTED_CONTEXT,
  type AppaRetainedShape,
  type AppaTrustedContext,
} from "@/proxy/plugins/appa-plugin-archestra/types";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import type { GatewayToolDeclaration } from "@/routes/proxy/utils/gateway-tool-declarations";
import {
  type GatewayClientBindings,
  type GatewayToolIdentity,
  resolveGatewayToolIdentity,
} from "@/routes/proxy/utils/gateway-tool-names";
import { ApiError } from "@/types";

/**
 * Prepares the request OpenAPPA governs or observes for the plugin: the body
 * the ruling reads, the provider thread it continues, and the trusted
 * context the plugin binds the session from. Mutates `body` in place. A
 * thread continue the proxy cannot resume makes the client replay the
 * whole thread instead.
 */
export async function prepareOpenappaRequest(
  params: Omit<GovernedRequestParams, "admission"> & {
    admission: Exclude<OpenappaAdmission, { kind: "ungoverned" }>;
  },
): Promise<PreparedOpenappaRequest> {
  const { admission } = params;
  if (admission.kind === "waived") {
    retainWaivedRequestShape({ ...params, admission });
    return { kind: "prepared" };
  }
  const governedParams = { ...params, admission };
  if (!(await softBlocksAllowed()) || admission.kind !== "governed")
    return governedRequest(governedParams);
  const original = structuredClone(params.body);
  try {
    const result = await governedRequest(governedParams);
    if (result.kind === "replay")
      await refuseSoftBlock("OpenAPPA could not continue the provider thread");
    return result;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !(await waiveSoftBlock(
        admission.session,
        "request_preparation",
        error.message,
      ))
    )
      throw error;
    restoreBody(params.body, original);
    params.context.resources.delete(APPA_PLUGIN_TRUSTED_CONTEXT);
    return { kind: "prepared" };
  }
}

type GovernedRequestParams = {
  admission: Exclude<OpenappaAdmission, { kind: "ungoverned" | "waived" }>;
  context: LlmProxyRequestContext;
  body: unknown;
  ingress: OpenappaIngress;
  tools: {
    identity: GatewayToolIdentity;
    declarations: readonly GatewayToolDeclaration[];
    clientBindings: GatewayClientBindings | undefined;
  };
};

async function governedRequest(
  params: GovernedRequestParams,
): Promise<PreparedOpenappaRequest> {
  const { admission, context, body, ingress, tools } = params;
  if (admission.kind === "observed") {
    context.resources.set(
      APPA_PLUGIN_TRUSTED_CONTEXT,
      admission.trustedContext,
    );
    return { kind: "prepared" };
  }
  const isInternalChat = admission.facts.chatSource !== undefined;
  let thread: GovernedThread | undefined;
  // Restores this request's denial notices and resolves its APPA tools,
  // in the request body the adapters read from, before the provider
  // request and the tool results are built from it.
  // Unsupported declarations are rejected; proxy-only clients without
  // gateway remedies are still governed and receive text refusals.
  // A provider-side thread continue carries no tools: the proxy rules
  // with the ones the thread was created with, and never sends them.
  let appaToolIdentity = tools.identity;
  // A stored response keeps the conversation (and tools) at the provider,
  // so the request in hand is only a delta that the ruling cannot read.
  // Refused rather than ruled on blind.
  if (
    context.interactionType.endsWith(":responses") &&
    (body as { previous_response_id?: unknown }).previous_response_id
  ) {
    throw new ApiError(
      400,
      "OpenAPPA cannot govern a Responses request that continues a stored response (previous_response_id). Send the whole conversation as input instead.",
    );
  }
  const threadRequest =
    context.interactionType === "anthropic:messages"
      ? readThreadRequest(body)
      : undefined;
  if (threadRequest) {
    const declaresTools = declaredToolEntries(body).length > 0;
    const previousMessageId =
      threadRequest.type === "continue"
        ? threadRequest.previousMessageId
        : undefined;
    const found =
      threadRequest.type === "continue"
        ? await threadStates.forContinue({
            organizationId: context.organizationId,
            sessionId: admission.session.session_id,
            previousMessageId: threadRequest.previousMessageId,
          })
        : undefined;
    if (found && !found.ok) {
      logger.info(
        {
          sessionId: admission.session.session_id,
          reason: found.reason,
          proxyRequestId: `req_archestra_${context.requestId}`,
        },
        "OpenAPPA forces a governed thread to replay",
      );
      // A store that cannot be read makes the client go stateless.
      if (found.reason === "unavailable")
        return {
          kind: "replay",
          status: 400,
          body: threadUnsupportedBody(context.requestId),
        };
      if (found.reason === "consumed")
        return {
          kind: "replay",
          status: 400,
          body: threadAlreadyContinuedBody(context.requestId),
        };
      return {
        kind: "replay",
        status: 404,
        body: threadNotFoundBody(context.requestId),
      };
    }
    const state = found?.ok ? found : undefined;
    let threadRecord: ThreadRecord;
    let continuation:
      | { deltaSystem: unknown; echoedCalls?: object }
      | undefined;
    if (state) {
      // The system prompt of a continue is the client's own delta.
      continuation = {
        deltaSystem: structuredClone((body as { system?: unknown }).system),
      };
      // The results answer calls the thread holds: put them back, as a
      // full request would carry them, for the ruling only.
      const messages = (body as { messages?: unknown }).messages;
      if (state.calls.length > 0 && Array.isArray(messages)) {
        continuation.echoedCalls = echoedCallsMessage(state.calls);
        messages.unshift(continuation.echoedCalls);
      }
    }
    if (state && !declaresTools) {
      (body as { tools?: unknown }).tools = toolSkeletonOf(state.tools);
      appaToolIdentity = await resolveGatewayToolIdentity({
        organizationId: context.organizationId,
        declarations: state.tools,
        internalChat: isInternalChat,
        clientBindings: tools.clientBindings,
      });
      threadRecord = {
        organizationId: context.organizationId,
        sessionId: admission.session.session_id,
        rootMessageId: state.rootMessageId,
        ...(previousMessageId ? { previousMessageId } : {}),
      };
    } else {
      // A create, or a continue that sends changed tools: they become
      // the thread's tools from this response on.
      threadRecord = {
        organizationId: context.organizationId,
        sessionId: admission.session.session_id,
        tools: threadToolsOf({
          declarations: tools.declarations,
          types: declaredToolEntries(body).map(
            (entry) => (entry.tool as { type?: string } | null)?.type,
          ),
        }),
        ...(previousMessageId ? { previousMessageId } : {}),
      };
    }
    thread = new GovernedThread({
      record: threadRecord,
      ...(continuation
        ? {
            continuation: {
              ...continuation,
              hydratedTools: !declaresTools,
            },
          }
        : {}),
    });
  }
  const appaRequest = prepareBody({
    body,
    context,
    ingress,
    session: admission.identity,
    identity: appaToolIdentity,
    isInternalChat,
  });
  context.resources.set(APPA_PLUGIN_TRUSTED_CONTEXT, {
    session: admission.session,
    profileId: context.profileId,
    toolIdentity: appaToolIdentity,
    request: appaRequest,
    ...admission.facts,
    compaction: ingress.clientCompaction && !isInternalChat,
    enforcement: "active",
    childReturnRefusal: ingress.childReturnRefusal,
    ...(threadRequest ? { thread: threadRequest.type } : {}),
  } satisfies AppaTrustedContext);
  return { kind: "prepared", ...(thread ? { thread } : {}) };
}

/**
 * Changing the tools or the system prompt mid-session would invalidate the
 * provider's prompt cache. This only rewrites the body: nothing is ruled on
 * and the plugin binds no session. A body it cannot rewrite goes out as sent.
 */
function retainWaivedRequestShape(params: {
  admission: Extract<OpenappaAdmission, { kind: "waived" }>;
  context: LlmProxyRequestContext;
  body: unknown;
  ingress: OpenappaIngress;
  tools: { identity: GatewayToolIdentity };
}): void {
  const { admission, context, body, ingress, tools } = params;
  const original = structuredClone(body);
  try {
    // These carry a delta, which no governed request of the session reshaped.
    if (
      readThreadRequest(body)?.type === "continue" ||
      (body as { previous_response_id?: unknown }).previous_response_id
    )
      return;
    const isInternalChat = admission.facts.chatSource !== undefined;
    const request = prepareBody({
      body,
      context,
      ingress,
      session: admission.identity,
      identity: tools.identity,
      isInternalChat,
    });
    if (ingress.clientCompaction && !isInternalChat) return;
    context.resources.set(APPA_PLUGIN_RETAINED_SHAPE, {
      adapter: admission.adapter,
      identity: tools.identity,
      request,
    } satisfies AppaRetainedShape);
  } catch (err) {
    logger.debug({ err }, "OpenAPPA could not keep a waived request's shape");
    restoreBody(body, original);
  }
}

function prepareBody(params: {
  body: unknown;
  context: LlmProxyRequestContext;
  ingress: OpenappaIngress;
  session: AppaSessionIdentity;
  identity: GatewayToolIdentity;
  isInternalChat: boolean;
}) {
  const { ingress } = params;
  return prepareAppaRequest({
    body: params.body,
    interactionType: params.context.interactionType,
    session: params.session,
    identity: params.identity,
    trustBarePlatformTools: params.isInternalChat,
    ...(ingress.delegationMarkers
      ? { delegationMarkers: ingress.delegationMarkers }
      : {}),
    ...(ingress.childReturns ? { childReturns: ingress.childReturns } : {}),
    ...(ingress.releasedSpawnCalls
      ? { releasedSpawnCalls: ingress.releasedSpawnCalls }
      : {}),
    ...(ingress.childTrajectoryReceipts
      ? { childTrajectoryReceipts: ingress.childTrajectoryReceipts }
      : {}),
    ...(ingress.clientWire ? { clientWire: ingress.clientWire } : {}),
  });
}

function restoreBody(body: unknown, original: unknown): void {
  if (!body || typeof body !== "object") return;
  if (!original || typeof original !== "object") return;
  for (const key of Object.keys(body))
    delete (body as Record<string, unknown>)[key];
  Object.assign(body, original);
}

// ===

type PreparedOpenappaRequest =
  /** The provider error the client answers by replaying the whole thread. */
  | { kind: "replay"; status: 400 | 404; body: object }
  | { kind: "prepared"; thread?: GovernedThread };
