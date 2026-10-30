import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import config from "@/config";
import logger from "@/logging";
import { InteractionModel } from "@/models";
import { LimitValidationService } from "@/models/limit";
import ProxyRequestContextModel from "@/models/proxy-request-context";
import {
  mediaTariffCovers,
  priceOpenAiRealtime,
} from "@/services/media-pricing";
import { ApiError, type GatewayAgent, type UsageView } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import type { BillingAttribution } from "@/utils/billable-usage";
import {
  buildInteractionRecord,
  calculateInteractionCosts,
} from "../llm-proxy-helpers";
import {
  type ModelRouterAuth,
  modelRouterAuthenticatedUserId,
  selectModelRouterCredential,
} from "../model-router-access";
import {
  parseProviderQualifiedModel,
  resolveModelRoute,
} from "../model-router-resolver";
import {
  authenticateModelRouterBearer,
  ensureModelRouterAgentAccess,
  getMappedApiKeyIds,
  getMappedProviders,
  getModelRouterAgent,
} from "../routes/model-router";

/**
 * OpenAI Realtime sessions through the Model Router and the OpenAI route.
 *
 * `client.realtime.connect(model=…)` in the OpenAI SDKs opens a WebSocket to
 * `<base_url>/realtime?model=…` with the same bearer key as every other call,
 * so a client pointed at Archestra lands here. The upgrade is admitted like a
 * Model Router request: the virtual key or LLM OAuth token names the provider
 * key, the model resolves through the router, and the caller's budgets are
 * checked before OpenAI sees anything. Frames then pass through unchanged in
 * both directions; the proxy only reads OpenAI's server events, logging one
 * interaction per `response.done` with its transcripts, usage and cost, and
 * settling the cost against the budgets the way a chat completion is.
 */

const REALTIME_PATH =
  /^\/v1\/(model-router|openai)(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\/realtime$/i;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Realtime sessions can run long; this only bounds a session nobody uses. */
const IDLE_TIMEOUT_MS = 30 * 60_000;

const acceptor = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_FRAME_BYTES,
  perMessageDeflate: false,
});

/** Admits or refuses an upgrade on a Realtime path; never throws. */
export function handleRealtimeUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  admit(request, socket, head).catch((error: unknown) => {
    const status = error instanceof ApiError ? error.statusCode : 500;
    const message =
      error instanceof ApiError
        ? error.message
        : "Realtime session could not be opened.";
    if (status >= 500)
      logger.error({ error }, "Realtime upgrade failed unexpectedly");
    refuse(socket, status, message);
  });
}

