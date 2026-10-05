import { createHmac, timingSafeEqual } from "node:crypto";
import config from "@/config";
import logger from "@/logging";
import {
  AgentRunModel,
  AgentWorkspaceModel,
  OpenAppaSessionModel,
} from "@/models";
import { scopedSessionId } from "@/openappa/actor";
import type { OpenAppaSession } from "@/openappa/service";
import { type AgentRunActorKind, type AgentRunRecord, ApiError } from "@/types";
import type { AgentWorkspace } from "@/types/agent-workspace";

/**
 * Stable OpenAPPA principal for a non-user runtime workspace.
 * User actors stay `user:<id>`. This is not a user id.
 */
const WORKLOAD_PRINCIPAL_PREFIX = "agent-workspace:";

/**
 * Server-signed origin for a gateway call. A team or organization token plus
 * a client-selected session or run id proves the actor can use the gateway,
 * not which workspace originated the call. Without this binding the gateway
 * does not assign a workload principal and does not retarget a sibling.
 * Launch must mint the token and the runtime must send it; a header the
 * client composes is not a substitute.
 */
export const RUNTIME_BINDING_HEADER = "X-Archestra-Runtime-Binding";

/** Secret env only. Do not copy this into logged launch env. */
const RUNTIME_BINDING_ENV = "ARCHESTRA_AGENT_RUNTIME_BINDING";

const BINDING_DOMAIN = "archestra.runtime-identity.v1";
const BINDING_VERSION = 1;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTOR_KINDS = new Set<AgentRunActorKind>([
  "user",
  "team",
  "organization",
  "system",
]);

/** @public — association returned to review and crossing callers */
export type VerifiedRuntimeAssociation = {
  principal: string;
  workspaceId: string;
  workloadName: string;
  organizationId: string;
  agentId: string;
  actorKind: AgentRunActorKind;
  actorId: string;
  /** Null for team, organization, and system actors. Never invented. */
  actorUserId: string | null;
  taskId: string;
};

type RuntimeIdentityLookup =
  | { status: "bound"; identity: VerifiedRuntimeAssociation }
  | { status: "unbound" }
  | { status: "conflict" };

type GatewayRuntimeDecision =
  | { kind: "none" }
  | { kind: "reject"; message: string }
  | { kind: "session"; identity: VerifiedRuntimeAssociation };

type RuntimeBindingClaims = {
  v: typeof BINDING_VERSION;
  organizationId: string;
  workspaceId: string;
  workloadName: string;
  taskId: string;
  agentId: string;
  actorKind: AgentRunActorKind;
  actorId: string;
  expiresAt: number;
};

type GatewayTokenActor = {
  userId?: string;
  teamId?: string | null;
  isOrganizationToken: boolean;
};

/** @public — principal constructor shared with review and gateway callers */
export function workloadPrincipal(workspaceId: string): string {
  return `${WORKLOAD_PRINCIPAL_PREFIX}${workspaceId}`;
}

export function parseWorkloadPrincipal(
  callerId: string | null | undefined,
): string | null {
  if (!callerId?.startsWith(WORKLOAD_PRINCIPAL_PREFIX)) return null;
  const id = callerId.slice(WORKLOAD_PRINCIPAL_PREFIX.length);
  return UUID.test(id) ? id : null;
}

function runtimeCallerId(params: {
  actorKind: AgentRunActorKind;
  actorId: string;
  workspaceId: string;
}): string {
  return params.actorKind === "user"
    ? `user:${params.actorId}`
    : workloadPrincipal(params.workspaceId);
}

/**
 * OpenAPPA session for a persisted workspace. Does not read a virtual key or
 * a client header. User sessions stay `user:<id>|<workloadName>`.
 * @public — persisted session for crossing; does not read a virtual key
 */
export function runtimeOpenAppaSession(params: {
  organizationId: string;
  workspaceId: string;
  workloadName: string;
  actorKind: AgentRunActorKind;
  actorId: string;
  parentId?: string;
}): OpenAppaSession {
  const callerId = runtimeCallerId(params);
  return {
    organization_id: params.organizationId,
    caller_id: callerId,
    session_id: scopedSessionId(callerId, params.workloadName),
    // parentId is already a full session id. Do not scope it again.
    ...(params.parentId ? { parent_id: params.parentId } : {}),
  };
}

