import { APPA_SESSION_HEADER } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import config from "@/config";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import { scopedSessionId } from "@/openappa/actor";
import { forkedSession } from "@/openappa/lineage";
import {
  APPA_PARENT_HEADER,
  type AppaChatSource,
  isAppaDelegatedRun,
  isWellFormedAppaId,
  type OpenAppaSession,
  sessionFromHeaders,
} from "@/openappa/service";
import {
  APPA_SUBAGENT_BINDING_HEADER,
  verifySubagentBinding,
} from "@/openappa/subagent-binding";
import { stampedSessions } from "@/openappa/trajectory-stamp";
import { startedUnenforced } from "@/openappa/unenforced";
import {
  type AppaSessionIdentity,
  type AppaWireFamily,
  appaWireFamily,
  sessionReceiptEvidence,
} from "@/openappa/wire";
import type { OpenappaIngress } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import {
  APPA_CLIENT_ADAPTERS,
  appaTrajectory,
  extractAppaSessionIdentity,
  nativeSpawnParentId,
} from "@/proxy/plugins/appa-plugin-archestra/session-identity";
import type { AppaTrustedContext } from "@/proxy/plugins/appa-plugin-archestra/types";
import type { GatewayToolIdentity } from "@/routes/proxy/utils/gateway-tool-names";
import {
  RUNTIME_BINDING_HEADER,
  resolveRuntimeIdentityByVirtualKeys,
  resolveRuntimeSessionForWorkspace,
  runtimeBindingAuthorizes,
  runtimeSessionConflicts,
} from "@/services/agent-runtime/runtime-identity";
import {
  carriesConnectionSetupReference,
  connectionProxySetupContext,
  readVerifiedConnectionProxySetup,
} from "@/services/connection-proxy-setup-context";
import { claimConnectionSetupConversation } from "@/services/connection-setup-conversation-claim";
import { nativeSetupClientFromProvenance } from "@/services/connection-setup-scope";
import { ApiError } from "@/types";
import type { UnsupportedAppaClientAction } from "@/types/guardrails-policy";

/**
 * Whether this request is the installer's own conversation under an approved
 * connection setup, which OpenAPPA lets through ungoverned. The conversation
 * claim is recorded whether or not OpenAPPA is active.
 */
export async function resolveInstallerSetupBypass(params: {
  request: FastifyRequest;
  body: unknown;
  agent: { id: string; organizationId: string };
  virtualKeyIds: readonly (string | undefined)[];
  appaActive: boolean;
}): Promise<boolean> {
  const { request, body, agent, appaActive } = params;
  const approvedProxySetupContext = connectionProxySetupContext(request.raw);
  let verifiedProxySetup: ReturnType<typeof readVerifiedConnectionProxySetup>;
  if (approvedProxySetupContext) {
    for (const keyId of params.virtualKeyIds) {
      if (!keyId) continue;
      verifiedProxySetup = readVerifiedConnectionProxySetup({
        token: approvedProxySetupContext,
        organizationId: agent.organizationId,
        virtualApiKeyId: keyId,
        proxyAgentId: agent.id,
        secret: config.auth.secret,
      });
      if (verifiedProxySetup) break;
    }
  }
  const approvedProxySetup = verifiedProxySetup !== undefined;
  // The setup URL stays in the client's settings for the whole window, so
  // sessions started after the setup send it too. The reference must be in
  // this request, and the first well-formed native conversation to present
  // it owns the exemption until the token expires.
  const carriesReference =
    approvedProxySetup &&
    !!approvedProxySetupContext &&
    carriesConnectionSetupReference({
      token: approvedProxySetupContext,
      requestBody: body,
      secret: config.auth.secret,
    });
  const installerConversation =
    carriesReference &&
    verifiedProxySetup !== undefined &&
    (await claimConnectionSetupConversation({
      organizationId: verifiedProxySetup.organizationId,
      setupId: verifiedProxySetup.setupId,
      expiresAt: verifiedProxySetup.expiresAt,
      headers: request.headers,
      requestBody: body,
    }));
  const installerSetupBypass = appaActive && installerConversation;
  if (installerSetupBypass) {
    logger.info(
      { profileId: agent.id, proof: "approved-installer" },
      "OpenAPPA bypass active for connection setup",
    );
  } else if (appaActive && approvedProxySetup) {
    logger.info(
      { profileId: agent.id },
      "OpenAPPA connection setup URL outside the installer's conversation; Guardrails apply",
    );
  }
  return installerSetupBypass;
}