async function admit(request: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(request.url ?? "/", "http://archestra.local");
  const match = REALTIME_PATH.exec(url.pathname);
  if (!match) throw new ApiError(404, "Not found.");
  const [, route, agentId] = match;
  if (url.searchParams.has("call_id"))
    throw new ApiError(400, "SIP calls are not served through Archestra.");
  const requestedModel = url.searchParams.get("model")?.trim();
  if (!requestedModel)
    throw new ApiError(
      400,
      "Realtime sessions need the model query parameter, such as model=openai:gpt-realtime.",
    );

  const auth = await authenticateModelRouterBearer({
    authorization: request.headers.authorization,
    ip: request.socket.remoteAddress ?? "",
  });
  const agent = await getModelRouterAgent(agentId);
  await ensureModelRouterAgentAccess({ agent, auth });
  const mapped = getMappedProviders(auth);
  const resolution = await resolveModelRoute({
    requestedModel:
      route === "openai" && !parseProviderQualifiedModel(requestedModel)
        ? `openai:${requestedModel}`
        : requestedModel,
    capability: "media",
    allowedProviders:
      route === "openai"
        ? new Set([...mapped].filter((provider) => provider === "openai"))
        : mapped,
    allowedApiKeyIds: getMappedApiKeyIds(auth),
  });
  if (resolution.provider !== "openai")
    throw new ApiError(
      400,
      `Provider "${resolution.provider}" does not support the Model Router realtime endpoint.`,
    );
  const credential = await selectModelRouterCredential({ auth, resolution });
  if (credential.kind === "denied") throw credential.error;
  if (!credential.apiKey)
    throw new ApiError(401, "The mapped OpenAI key has no secret to send.");

  const identity = callerIdentity(auth);
  const requestContext = await ProxyRequestContextModel.readForProxy({
    organizationId: agent.organizationId,
    provider: "openai",
    modelId: resolution.modelId,
    agentId: agent.id,
    environmentId: agent.environmentId,
    limitVirtualKeyId: identity.virtualKeyId,
    llmOauthClientId: identity.authenticatedApp?.id,
    userId: identity.userId,
    teamMemberUserId: identity.userId ?? null,
    billingTeamId: identity.billingTeamId,
    virtualKeyId: identity.virtualKeyId,
    oauthClientId: identity.authenticatedApp?.id,
  });
  // A priced session settles each response like a chat completion; under the
  // legacy ledger media has no cost to settle, so a budget refuses it.
  const priced =
    config.llmProxy.usageAccountingMode === "enforce" &&
    mediaTariffCovers({
      provider: "openai",
      model: resolution.modelId,
      operation: "realtime",
    });
  const violation = await LimitValidationService.checkLimitsBeforeRequest({
    unpricedMediaModel: priced ? undefined : resolution.modelId,
    agentId: agent.id,
    userId: identity.userId,
    virtualKeyId: identity.virtualKeyId,
    llmOauthClientId: identity.authenticatedApp?.id,
    billingTeamId: identity.billingTeamId,
    teamMemberUserId: identity.userId ?? null,
    agent,
    snapshot: requestContext,
  });
  if (violation) throw new ApiError(402, violation[1]);

  const billingEntities: BillingAttribution["entities"] = [
    { entityType: "organization", entityId: agent.organizationId },
    { entityType: "agent", entityId: agent.id },
    ...requestContext.limitTeamIds.map((entityId) => ({
      entityType: "team" as const,
      entityId,
    })),
  ];
  for (const [entityType, entityId] of [
    ["user", identity.billingTeamId ? undefined : identity.userId],
    ["virtual_key", identity.virtualKeyId],
    ["llm_oauth_client", identity.authenticatedApp?.id],
    ["environment", agent.environmentId],
  ] as const)
    if (entityId) billingEntities.push({ entityType, entityId });
  const session = new RealtimeSession({
    agent,
    identity,
    modelId: resolution.modelId,
    providerApiKeyId: credential.mappedApiKey.providerApiKeyId,
    billingAttribution: {
      organizationId: agent.organizationId,
      environmentId: agent.environmentId,
      entities: [
        ...new Map(
          billingEntities.map((entity) => [
            `${entity.entityType}:${entity.entityId}`,
            entity,
          ]),
        ).values(),
      ],
    },
  });

  // The upstream URL keeps the client's query, with the model as OpenAI
  // names it; the client's bearer is replaced by the mapped provider key.
  const base = credential.mappedApiKey.baseUrl ?? config.llm.openai.baseUrl;
  const upstreamUrl = new URL(`${base.replace(/\/+$/, "")}/realtime`);
  upstreamUrl.protocol = upstreamUrl.protocol === "http:" ? "ws:" : "wss:";
  for (const [name, value] of url.searchParams)
    upstreamUrl.searchParams.set(name, value);
  upstreamUrl.searchParams.set("model", resolution.modelId);
  const beta = request.headers["openai-beta"];
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      authorization: `Bearer ${credential.apiKey}`,
      ...(typeof beta === "string" ? { "openai-beta": beta } : {}),
    },
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  // OpenAI speaks first (`session.created`), possibly in the same read as the
  // handshake; keep what arrives before the client socket exists.
  const backlog: Array<{
    data: Buffer | ArrayBuffer | Buffer[];
    isBinary: boolean;
  }> = [];
  const hold = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) =>
    backlog.push({ data, isBinary });
  upstream.on("message", hold);
  await new Promise<void>((resolve, reject) => {
    upstream.once("open", () => resolve());
    upstream.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 502;
      response.resume();
      reject(
        new ApiError(
          status === 401 || status === 403 ? 502 : status,
          status === 401 || status === 403
            ? "OpenAI rejected the mapped provider key."
            : `OpenAI refused the realtime session (${status}).`,
        ),
      );
    });
    upstream.once("error", (error) =>
      reject(
        new ApiError(
          502,
          `OpenAI realtime endpoint is unreachable: ${error.message}`,
        ),
      ),
    );
  });

  acceptor.handleUpgrade(request, socket, head, (client) => {
    upstream.off("message", hold);
    bridge({ client, upstream, session, backlog });
  });
}

