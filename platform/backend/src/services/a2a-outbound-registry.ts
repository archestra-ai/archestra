import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { eq } from "drizzle-orm";
import { Agent as UndiciAgent } from "undici";
import db, { schema } from "@/database";
import { A2aConnectionModel, A2aRemoteAgentModel, ToolModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type {
  A2aConnectionAuthInput,
  A2aConnectionAuthType,
  A2aRemoteAgentInspection,
  A2aRemoteAgentSource,
  A2aSecurityRequirement,
  A2aSelectedInterface,
  CreateA2aRemoteAgentRequest,
  InspectA2aRemoteAgentRequest,
  PublicA2aRemoteAgent,
  UpdateA2aRemoteAgentRequest,
} from "@/types";
import { ApiError } from "@/types";
import { isAllowedA2aAddress, validateOutboundUrl } from "@/utils/outbound-url";

const MAX_A2A_RESPONSE_BYTES = 5 * 1024 * 1024;
const A2A_REQUEST_TIMEOUT_MS = 30_000;
const SUPPORTED_BINDINGS = new Set(["JSONRPC", "HTTP+JSON"]);

export async function inspectA2aRemoteAgent(
  input: InspectA2aRemoteAgentRequest,
): Promise<A2aRemoteAgentInspection> {
  const card = await resolveAgentCard(input.source);
  return inspectResolvedCard({
    card,
    authType: input.auth.type,
    apiKeyHeader:
      input.auth.type === "api_key" ? input.auth.headerName : undefined,
  });
}

export async function listA2aRemoteAgents(
  organizationId: string,
): Promise<PublicA2aRemoteAgent[]> {
  const rows = await A2aRemoteAgentModel.findAllForOrganization(organizationId);
  return rows.map(toPublicRemoteAgent);
}

export async function createA2aRemoteAgent(params: {
  organizationId: string;
  input: CreateA2aRemoteAgentRequest;
}): Promise<PublicA2aRemoteAgent> {
  const inspection = await inspectA2aRemoteAgent(params.input);
  let secretId: string | null = null;
  let remoteAgentId: string | null = null;

  try {
    if (params.input.auth.type !== "none") {
      const secret = await secretManager().createSecret(
        { credential: params.input.auth.credential },
        `a2a-${inspection.name}`,
      );
      secretId = secret.id;
    }

    const remoteAgent = await A2aRemoteAgentModel.create({
      organizationId: params.organizationId,
      name: params.input.name ?? inspection.name,
      description:
        params.input.description === undefined
          ? inspection.description
          : params.input.description,
      discoveryMode: params.input.source.type,
      discoveryUrl:
        params.input.source.type === "inline_card"
          ? null
          : params.input.source.url,
      agentCard: inspection.agentCard,
      cardHash: inspection.cardHash,
      lastDiscoveredAt: new Date(),
      discoveryError: null,
    });
    remoteAgentId = remoteAgent.id;

    const connection = await A2aConnectionModel.create({
      remoteAgentId: remoteAgent.id,
      name: params.input.connectionName,
      selectedInterface: inspection.selectedInterface,
      securityRequirement: inspection.selectedSecurityRequirement,
      authType: params.input.auth.type,
      authConfig: authConfig(params.input.auth),
      secretId,
      enabled: true,
      lastVerifiedAt: new Date(),
      lastVerificationError: null,
    });
    const tool = await ToolModel.createA2aDelegationTool(
      connection.id,
      params.organizationId,
    );

    return toPublicRemoteAgent({
      remoteAgent,
      connection,
      toolId: tool.id,
    });
  } catch (error) {
    if (remoteAgentId) {
      await A2aRemoteAgentModel.delete(remoteAgentId).catch(() => {});
    }
    if (secretId) {
      await secretManager()
        .deleteSecret(secretId)
        .catch(() => {});
    }
    throw error;
  }
}

export async function updateA2aRemoteAgent(params: {
  id: string;
  organizationId: string;
  input: UpdateA2aRemoteAgentRequest;
}): Promise<PublicA2aRemoteAgent> {
  const existing = await requireRemoteAgent(params);
  const source = params.input.source ?? sourceFromStored(existing.remoteAgent);
  const authType = params.input.auth?.type ?? existing.connection.authType;
  const apiKeyHeader =
    params.input.auth?.type === "api_key"
      ? params.input.auth.headerName
      : authType === "api_key"
        ? existing.connection.authConfig.headerName
        : undefined;
  const card = params.input.source
    ? await resolveAgentCard(source)
    : (existing.remoteAgent.agentCard as unknown as AgentCard);
  const inspection = inspectResolvedCard({ card, authType, apiKeyHeader });
  const nextName = params.input.name ?? existing.remoteAgent.name;

  let secretId = existing.connection.secretId;
  if (params.input.auth) {
    if (params.input.auth.type === "none") {
      secretId = null;
    } else if (secretId) {
      await secretManager().updateSecret(secretId, {
        credential: params.input.auth.credential,
      });
    } else {
      const secret = await secretManager().createSecret(
        { credential: params.input.auth.credential },
        `a2a-${params.input.name ?? existing.remoteAgent.name}`,
      );
      secretId = secret.id;
    }
  }

  const remoteAgent = await A2aRemoteAgentModel.update(params.id, {
    name: nextName,
    description:
      params.input.description === undefined
        ? existing.remoteAgent.description
        : params.input.description,
    discoveryMode: source.type,
    discoveryUrl: source.type === "inline_card" ? null : source.url,
    agentCard: inspection.agentCard,
    cardHash: inspection.cardHash,
    lastDiscoveredAt: params.input.source ? new Date() : undefined,
    discoveryError: null,
  });
  if (!remoteAgent) throw new ApiError(404, "Outbound A2A agent not found");

  const connection = await A2aConnectionModel.update(existing.connection.id, {
    selectedInterface: inspection.selectedInterface,
    securityRequirement: inspection.selectedSecurityRequirement,
    authType,
    authConfig:
      params.input.auth === undefined
        ? existing.connection.authConfig
        : authConfig(params.input.auth),
    secretId,
    enabled: params.input.enabled ?? existing.connection.enabled,
    lastVerifiedAt:
      params.input.source || params.input.auth ? new Date() : undefined,
    lastVerificationError: null,
  });
  if (!connection) throw new ApiError(404, "Outbound A2A connection not found");

  if (params.input.auth?.type === "none" && existing.connection.secretId) {
    await secretManager()
      .deleteSecret(existing.connection.secretId)
      .catch(() => {});
  }

  return toPublicRemoteAgent({
    remoteAgent,
    connection,
    toolId: existing.toolId,
  });
}

export async function deleteA2aRemoteAgent(params: {
  id: string;
  organizationId: string;
}): Promise<void> {
  const existing = await requireRemoteAgent(params);
  await db.transaction(async (tx) => {
    // Lock the referenced tool before checking assignments. Concurrent
    // agent_tools inserts need a foreign-key key-share lock and therefore
    // cannot slip between this check and the cascading delete.
    await tx
      .select({ id: schema.toolsTable.id })
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.id, existing.toolId))
      .for("update");
    const assignments = await tx
      .select({ id: schema.agentToolsTable.id })
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, existing.toolId));
    if (assignments.length > 0) {
      throw new ApiError(
        409,
        `Outbound A2A agent is assigned to ${assignments.length} agent(s). Remove those subagent assignments first.`,
      );
    }
    await tx
      .delete(schema.a2aRemoteAgentsTable)
      .where(eq(schema.a2aRemoteAgentsTable.id, existing.remoteAgent.id));
  });
  if (existing.connection.secretId) {
    await secretManager()
      .deleteSecret(existing.connection.secretId)
      .catch(() => {});
  }
}