/**
 * Decides whether OpenAPPA governs this request, only observes it, or leaves
 * it alone, and binds the session it governs. Throws the refusals of an
 * enforced deployment. Fills the APPA session headers in `request.headers`
 * that the plugin and the provider-bound request read.
 */
export async function admitOpenappaRequest(params: {
  request: FastifyRequest;
  body: unknown;
  /** The request body the plugin reads, as the request adapter holds it. */
  originalRequest: unknown;
  interactionType: string;
  agent: { id: string; organizationId: string };
  principal: OpenappaPrincipal;
  deployment: OpenappaDeployment;
  /** Set for the proxy's loopback Chat call path. */
  chatSource: AppaChatSource | undefined;
  externalAgentId: string | undefined;
  /** A call this process proved it made itself (in-process or guardrail proof). */
  inProcessRequest: boolean;
  /** A guardrail call: the platform's own annotator or review model. */
  internalCall: boolean;
  installerSetupBypass: boolean;
  ingress: OpenappaIngress;
  toolIdentity: GatewayToolIdentity;
}): Promise<OpenappaAdmission> {
  const { request, body, agent, principal, chatSource, ingress } = params;
  const headers = request.headers as Record<
    string,
    string | string[] | undefined
  >;
  const { active: appaActive, observing: appaObserving } = params.deployment;
  const {
    authenticatedUserId,
    authenticatedApp,
    virtualKeyId,
    passthroughVirtualKeyId,
  } = principal;
  const { installerSetupBypass } = params;
  const isInternalChat = chatSource !== undefined;
  // Captures raw client headers before conversion to X-Appa-* headers.
  // Child trajectory validation checks against these original claims.
  const claims = {
    sessionId: firstHeaderValue(headers[APPA_SESSION_HEADER.toLowerCase()]),
    parentId: firstHeaderValue(headers[APPA_PARENT_HEADER.toLowerCase()]),
  };
  // APPA recognizes Chat only after the loopback caller's owner,
  // organization, profile, and conversation root have been bound below.
  // Internal agents (Chat, Slack, A2A, etc.) share the loopback boundary.
  // External clients still need platform authentication; a session ID or
  // user attribution header alone is not a credential.
  const isInternalRequest = params.inProcessRequest;
  if (
    appaActive &&
    !isInternalRequest &&
    !authenticatedUserId &&
    !authenticatedApp &&
    !virtualKeyId
  ) {
    throw new ApiError(401, "OpenAPPA requires an authenticated proxy request");
  }
  // The person behind the request, when the platform authenticated one.
  // A platform request over loopback names its user in a header the
  // platform itself wrote; a request that brings a credential of its own
  // is a client's, and its user is what that credential proves, not what
  // a header says: over the frontend's loopback rewrite the header is
  // anyone's to write. Chat keeps the header: its conversation is
  // ownership-checked against it below.
  const appaUserId =
    authenticatedUserId ??
    (isInternalRequest &&
    (isInternalChat || (!authenticatedApp && !virtualKeyId))
      ? principal.userId
      : undefined);
  // A delegated run an OpenAPPA spawn bound to a child trajectory carries
  // the executor's signed binding; its turns run on that trajectory.
  const subagentToken = isInternalRequest
    ? firstHeaderValue(headers[APPA_SUBAGENT_BINDING_HEADER.toLowerCase()])
    : undefined;
  const subagentBinding = subagentToken
    ? verifySubagentBinding(subagentToken, {
        organizationId: agent.organizationId,
        agentId: agent.id,
      })
    : null;
  // A child that claims a trajectory it cannot prove must not run unbound.
  if (appaActive && subagentToken && !subagentBinding) {
    throw new ApiError(403, "OpenAPPA subagent binding is invalid or expired");
  }
  // Other delegated A2A runs share the parent's logging session, but have
  // no APPA child-return lifecycle. Keep their events out of that
  // trajectory; the existing guardrails still evaluate the child
  // independently. Only the trusted internal executor's agent chain
  // selects this path.
  const delegatedRun =
    !subagentBinding &&
    isInternalRequest &&
    isAppaDelegatedRun(agent.id, params.externalAgentId);
  const runtimeLookup =
    (appaActive || appaObserving) && (virtualKeyId || passthroughVirtualKeyId)
      ? await resolveRuntimeIdentityByVirtualKeys({
          virtualKeyIds: [virtualKeyId, passthroughVirtualKeyId],
          organizationId: agent.organizationId,
        })
      : { status: "unbound" as const };
  if (
    appaActive &&
    !installerSetupBypass &&
    runtimeLookup.status === "conflict"
  ) {
    throw new ApiError(
      400,
      "OpenAPPA runtime credentials do not name one workspace",
    );
  }
  const runtimeIdentity =
    runtimeLookup.status === "bound" ? runtimeLookup.identity : null;
  if (
    runtimeIdentity?.actorKind === "user" &&
    appaUserId &&
    appaUserId !== runtimeIdentity.actorId
  ) {
    throw new ApiError(
      401,
      "OpenAPPA runtime credential does not match the authenticated user",
    );
  }
  const presentedRuntimeSession = claims.sessionId;
  if (
    appaActive &&
    !installerSetupBypass &&
    runtimeIdentity &&
    runtimeSessionConflicts({
      workloadName: runtimeIdentity.workloadName,
      presentedSession: presentedRuntimeSession,
    })
  ) {
    throw new ApiError(
      400,
      "OpenAPPA session does not match the authenticated runtime workspace",
    );
  }
  const runtimeBindingToken = firstHeaderValue(
    headers[RUNTIME_BINDING_HEADER.toLowerCase()],
  );
  const runtimeBindingMatches =
    runtimeIdentity !== null &&
    runtimeBindingAuthorizes({
      token: runtimeBindingToken,
      secret: config.openappa.offerSigningSecret,
      identity: runtimeIdentity,
    });
  if (
    appaActive &&
    !installerSetupBypass &&
    runtimeIdentity &&
    !runtimeBindingMatches
  ) {
    // An image whose client predates the binding sends none. Only that
    // case is named: why a presented binding failed stays undisclosed.
    const bindingMissing = !runtimeBindingToken;
    logger.warn(
      {
        agentId: runtimeIdentity.agentId,
        workspaceId: runtimeIdentity.workspaceId,
        taskId: runtimeIdentity.taskId,
        reason: bindingMissing ? "missing" : "invalid",
      },
      "OpenAPPA rejected a runtime request without a verified binding",
    );
    throw new ApiError(
      400,
      bindingMissing
        ? "This run's image did not send the X-Archestra-Runtime-Binding header that Guardrails require. Rebuild the image on a current maintained agent image, or send ARCHESTRA_AGENT_RUNTIME_BINDING in that header. Then start a new run."
        : "OpenAPPA runtime binding does not match this run",
    );
  }
  const runtimeSession =
    runtimeIdentity && runtimeBindingMatches
      ? (
          await resolveRuntimeSessionForWorkspace({
            organizationId: runtimeIdentity.organizationId,
            workspaceId: runtimeIdentity.workspaceId,
          })
        )?.session
      : undefined;
  // A bound subagent ends its turns the way a runtime workspace does: its
  // return is keyed by the spawn call that opened it.
  const runtimeSessionId =
    runtimeSession?.session_id ?? subagentBinding?.session.session_id;
  const runtimeTaskId = runtimeSession
    ? runtimeIdentity?.taskId
    : subagentBinding?.spawnCallId;
  const facts: AdmissionFacts = {
    claims,
    ...(runtimeSessionId ? { runtimeSessionId, runtimeTaskId } : {}),
    ...(chatSource ? { chatSource } : {}),
  };
  // Enforcement rejects conflicts above; observing and setup-bypass paths
  // must also avoid adopting the conflicting workspace's authority.
  const boundRuntimeIdentity =
    runtimeIdentity &&
    runtimeBindingMatches &&
    !runtimeSessionConflicts({
      workloadName: runtimeIdentity.workloadName,
      presentedSession: presentedRuntimeSession,
    })
      ? runtimeIdentity
      : null;
  if (
    (appaActive || appaObserving) &&
    boundRuntimeIdentity &&
    presentedRuntimeSession === undefined
  ) {
    headers[APPA_SESSION_HEADER.toLowerCase()] =
      boundRuntimeIdentity.workloadName;
  }
  const callerId = appaUserId
    ? `user:${appaUserId}`
    : boundRuntimeIdentity
      ? boundRuntimeIdentity.principal
      : authenticatedApp
        ? `app:${authenticatedApp.id}`
        : virtualKeyId
          ? `virtual-key:${virtualKeyId}`
          : undefined;
  // A platform request over loopback that brings no credential of its own.
  // Only such a request may name an unscoped session in the header.
  const platformLoopback =
    isInternalRequest &&
    !authenticatedUserId &&
    !authenticatedApp &&
    !virtualKeyId;
  const unsupportedClient =
    appaActive &&
    !installerSetupBypass &&
    !isInternalChat &&
    !delegatedRun &&
    headers[APPA_SESSION_HEADER.toLowerCase()] === undefined &&
    headers[APPA_PARENT_HEADER.toLowerCase()] === undefined &&
    !APPA_CLIENT_ADAPTERS.some((adapter) =>
      adapter.matches({ headers, requestBody: body }),
    );
  // The platform's own guardrail models bypass OpenAPPA entirely. The proof
  // is a per-process secret, so it alone identifies them, whatever credential
  // they carry: the organization's default key may be a virtual key.
  if (
    unsupportedClient &&
    params.deployment.unsupportedClientAction === "block" &&
    !params.internalCall
  ) {
    throw new ApiError(
      400,
      "OpenAPPA does not recognize this client, so Guardrails blocked the request. Add an X-Appa-Session-ID header to each request, or ask an administrator to allow unrecognized clients.",
    );
  }
  // The facts that bind a child trajectory. Read without preparing the
  // request for enforcement, which changes the body and refuses tool
  // shapes that OpenAPPA cannot govern. Built only for an OpenAPPA session.
  const lineageRequest = (
    identity: AppaSessionIdentity,
  ): AppaTrustedContext["request"] => ({
    tools: undefined,
    session: identity,
    customTools: new Set(),
    declaredTools: [],
    ...(ingress.delegationMarkers
      ? { delegation: { markers: ingress.delegationMarkers } }
      : {}),
    ...(ingress.childReturns ? { childReturns: ingress.childReturns } : {}),
    ...(ingress.releasedSpawnCalls
      ? { releasedSpawnCalls: ingress.releasedSpawnCalls }
      : {}),
    ...(ingress.childTrajectoryReceipts
      ? { childTrajectoryReceipts: ingress.childTrajectoryReceipts }
      : {}),
  });
  if (
    appaActive &&
    !installerSetupBypass &&
    !delegatedRun &&
    !params.internalCall &&
    !unsupportedClient
  ) {
    // Extract client-native session metadata into APPA session identity.
    // Client adapters resolve resume, fork, and compaction semantics
    // before falling back to generic wire properties.
    const incomingAppaSessionHeader =
      headers[APPA_SESSION_HEADER.toLowerCase()];
    const family = appaWireFamily(params.interactionType);
    const identity = clientSessionIdentity({
      family,
      body,
      headers,
      clientWire: ingress.clientWire,
    });
    const hasNativeClientSession =
      nativeSetupClientFromProvenance(identity.provenance) !== undefined;
    if (
      hasNativeClientSession &&
      identity.sessionId !== undefined &&
      !isWellFormedAppaId(identity.sessionId)
    ) {
      throw new ApiError(
        400,
        "OpenAPPA requires a valid client-native session ID",
      );
    }
    // Receipts were stripped from history above, before any forwarding or
    // logging. APPA now resolves the collected codes into lineage evidence
    // owned by this caller.
    const receiptSessions = callerId
      ? await sessionReceiptEvidence({
          organizationId: agent.organizationId,
          callerId,
          codes: ingress.strippedReceiptCodes,
        })
      : [];
    // History carrying verified stamps or session receipts identifies
    // parent context. A new session opens as a fork of its deepest ancestor.
    const traceable =
      callerId &&
      identity.sessionId &&
      (family ?? ingress.clientWire) &&
      !isInternalChat &&
      !incomingAppaSessionHeader &&
      !headers[APPA_PARENT_HEADER.toLowerCase()] &&
      !nativeSpawnParentId({
        headers,
        body,
        sessionId: identity.sessionId,
      });
    const stamped =
      traceable && callerId
        ? stampedSessions({
            stamps: ingress.trajectoryStamps,
            organizationId: agent.organizationId,
            callerId,
            secret: config.openappa.offerSigningSecret,
          })
        : [];
    // `forkedSession` identifies a single lineage head across stamps and text envelopes.
    const traced = traceable ? [...stamped, ...receiptSessions] : [];
    const forkOf =
      traced.length > 0 && callerId && identity.sessionId
        ? await forkedSession({
            organizationId: agent.organizationId,
            sessionId: identity.sessionId,
            traced,
            scope: (session) => scopedSessionId(callerId, session),
          })
        : undefined;
    fillAppaSessionHeaders(headers, identity);
    let session = sessionFromHeaders({
      headers,
      organizationId: agent.organizationId,
      callerId,
      // Chat sessions use conversation IDs with verified ownership.
      ...(isInternalChat
        ? {}
        : {
            // Scope external sessions to the authenticated principal.
            scope:
              platformLoopback && incomingAppaSessionHeader !== undefined
                ? undefined
                : callerId,
            // Bind fallback root if no session was provided.
            fallbackSessionId: callerId ? `${callerId}@${agent.id}` : undefined,
          }),
    });
    // The executor signed the trajectory its spawn bound; the child's own
    // headers name the parent conversation and carry no authority here.
    if (subagentBinding) session = subagentBinding.session;
    if (runtimeSession) {
      if (session?.session_id !== runtimeSession.session_id) {
        throw new ApiError(
          400,
          "OpenAPPA runtime request does not match its bound workspace",
        );
      }
      // The launcher stored the authenticated parent before giving the pod data.
      session = runtimeSession;
    }
    if (!session)
      throw new ApiError(
        400,
        "OpenAPPA requires valid X-Appa-Session-ID and optional X-Appa-Parent-ID headers",
      );
    if (forkOf && callerId)
      session = { ...session, fork_of: scopedSessionId(callerId, forkOf) };
    if (callerId && session.session_id === `${callerId}@${agent.id}`) {
      // Every conversation of this credential on this agent now shares one
      // root: a turn ending in one releases the offers of the others.
      logger.warn(
        { agentId: agent.id, callerId },
        "OpenAPPA bound a fallback root because the client reported no session",
      );
    }
    if (
      await startedUnenforced(
        appaTrajectory({
          adapters: APPA_CLIENT_ADAPTERS,
          headers,
          requestBody: params.originalRequest,
          trustedContext: {
            session,
            profileId: agent.id,
            toolIdentity: params.toolIdentity,
            request: lineageRequest(identity),
            ...facts,
          },
        }).session,
      )
    ) {
      // The session started while enforcement was off, or a person
      // superyelled it. OpenAPPA never governs it: the request goes on as
      // if enforcement were off.
      logger.info(
        { sessionId: session.session_id },
        "OpenAPPA ignores a session that started while Guardrails enforcement was off or was superyelled",
      );
      return { kind: "ungoverned" };
    }
    // A Chat session is a conversation, and the request must name the
    // user whose conversation it is: without one there is nothing to
    // check the binding against, so the request is refused rather than
    // bound unchecked.
    if (isInternalChat && !appaUserId)
      throw new ApiError(
        403,
        "OpenAPPA Chat session requires the conversation's user",
      );
    if (isInternalChat && appaUserId) {
      const conversationAgentId = await ConversationModel.getAgentIdForUser(
        session.session_id,
        appaUserId,
        agent.organizationId,
      );
      if (
        !conversationAgentId ||
        (chatSource !== "chat:compaction" && conversationAgentId !== agent.id)
      ) {
        throw new ApiError(
          403,
          "OpenAPPA Chat session does not match the authenticated conversation",
        );
      }
    }
    return {
      kind: "governed",
      session,
      identity,
      callerId,
      family,
      hasNativeClientSession,
      facts,
    };
  }
  if (
    appaObserving &&
    !delegatedRun &&
    !subagentToken &&
    !params.internalCall &&
    (isInternalRequest ||
      authenticatedUserId ||
      authenticatedApp ||
      virtualKeyId)
  ) {
    // The session a request has while enforcement is off, for the records
    // OpenAPPA reads once it turns on. Nothing governs it.
    const observedSession = observedAppaSession({
      headers,
      body,
      interactionType: params.interactionType,
      clientWire: ingress.clientWire,
      organizationId: agent.organizationId,
      callerId,
      isInternalChat,
      platformLoopback,
    });
    if (observedSession)
      return {
        kind: "observed",
        trustedContext: {
          session: observedSession,
          profileId: agent.id,
          toolIdentity: params.toolIdentity,
          request: lineageRequest({}),
          ...facts,
          compaction: ingress.clientCompaction && !isInternalChat,
          enforcement: "inactive",
        },
      };
  }
  return { kind: "ungoverned" };
}