/** Pipes frames both ways; the upstream's text events feed the session log. */
function bridge(params: {
  client: WebSocket;
  upstream: WebSocket;
  session: RealtimeSession;
  backlog: Array<{ data: Buffer | ArrayBuffer | Buffer[]; isBinary: boolean }>;
}) {
  const { client, upstream, session } = params;
  let idle = setTimeout(() => close(1001, "Idle session"), IDLE_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => close(1001, "Idle session"), IDLE_TIMEOUT_MS);
  };
  const close = (code: number, reason: string) => {
    clearTimeout(idle);
    const safeCode =
      code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
    if (client.readyState === WebSocket.OPEN) client.close(safeCode, reason);
    else if (client.readyState === WebSocket.CONNECTING) client.terminate();
    if (upstream.readyState === WebSocket.OPEN)
      upstream.close(safeCode, reason);
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  client.on("message", (data, isBinary) => {
    touch();
    if (!isBinary) session.onClientEvent(data.toString());
    if (upstream.readyState === WebSocket.OPEN)
      upstream.send(data, { binary: isBinary });
  });
  const relay = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    touch();
    if (!isBinary) session.onUpstreamEvent(data.toString());
    if (client.readyState === WebSocket.OPEN)
      client.send(data, { binary: isBinary });
  };
  for (const held of params.backlog) relay(held.data, held.isBinary);
  params.backlog.length = 0;
  upstream.on("message", relay);
  client.on("close", (code, reason) => close(code, reason.toString()));
  upstream.on("close", (code, reason) => close(code, reason.toString()));
  client.on("error", (error) => {
    logger.debug({ error }, "Realtime client socket error");
    close(1011, "Client error");
  });
  upstream.on("error", (error) => {
    logger.warn({ error }, "Realtime upstream socket error");
    close(1011, "Upstream error");
  });
}

interface CallerIdentity {
  authMethod: ModelRouterAuth["authMethod"];
  userId?: string;
  serviceAccountId?: string;
  virtualKeyId?: string;
  authenticatedApp?: { id: string; name: string; clientId: string };
  billingTeamId?: string;
}

function callerIdentity(auth: ModelRouterAuth): CallerIdentity {
  return {
    authMethod: auth.authMethod,
    userId: modelRouterAuthenticatedUserId(auth),
    serviceAccountId: auth.serviceAccountId,
    virtualKeyId:
      auth.authMethod === "virtual_key" ? auth.virtualKeyId : undefined,
    authenticatedApp:
      auth.authMethod === "oauth_user"
        ? (auth.oauthClient ?? undefined)
        : auth.oauthClient,
    billingTeamId:
      auth.authMethod === "oauth_user"
        ? undefined
        : (auth.billingTeamId ?? undefined),
  };
}

/** What one session logs: its settings, and one row per completed response. */
class RealtimeSession {
  private turn = 0;
  private session?: Record<string, unknown>;
  private inputText?: string;
  private inputTranscript?: string;
  private turnStartedAt = Date.now();

  constructor(
    private readonly params: {
      agent: GatewayAgent;
      identity: CallerIdentity;
      modelId: string;
      providerApiKeyId: string;
      billingAttribution: BillingAttribution;
    },
  ) {}

  onClientEvent(text: string) {
    const event = parseEvent(text);
    if (!event) return;
    if (event.type === "session.update" && isRecord(event.session))
      this.session = withoutAudio(event.session);
    if (event.type === "conversation.item.create" && isRecord(event.item)) {
      const text = userInputText(event.item);
      if (text)
        this.inputText = this.inputText ? `${this.inputText}\n${text}` : text;
    }
    if (event.type === "response.create") this.turnStartedAt = Date.now();
  }

  onUpstreamEvent(text: string) {
    const event = parseEvent(text);
    if (!event) return;
    if (
      event.type === "conversation.item.input_audio_transcription.completed" &&
      typeof event.transcript === "string"
    )
      this.inputTranscript = event.transcript;
    if (event.type === "response.done" && isRecord(event.response)) {
      const response = event.response;
      const inputText = this.inputText;
      const inputTranscript = this.inputTranscript;
      this.inputText = undefined;
      this.inputTranscript = undefined;
      this.turn += 1;
      const turn = this.turn;
      const startedAt = this.turnStartedAt;
      this.turnStartedAt = Date.now();
      trackBackgroundWork(
        this.record({
          response,
          turn,
          inputText,
          inputTranscript,
          startedAt,
        }).catch((error) => {
          logger.warn(
            { error, model: this.params.modelId },
            "Could not log a realtime response",
          );
        }),
      );
    }
  }