// === Internal ===

async function requireRemoteAgent(params: {
  id: string;
  organizationId: string;
}) {
  const row = await A2aRemoteAgentModel.findByIdForOrganization(params);
  if (!row) throw new ApiError(404, "Outbound A2A agent not found");
  return row;
}

async function resolveAgentCard(source: A2aRemoteAgentSource) {
  const resolver = new DefaultAgentCardResolver({ fetchImpl: safeA2aFetch });
  try {
    if (source.type === "inline_card") {
      return resolver.normalizeAgentCard(source.agentCard);
    }
    return await resolver.resolve(
      source.url,
      source.type === "card_url" ? "" : undefined,
    );
  } catch (error) {
    throw new ApiError(
      400,
      `Unable to resolve the A2A Agent Card: ${safeErrorMessage(error)}`,
    );
  }
}

function inspectResolvedCard(params: {
  card: AgentCard;
  authType: A2aConnectionAuthType;
  apiKeyHeader?: string;
}): A2aRemoteAgentInspection {
  const card = structuredClone(params.card) as unknown as Record<
    string,
    unknown
  >;
  const name = typeof card.name === "string" ? card.name.trim() : "";
  if (!name) throw new ApiError(400, "Agent Card name is required");
  const description =
    typeof card.description === "string" ? card.description : null;
  const interfaces = Array.isArray(card.supportedInterfaces)
    ? card.supportedInterfaces
    : [];
  const selectedInterface = interfaces
    .map(parseInterface)
    .find(
      (candidate): candidate is A2aSelectedInterface =>
        candidate !== null &&
        SUPPORTED_BINDINGS.has(candidate.protocolBinding) &&
        candidate.protocolVersion.startsWith("1."),
    );
  if (!selectedInterface) {
    throw new ApiError(
      400,
      "Agent Card must advertise an A2A 1.x JSONRPC or HTTP+JSON interface",
    );
  }
  assertSafeOutboundUrl(selectedInterface.url);

  const { supportedAuthTypes, selectedSecurityRequirement } =
    selectSecurityRequirement({
      card,
      authType: params.authType,
      apiKeyHeader: params.apiKeyHeader,
    });

  return {
    name,
    description,
    agentCard: card,
    cardHash: createHash("sha256").update(JSON.stringify(card)).digest("hex"),
    selectedInterface,
    supportedAuthTypes,
    selectedSecurityRequirement,
  };
}