// ===

export type OpenappaAdmission =
  | { kind: "ungoverned" }
  /** Enforcement is off; OpenAPPA records the session for when it turns on. */
  | { kind: "observed"; trustedContext: AppaTrustedContext }
  | {
      kind: "governed";
      session: OpenAppaSession;
      identity: AppaSessionIdentity;
      callerId: string | undefined;
      family: AppaWireFamily | undefined;
      hasNativeClientSession: boolean;
      facts: AdmissionFacts;
    };

/** What every trusted context of the request says about its lineage. */
type AdmissionFacts = Pick<
  AppaTrustedContext,
  "claims" | "runtimeSessionId" | "runtimeTaskId" | "chatSource"
>;

type OpenappaPrincipal = {
  /** The user a platform credential proves, not one a header names. */
  authenticatedUserId: string | undefined;
  authenticatedApp: { id: string } | undefined;
  virtualKeyId: string | undefined;
  passthroughVirtualKeyId: string | undefined;
  /** The user the request is attributed to, which a header may name. */
  userId: string | undefined;
};

type OpenappaDeployment = {
  active: boolean;
  /** The feature is on while enforcement is off. */
  observing: boolean;
  unsupportedClientAction: UnsupportedAppaClientAction;
};

/**
 * Fills the APPA session and parent headers from the client's own session
 * identity when the request did not send them. The enforced path and the
 * observer both use it, so they read the same session from a request.
 */