  private async record(params: {
    response: Record<string, unknown>;
    turn: number;
    inputText: string | undefined;
    inputTranscript: string | undefined;
    startedAt: number;
  }) {
    const { agent, identity, modelId, providerApiKeyId } = this.params;
    const { response } = params;
    const usage = isRecord(response.usage) ? response.usage : undefined;
    const inputTokens = numberOr(usage?.input_tokens, 0);
    const outputTokens = numberOr(usage?.output_tokens, 0);
    const cached = isRecord(usage?.input_token_details)
      ? numberOr(usage.input_token_details.cached_tokens, 0)
      : 0;
    const cost = priceOpenAiRealtime({ model: modelId, usage });
    const view: UsageView = {
      inputTokens: Math.max(0, inputTokens - cached),
      outputTokens,
      cacheReadTokens: cached,
      ...(usage ? {} : { usageUnavailable: true }),
      ...(cost === undefined
        ? { costUnavailable: true }
        : { providerReportedCost: cost, mediaTariff: true }),
    };
    const costs = await calculateInteractionCosts({
      actualModel: modelId,
      usage: view,
      providerName: "openai",
      usageAccountingMode: config.llmProxy.usageAccountingMode,
      providerApiKeyId,
    });
    const output = Array.isArray(response.output)
      ? response.output.filter(isRecord).map(withoutAudio)
      : undefined;
    const request = {
      model: modelId,
      turn: params.turn,
      ...(this.session ? { session: this.session } : {}),
      ...(params.inputText ? { input_text: params.inputText } : {}),
      ...(params.inputTranscript
        ? { input_transcript: params.inputTranscript }
        : {}),
    };
    const transcript = output ? outputTranscript(output) : "";
    const record = buildInteractionRecord({
      agent,
      billingAttribution: this.params.billingAttribution,
      authMethod: identity.authMethod,
      billingMode: "metered",
      authenticatedApp: identity.authenticatedApp,
      billingTeamId: identity.billingTeamId,
      userId: identity.userId,
      serviceAccountId: identity.serviceAccountId,
      virtualKeyId: identity.virtualKeyId,
      source: "model_router",
      providerType: "openai:realtime",
      request,
      processedRequest: request,
      response: {
        id: typeof response.id === "string" ? response.id : "",
        status:
          typeof response.status === "string" ? response.status : "completed",
        ...(transcript ? { output_transcript: transcript } : {}),
        ...(output ? { output } : {}),
        ...(usage ? { usage } : {}),
      },
      actualModel: modelId,
      usage: view,
      costs,
    });
    await InteractionModel.create({
      ...record,
      durationMs: Date.now() - params.startedAt,
    });
  }
}

function refuse(socket: Duplex, status: number, message: string) {
  const body = JSON.stringify({
    error: { message, type: "invalid_request_error" },
  });
  const reason =
    {
      400: "Bad Request",
      401: "Unauthorized",
      402: "Payment Required",
      403: "Forbidden",
      404: "Not Found",
      502: "Bad Gateway",
    }[status] ?? "Error";
  if (socket.writable)
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  socket.destroy();
}

function parseEvent(text: string): Record<string, unknown> | undefined {
  if (text.length > MAX_FRAME_BYTES) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.type === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

/** Audio never enters the log: base64 `audio` and `data` fields are dropped at every depth. */
function withoutAudio(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "audio" && typeof item === "string") continue;
    if (key === "data" && typeof item === "string") continue;
    out[key] = Array.isArray(item)
      ? item.map((entry) => (isRecord(entry) ? withoutAudio(entry) : entry))
      : isRecord(item)
        ? withoutAudio(item)
        : item;
  }
  return out;
}

/** The text of a user message item the client created (`input_text` parts). */
function userInputText(item: Record<string, unknown>): string {
  if (item.role !== "user" || !Array.isArray(item.content)) return "";
  const parts: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== "input_text") continue;
    if (typeof part.text === "string" && part.text) parts.push(part.text);
  }
  return parts.join("\n");
}

function outputTranscript(output: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!isRecord(part)) continue;
      const text = part.transcript ?? part.text;
      if (typeof text === "string" && text) parts.push(text);
    }
  }
  return parts.join("\n");
}