function parseInterface(value: unknown): A2aSelectedInterface | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.url !== "string" ||
    typeof value.protocolBinding !== "string" ||
    typeof value.protocolVersion !== "string"
  ) {
    return null;
  }
  return {
    url: value.url,
    protocolBinding: value.protocolBinding as "JSONRPC" | "HTTP+JSON",
    protocolVersion: value.protocolVersion,
    ...(typeof value.tenant === "string" && value.tenant
      ? { tenant: value.tenant }
      : {}),
  };
}

function selectSecurityRequirement(params: {
  card: Record<string, unknown>;
  authType: A2aConnectionAuthType;
  apiKeyHeader?: string;
}): {
  supportedAuthTypes: A2aConnectionAuthType[];
  selectedSecurityRequirement: A2aSecurityRequirement | null;
} {
  const schemes = isRecord(params.card.securitySchemes)
    ? params.card.securitySchemes
    : {};
  const requirements = normalizeRequirements(params.card.securityRequirements);
  const allowsNone =
    requirements.length === 0 || requirements.some(isEmptyRecord);
  const supported = new Set<A2aConnectionAuthType>();
  if (allowsNone) supported.add("none");

  for (const requirement of requirements) {
    if (Object.keys(requirement).length !== 1) continue;
    const schemeName = Object.keys(requirement)[0];
    const scheme = schemes[schemeName];
    if (isBearerScheme(scheme)) supported.add("bearer");
    if (isHeaderApiKeyScheme(scheme)) supported.add("api_key");
  }

  if (!supported.has(params.authType)) {
    throw new ApiError(
      400,
      `The Agent Card does not advertise the selected ${params.authType} authentication method`,
    );
  }
  if (params.authType === "none") {
    return {
      supportedAuthTypes: [...supported],
      selectedSecurityRequirement: null,
    };
  }

  const selected = requirements.find((requirement) => {
    if (Object.keys(requirement).length !== 1) return false;
    const schemeName = Object.keys(requirement)[0];
    const scheme = schemes[schemeName];
    if (params.authType === "bearer") return isBearerScheme(scheme);
    return (
      isHeaderApiKeyScheme(scheme) &&
      (!params.apiKeyHeader ||
        apiKeyHeaderName(scheme)?.toLowerCase() ===
          params.apiKeyHeader.toLowerCase())
    );
  });
  if (!selected) {
    throw new ApiError(
      400,
      "The selected credential does not satisfy a complete Agent Card security requirement",
    );
  }
  return {
    supportedAuthTypes: [...supported],
    selectedSecurityRequirement: selected,
  };
}