function fillAppaSessionHeaders(
  headers: Record<string, string | string[] | undefined>,
  identity: AppaSessionIdentity,
): void {
  const sessionHeader = APPA_SESSION_HEADER.toLowerCase();
  const parentHeader = APPA_PARENT_HEADER.toLowerCase();
  if (
    identity.sessionId &&
    isWellFormedAppaId(identity.sessionId) &&
    !headers[sessionHeader]
  )
    headers[sessionHeader] = identity.sessionId;
  if (
    identity.parentId &&
    isWellFormedAppaId(identity.parentId) &&
    !headers[parentHeader]
  )
    headers[parentHeader] = identity.parentId;
}

/**
 * The session a request has while enforcement is off: the one the enforced
 * path binds, without a fork source. Undefined for a client that OpenAPPA
 * cannot govern, or a request that names no valid session of its own. A
 * fallback root is shared by all conversations of a credential, so it is
 * never one session. Never throws, because enforcement is off.
 */
function observedAppaSession(params: {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  interactionType: Parameters<typeof appaWireFamily>[0];
  clientWire: OpenappaIngress["clientWire"];
  organizationId: string;
  callerId: string | undefined;
  isInternalChat: boolean;
  /** A platform request over loopback with no credential of its own. */
  platformLoopback: boolean;
}): OpenAppaSession | undefined {
  const sessionHeader = APPA_SESSION_HEADER.toLowerCase();
  const parentHeader = APPA_PARENT_HEADER.toLowerCase();
  const incoming = params.headers[sessionHeader];
  const governable =
    params.isInternalChat ||
    incoming !== undefined ||
    params.headers[parentHeader] !== undefined ||
    APPA_CLIENT_ADAPTERS.some((adapter) =>
      adapter.matches({ headers: params.headers, requestBody: params.body }),
    );
  if (!governable) return undefined;
  try {
    const identity = clientSessionIdentity({
      family: appaWireFamily(params.interactionType),
      body: params.body,
      headers: params.headers,
      clientWire: params.clientWire,
    });
    const headers = { ...params.headers };
    fillAppaSessionHeaders(headers, identity);
    return sessionFromHeaders({
      headers,
      organizationId: params.organizationId,
      callerId: params.callerId,
      ...(params.isInternalChat
        ? {}
        : {
            scope:
              params.platformLoopback && incoming !== undefined
                ? undefined
                : params.callerId,
          }),
    });
  } catch (error) {
    // Enforcement is off, so the request goes on either way. A request
    // without a usable session id is expected; anything else is not.
    const details = {
      error: error instanceof Error ? error.message : String(error),
    };
    if (error instanceof ApiError)
      logger.debug(
        details,
        "OpenAPPA does not record a request without a usable session id while Guardrails enforcement is off",
      );
    else
      logger.warn(
        details,
        "OpenAPPA could not read the session of a request while Guardrails enforcement is off",
      );
    return undefined;
  }
}

/**
 * The session the client reports. On a wire OpenAPPA does not read, it is
 * read from the client's own wire when a Model Router route translated it,
 * and otherwise from the headers alone.
 */
function clientSessionIdentity(params: {
  family: AppaWireFamily | undefined;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  clientWire: OpenappaIngress["clientWire"];
}): AppaSessionIdentity {
  const { family, body, headers, clientWire } = params;
  if (family) return extractAppaSessionIdentity({ family, body, headers });
  if (clientWire)
    return extractAppaSessionIdentity({
      family: clientWire.family,
      body: clientWire.body,
      headers,
    });
  return extractAppaSessionIdentity({ family: undefined, body, headers });
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