/**
 * True when the client named a session other than this credential's workspace.
 * An absent header is not a conflict; the server workspace name is the anchor.
 */
export function runtimeSessionConflicts(params: {
  workloadName: string;
  presentedSession: string | undefined;
}): boolean {
  return (
    params.presentedSession !== undefined &&
    params.presentedSession !== params.workloadName
  );
}

export function authenticatedRuntimeSpender(params: {
  userId?: string;
  callerId?: string;
}): string | undefined {
  if (params.userId) return `user:${params.userId}`;
  return parseWorkloadPrincipal(params.callerId) ? params.callerId : undefined;
}

/**
 * A workload principal spends only offers it minted. It does not inherit the
 * organization-wide allowance Rust gives non-user owners.
 */
export function workloadSpenderMayUseOffer(params: {
  spender: string;
  ownerCallerId: string | null | undefined;
}): boolean {
  return (
    parseWorkloadPrincipal(params.spender) !== null &&
    params.ownerCallerId === params.spender
  );
}

/**
 * Optional while unenforced; the enforcing launcher rejects missing signer/output.
 * @public — launcher mints this; the gateway only verifies it
 */
export function issueRuntimeBinding(params: {
  secret: string;
  organizationId: string;
  workspaceId: string;
  workloadName: string;
  taskId: string;
  agentId: string;
  actorKind: AgentRunActorKind;
  actorId: string;
  expiresAt: number;
}): string | undefined {
  if (!bindingClaimsComplete(params) || params.secret.length === 0) {
    return undefined;
  }
  const claims: RuntimeBindingClaims = {
    v: BINDING_VERSION,
    organizationId: params.organizationId,
    workspaceId: params.workspaceId,
    workloadName: params.workloadName,
    taskId: params.taskId,
    agentId: params.agentId,
    actorKind: params.actorKind,
    actorId: params.actorId,
    expiresAt: params.expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `rt1.${payload}.${signBinding(payload, params.secret)}`;
}

function readRuntimeBinding(params: {
  token: string;
  secret: string;
  now?: number;
}): RuntimeBindingClaims | null {
  if (params.secret.length === 0) return rejectRuntimeBinding("missing_signer");
  const parts = params.token.split(".");
  if (parts.length !== 3 || parts[0] !== "rt1")
    return rejectRuntimeBinding("malformed");
  const expected = signBinding(parts[1], params.secret);
  const actual = Buffer.from(parts[2]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    return rejectRuntimeBinding("signature_mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return rejectRuntimeBinding("invalid_json");
  }
  if (!isBindingClaims(parsed)) return rejectRuntimeBinding("invalid_claims");
  if ((params.now ?? Date.now()) >= parsed.expiresAt)
    return rejectRuntimeBinding("expired");
  return parsed;
}

async function resolveRuntimeIdentityByVirtualKey(params: {
  virtualKeyId: string;
  organizationId: string;
}): Promise<VerifiedRuntimeAssociation | null> {
  const run = await AgentRunModel.findByVirtualApiKeyId(params.virtualKeyId);
  if (!run || run === "ambiguous") return null;
  if (run.organizationId !== params.organizationId) return null;
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    run.workloadName,
  );
  if (!workspace || workspace.organizationId !== params.organizationId) {
    return null;
  }
  return associationFrom(workspace, run);
}

export async function resolveRuntimeIdentityByVirtualKeys(params: {
  virtualKeyIds: Array<string | undefined>;
  organizationId: string;
}): Promise<RuntimeIdentityLookup> {
  const ids = [
    ...new Set(
      params.virtualKeyIds.filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
  const found: VerifiedRuntimeAssociation[] = [];
  for (const virtualKeyId of ids) {
    const identity = await resolveRuntimeIdentityByVirtualKey({
      virtualKeyId,
      organizationId: params.organizationId,
    });
    if (identity) found.push(identity);
  }
  if (found.length === 0) return { status: "unbound" };
  const first = found[0];
  if (found.some((item) => item.workspaceId !== first.workspaceId)) {
    return { status: "conflict" };
  }
  return { status: "bound", identity: first };
}

/**
 * Session for a persisted workspace. A client header is not an input. A
 * workspace in another organization is not returned.
 */
/** @public — crossing loads a workspace session without its ephemeral key */
export async function resolveRuntimeSessionForWorkspace(params: {
  organizationId: string;
  workspaceId?: string;
  workloadName?: string;
}): Promise<{
  session: OpenAppaSession;
  association: VerifiedRuntimeAssociation;
} | null> {
  const workspace = params.workspaceId
    ? await AgentWorkspaceModel.findById(params.workspaceId)
    : params.workloadName
      ? await AgentWorkspaceModel.findByWorkloadName(params.workloadName)
      : null;
  if (!workspace || workspace.organizationId !== params.organizationId) {
    return null;
  }
  const association = await associationForCurrentTurn(workspace);
  if (!association) return null;
  const session = runtimeOpenAppaSession(association);
  const parentId = await OpenAppaSessionModel.parentId({
    organizationId: workspace.organizationId,
    sessionId: session.session_id,
  });
  return {
    session: parentId ? { ...session, parent_id: parentId } : session,
    association,
  };
}

/**
 * Signed offer session to the workspace that minted it. A session suffix is
 * not enough: the caller must be that workspace's principal, and the session
 * or its parent must be the scoped workspace root. A child offer whose
 * parent is that root is the same workspace; its session id is not required
 * to equal the workload name.
 */
export async function resolveVerifiedRuntimeAssociation(params: {
  organizationId: string;
  sessionId: string;
  callerId: string | null | undefined;
  parentId?: string | null;
}): Promise<VerifiedRuntimeAssociation | null> {
  const workspace = await workspaceForCaller({
    organizationId: params.organizationId,
    callerId: params.callerId,
    sessionId: params.sessionId,
  });
  if (!workspace || !params.callerId) return null;
  const callerId = runtimeCallerId({
    actorKind: workspace.actorKind,
    actorId: workspace.actorId,
    workspaceId: workspace.id,
  });
  const root = scopedSessionId(callerId, workspace.workloadName);
  if (params.callerId !== callerId) {
    return null;
  }
  if (
    !(await offerSessionMatchesWorkspace({
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      parentId: params.parentId,
      callerId: params.callerId,
      root,
    }))
  ) {
    return null;
  }
  return associationForCurrentTurn(workspace);
}

/**
 * Non-user gateway origin. A shared actor token does not select a workspace.
 * A presented binding that does not verify, or that disagrees with the
 * anchor session or run id, is a rejection rather than an unbound session.
 */
export async function resolveGatewayRuntimeSession(params: {
  organizationId: string;
  agentId: string;
  token: GatewayTokenActor;
  bindingToken?: string;
  secret: string;
  sessionName?: string;
  runTaskId?: string;
  now?: number;
}): Promise<GatewayRuntimeDecision> {
  if (params.token.userId) return { kind: "none" };
  if (!params.bindingToken) return { kind: "none" };
  const claims = readRuntimeBinding({
    token: params.bindingToken,
    secret: params.secret,
    now: params.now,
  });
  if (
    !claims ||
    claims.organizationId !== params.organizationId ||
    claims.agentId !== params.agentId
  ) {
    return { kind: "reject", message: "Invalid runtime binding" };
  }
  if (
    !tokenOwnsActor(params.token, claims, params.organizationId) ||
    runtimeSessionConflicts({
      workloadName: claims.workloadName,
      presentedSession: params.sessionName,
    }) ||
    params.runTaskId !== claims.taskId
  ) {
    return {
      kind: "reject",
      message: "OpenAPPA runtime credential does not match this workspace",
    };
  }
  const run = await AgentRunModel.findByTaskId(claims.taskId);
  const workspace = await AgentWorkspaceModel.findById(claims.workspaceId);
  if (!run || !workspace) {
    return { kind: "reject", message: "Invalid runtime binding" };
  }
  const identity = associationFrom(workspace, run);
  if (
    !identity ||
    identity.organizationId !== claims.organizationId ||
    identity.agentId !== claims.agentId ||
    identity.workloadName !== claims.workloadName ||
    identity.actorKind !== claims.actorKind ||
    identity.actorId !== claims.actorId ||
    identity.taskId !== claims.taskId
  ) {
    return { kind: "reject", message: "Invalid runtime binding" };
  }
  return { kind: "session", identity };
}

export function runtimeBindingAuthorizes(params: {
  token: string | undefined;
  secret: string;
  identity: VerifiedRuntimeAssociation;
  now?: number;
}): boolean {
  if (!params.token) return false;
  const claims = readRuntimeBinding({
    token: params.token,
    secret: params.secret,
    now: params.now,
  });
  if (!claims) return false;
  return (
    claims.organizationId === params.identity.organizationId &&
    claims.workspaceId === params.identity.workspaceId &&
    claims.workloadName === params.identity.workloadName &&
    claims.taskId === params.identity.taskId &&
    claims.agentId === params.identity.agentId &&
    claims.actorKind === params.identity.actorKind &&
    claims.actorId === params.identity.actorId
  );
}

/**
 * Mint the turn binding from the persisted workspace and run. The token is
 * written only to secretEnv. Expiry is the authorized turn, not a new lifetime.
 */
export async function stampRuntimeBinding(params: {
  spec: {
    secretEnv: Record<string, string>;
    env: Record<string, string>;
    activeDeadlineSeconds?: number | null;
  };
  organizationId: string;
  workspaceId: string;
  taskId: string;
}): Promise<void> {
  const workspace = await AgentWorkspaceModel.findById(params.workspaceId);
  const run = await AgentRunModel.findByTaskId(params.taskId);
  const identity = workspace && run ? associationFrom(workspace, run) : null;
  if (
    !workspace ||
    !identity ||
    identity.organizationId !== params.organizationId ||
    identity.workspaceId !== params.workspaceId ||
    identity.taskId !== params.taskId
  ) {
    throw new ApiError(
      409,
      "Runtime binding does not match the persisted workspace",
    );
  }
  const deadlineMs =
    Math.max(1, params.spec.activeDeadlineSeconds ?? 60) * 1000;
  const now = Date.now();
  const expiresAt = Math.min(workspace.expiresAt.getTime(), now + deadlineMs);
  if (expiresAt <= now) {
    throw new ApiError(409, "Runtime binding deadline has passed");
  }
  const token = issueRuntimeBinding({
    secret: config.openappa.offerSigningSecret,
    organizationId: identity.organizationId,
    workspaceId: identity.workspaceId,
    workloadName: identity.workloadName,
    taskId: identity.taskId,
    agentId: identity.agentId,
    actorKind: identity.actorKind,
    actorId: identity.actorId,
    expiresAt,
  });
  if (!token) {
    throw new ApiError(500, "Could not mint the runtime binding");
  }
  params.spec.secretEnv[RUNTIME_BINDING_ENV] = token;
  delete params.spec.env[RUNTIME_BINDING_ENV];
}

async function workspaceForCaller(params: {
  organizationId: string;
  callerId: string | null | undefined;
  sessionId: string;
}): Promise<AgentWorkspace | null> {
  const workspaceId = parseWorkloadPrincipal(params.callerId);
  if (workspaceId) {
    const workspace = await AgentWorkspaceModel.findById(workspaceId);
    return workspace?.organizationId === params.organizationId
      ? workspace
      : null;
  }
  if (!params.callerId?.startsWith("user:")) return null;
  const actorId = params.callerId.slice("user:".length);
  if (actorId.length === 0) return null;
  const workloadName = unscopedSession(params.sessionId, params.callerId);
  if (!workloadName) return null;
  const workspace = await AgentWorkspaceModel.findByWorkloadName(workloadName);
  if (
    !workspace ||
    workspace.organizationId !== params.organizationId ||
    workspace.actorKind !== "user" ||
    workspace.actorId !== actorId
  ) {
    return null;
  }
  return workspace;
}

function unscopedSession(sessionId: string, callerId: string): string | null {
  const prefix = `${callerId}|`;
  if (sessionId.startsWith(prefix)) {
    const rest = sessionId.slice(prefix.length);
    const child = rest.indexOf(":");
    const name = child >= 0 ? rest.slice(0, child) : rest;
    return name.length > 0 ? name : null;
  }
  return null;
}

async function offerSessionMatchesWorkspace(params: {
  organizationId: string;
  sessionId: string;
  parentId?: string | null;
  callerId: string;
  root: string;
}): Promise<boolean> {
  if (params.sessionId === params.root && !params.parentId) return true;
  const row = await OpenAppaSessionModel.familySession({
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    callerId: params.callerId,
  });
  if (row?.callerId !== params.callerId || params.parentId !== row.parentId) {
    return false;
  }
  return (
    params.sessionId === params.root ||
    (await OpenAppaSessionModel.hasAncestor({
      organizationId: params.organizationId,
      callerId: params.callerId,
      sessionId: params.sessionId,
      ancestorSessionId: params.root,
    }))
  );
}

async function associationForCurrentTurn(
  workspace: AgentWorkspace,
): Promise<VerifiedRuntimeAssociation | null> {
  const taskId = workspace.activeTaskId ?? workspace.lastTaskId;
  if (!taskId) return null;
  const run = await AgentRunModel.findByTaskId(taskId);
  if (!run) return null;
  return associationFrom(workspace, run);
}

function associationFrom(
  workspace: AgentWorkspace,
  run: AgentRunRecord,
): VerifiedRuntimeAssociation | null {
  if (
    workspace.organizationId !== run.organizationId ||
    workspace.agentId !== run.agentId ||
    workspace.actorKind !== run.actorKind ||
    workspace.actorId !== run.actorId ||
    workspace.workloadName !== run.workloadName ||
    workspace.state === "deleting"
  ) {
    return null;
  }
  return {
    principal: runtimeCallerId({
      actorKind: workspace.actorKind,
      actorId: workspace.actorId,
      workspaceId: workspace.id,
    }),
    workspaceId: workspace.id,
    workloadName: workspace.workloadName,
    organizationId: workspace.organizationId,
    agentId: workspace.agentId,
    actorKind: workspace.actorKind,
    actorId: workspace.actorId,
    actorUserId: run.actorUserId,
    taskId: run.taskId,
  };
}

function tokenOwnsActor(
  token: GatewayTokenActor,
  claims: RuntimeBindingClaims,
  organizationId: string,
): boolean {
  if (token.userId) {
    return claims.actorKind === "user" && claims.actorId === token.userId;
  }
  if (token.teamId && !token.isOrganizationToken) {
    return claims.actorKind === "team" && claims.actorId === token.teamId;
  }
  if (token.isOrganizationToken) {
    if (
      claims.actorKind === "organization" &&
      claims.actorId === organizationId
    ) {
      return true;
    }
    // Host-created system runs use the organization gateway token. The
    // signed binding, not the token alone, names that workload.
    return (
      claims.actorKind === "system" &&
      claims.actorId === "system" &&
      claims.organizationId === organizationId
    );
  }
  return false;
}

function bindingClaimsComplete(params: {
  organizationId: string;
  workspaceId: string;
  workloadName: string;
  taskId: string;
  agentId: string;
  actorKind: AgentRunActorKind;
  actorId: string;
  expiresAt: number;
}): boolean {
  return (
    params.organizationId.length > 0 &&
    UUID.test(params.workspaceId) &&
    UUID.test(params.taskId) &&
    UUID.test(params.agentId) &&
    params.workloadName.length > 0 &&
    params.actorId.length > 0 &&
    ACTOR_KINDS.has(params.actorKind) &&
    Number.isFinite(params.expiresAt)
  );
}

function isBindingClaims(value: unknown): value is RuntimeBindingClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as RuntimeBindingClaims;
  return (
    claims.v === BINDING_VERSION &&
    typeof claims.organizationId === "string" &&
    typeof claims.workloadName === "string" &&
    typeof claims.actorId === "string" &&
    typeof claims.workspaceId === "string" &&
    typeof claims.taskId === "string" &&
    typeof claims.agentId === "string" &&
    typeof claims.actorKind === "string" &&
    typeof claims.expiresAt === "number" &&
    bindingClaimsComplete(claims)
  );
}

function rejectRuntimeBinding(reason: string): null {
  // Internal diagnostics distinguish causes; never log credentials or disclose an oracle.
  logger.debug({ reason }, "Runtime binding validation rejected");
  return null;
}

function signBinding(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${BINDING_DOMAIN}.${payload}`)
    .digest("base64url");
}