function normalizeRequirements(value: unknown): A2aSecurityRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const raw = isRecord(entry.schemes) ? entry.schemes : entry;
    const result: A2aSecurityRequirement = {};
    for (const [name, scopes] of Object.entries(raw)) {
      if (Array.isArray(scopes)) {
        result[name] = scopes.filter(
          (scope): scope is string => typeof scope === "string",
        );
      } else if (isRecord(scopes) && Array.isArray(scopes.list)) {
        result[name] = scopes.list.filter(
          (scope): scope is string => typeof scope === "string",
        );
      }
    }
    return [result];
  });
}

function isBearerScheme(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.type === "http" &&
    typeof value.scheme === "string" &&
    value.scheme.toLowerCase() === "bearer"
  ) {
    return true;
  }
  return (
    isRecord(value.scheme) &&
    value.scheme.$case === "httpAuthSecurityScheme" &&
    isRecord(value.scheme.value) &&
    typeof value.scheme.value.scheme === "string" &&
    value.scheme.value.scheme.toLowerCase() === "bearer"
  );
}

function isHeaderApiKeyScheme(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "apiKey") return value.in === "header";
  return (
    isRecord(value.scheme) &&
    value.scheme.$case === "apiKeySecurityScheme" &&
    isRecord(value.scheme.value) &&
    value.scheme.value.location === "header"
  );
}

function apiKeyHeaderName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.name === "string") return value.name;
  if (
    isRecord(value.scheme) &&
    isRecord(value.scheme.value) &&
    typeof value.scheme.value.name === "string"
  ) {
    return value.scheme.value.name;
  }
  return null;
}

function authConfig(input: A2aConnectionAuthInput) {
  return input.type === "api_key" ? { headerName: input.headerName } : {};
}

function sourceFromStored(remoteAgent: {
  discoveryMode: "well_known" | "card_url" | "inline_card";
  discoveryUrl: string | null;
  agentCard: Record<string, unknown>;
}): A2aRemoteAgentSource {
  if (remoteAgent.discoveryMode === "inline_card") {
    return { type: "inline_card", agentCard: remoteAgent.agentCard };
  }
  if (!remoteAgent.discoveryUrl) {
    throw new ApiError(500, "Stored outbound A2A discovery URL is missing");
  }
  return { type: remoteAgent.discoveryMode, url: remoteAgent.discoveryUrl };
}

function toPublicRemoteAgent(
  row: Awaited<
    ReturnType<typeof A2aRemoteAgentModel.findAllForOrganization>
  >[number],
): PublicA2aRemoteAgent {
  const { secretId, ...connection } = row.connection;
  return {
    ...row.remoteAgent,
    connection: { ...connection, hasCredential: Boolean(secretId) },
    toolId: row.toolId,
  };
}

export async function safeA2aFetch(
  input: string | URL | globalThis.Request,
  init?: RequestInit,
): Promise<Response> {
  const rawUrl =
    typeof input === "string" || input instanceof URL
      ? input.toString()
      : input.url;
  assertSafeOutboundUrl(rawUrl);
  const url = new URL(rawUrl);
  const dispatcher = await createPinnedA2aDispatcher(url.hostname);
  const timeoutSignal = AbortSignal.timeout(A2A_REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(input, {
      ...init,
      redirect: "manual",
      signal,
      dispatcher,
    } as RequestInit);
    if (response.status >= 300 && response.status < 400) {
      throw new Error("A2A redirects are not followed");
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_A2A_RESPONSE_BYTES
    ) {
      throw new Error("A2A response is too large");
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_A2A_RESPONSE_BYTES) {
      throw new Error("A2A response is too large");
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await dispatcher.close();
  }
}

async function createPinnedA2aDispatcher(
  hostname: string,
): Promise<UndiciAgent> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("A2A hostname did not resolve to an address");
  }
  for (const { address } of addresses) {
    if (!isAllowedA2aAddress(address)) {
      throw new ApiError(
        400,
        "A2A hostname resolved to a private or reserved address",
      );
    }
  }
  const pinned = addresses[0];
  return new UndiciAgent({
    connect: {
      lookup: (_hostname, _options, callback) =>
        callback(null, pinned.address, pinned.family),
    },
  });
}

function assertSafeOutboundUrl(rawUrl: string): void {
  const result = validateOutboundUrl(rawUrl);
  if (!result.ok) {
    throw new ApiError(400, `A2A URL was rejected: ${result.reason}`);
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyRecord(value: A2aSecurityRequirement): boolean {
  return Object.keys(value).length === 0;
}
