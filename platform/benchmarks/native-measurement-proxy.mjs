import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export function createNativeMeasurementProxy({
  base,
  agent,
  measurements,
  classifyRequest = () => "unknown",
  onObservation = () => {},
  onPrivateFailure = null,
  operationNames = null,
  disallowHumanReview = false,
  onModelRequest = () => {},
}) {
  const origin = new URL(base);
  assert.ok(
    origin.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) &&
      origin.pathname === "/" &&
      !origin.username &&
      !origin.password,
  );
  assert.match(agent, /^[a-z0-9-]{8,80}$/i);
  const observations = [];
  const sockets = new Set();
  const upstreams = new Set();
  const pending = new Set();
  const headerKey = randomBytes(32);
  let closed = false;
  const gatewayPath = `/v1/mcp/${agent}`;
  const server = createServer({ maxHeaderSize: 32768 }, (req, res) => {
    const work = handle(req, res);
    pending.add(work);
    work.finally(() => pending.delete(work));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  async function handle(req, res) {
    const arrivedMs = performance.now();
    let id,
      ended = false,
      observation = null;
    const end = (status) => {
      if (id !== undefined && !ended) {
        ended = true;
        measurements.end({ id, status, httpStatus: res.statusCode });
      }
    };
    res.once("finish", () =>
      end(
        observation?.logicalFailure || res.statusCode >= 400
          ? "failed"
          : "complete",
      ),
    );
    res.once("close", () => end("cancelled"));
    try {
      const url = new URL(req.url, origin);
      const anthropic = url.pathname === `/v1/anthropic/${agent}/v1/messages`;
      const codex = url.pathname === `/v1/openai/${agent}/responses`;
      const gateway = url.pathname === gatewayPath;
      const eventStream =
        gateway &&
        req.method === "GET" &&
        /text\/event-stream/i.test(req.headers.accept ?? "");
      const tokenCount =
        url.pathname === `/v1/anthropic/${agent}/v1/messages/count_tokens`;
      assert.ok(
        url.origin === origin.origin &&
          ["GET", "POST", "DELETE"].includes(req.method) &&
          (anthropic || codex || gateway || tokenCount),
        "route_not_allowed",
      );
      id = measurements.begin({
        kind:
          anthropic || codex
            ? "llm_client"
            : tokenCount
              ? "llm_setup"
              : eventStream
                ? "mcp_stream"
                : "mcp_setup",
        startedMs: arrivedMs,
      });
      const startedMs = performance.now();
      const bytes = await boundedBytes(req);
      const body = bytes.length
        ? JSON.parse(
            decode(bytes, req.headers["content-encoding"]).toString("utf8"),
          )
        : null;
      const isTool = gateway && body?.method === "tools/call";
      const kind =
        anthropic || codex
          ? "llm_client"
          : tokenCount
            ? "llm_setup"
            : isTool
              ? "mcp_tool"
              : eventStream
                ? "mcp_stream"
                : "mcp_setup";
      const role = classifyRequest({ body, headers: req.headers, kind });
      const operation = isTool
        ? ((operationNames
            ? operationNames.find((name) =>
                String(body.params?.name ?? "").endsWith(`__${name}`),
              )
            : PROJECT_OPERATIONS.find((name) =>
                String(body.params?.name ?? "").includes(name),
              )) ??
          HELPERS.find((name) =>
            String(body.params?.name ?? "").includes(name),
          ) ??
          "other")
        : null;
      measurements.classify({
        id,
        kind,
        role,
        operation,
        requestHash: hash(bytes),
      });
      const hashes = Object.fromEntries(
        ROUTING_HEADERS.filter((name) => req.headers[name] !== undefined).map(
          (name) => [
            name,
            createHmac("sha256", headerKey)
              .update(String(req.headers[name]))
              .digest("hex"),
          ],
        ),
      );
      const rawMessages = body?.messages ?? body?.input ?? [];
      const messages = Array.isArray(rawMessages) ? rawMessages : [];
      const toolItems = messages.filter((item) =>
        ["additional_tools", "tool_search_output"].includes(item?.type),
      );
      const declarations = [
        body?.tools,
        body?.additional_tools,
        ...toolItems.map((item) => item.tools),
      ]
        .filter(Array.isArray)
        .flat();
      const systemParts = [
        body?.system,
        body?.instructions,
        ...messages.filter(
          (item) =>
            !toolItems.includes(item) &&
            ["system", "developer"].includes(item?.role),
        ),
      ].filter((item) => item !== undefined && item !== null);
      const history = Array.isArray(rawMessages)
        ? messages.filter(
            (item) =>
              !toolItems.includes(item) &&
              !["system", "developer"].includes(item?.role),
          )
        : rawMessages;
      observation = {
        id,
        kind,
        role,
        operation,
        requestHash: hash(bytes),
        routingHeaderHashes: hashes,
        requestBytes: bytes.length,
        serializedDeclaredToolsBytes: declarations.length
          ? Buffer.byteLength(JSON.stringify(declarations))
          : 0,
        declaredToolCount: countDeclaredTools(declarations),
        serializedSystemContextBytes: systemParts.length
          ? Buffer.byteLength(JSON.stringify(systemParts))
          : 0,
        serializedHistoryContextBytes: history.length
          ? Buffer.byteLength(JSON.stringify(history))
          : 0,
        requestedModel:
          typeof body?.model === "string" &&
          /^(?:claude|gpt)-[a-zA-Z0-9_.-]+$/.test(body.model)
            ? body.model
            : null,
        nativeMetadataFields: [
          "user_id",
          "agent_id",
          "session_id",
          "parent_session_id",
        ].filter((key) => body?.metadata?.[key] !== undefined),
        clientIdentityHash:
          typeof body?.metadata?.user_id === "string"
            ? createHmac("sha256", headerKey)
                .update(
                  JSON.stringify({
                    user_id: body.metadata.user_id,
                    agent_id: body.metadata.agent_id ?? null,
                  }),
                )
                .digest("hex")
            : null,
        requestReadMs: performance.now() - startedMs,
        status: null,
        httpMethod: req.method,
        rpcMethod: [
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
          "ping",
        ].includes(body?.method)
          ? body.method
          : null,
        responseMessageHash: null,
        counters: null,
        logicalFailure: false,
      };
      observations.push(observation);
      if (kind === "llm_client") await onModelRequest({ requestBytes: bytes.length });
      if (
        disallowHumanReview &&
        isTool &&
        /(?:^|__)ask_user$/.test(String(body.params?.name ?? ""))
      ) {
        observation.logicalFailure = true;
        observation.humanReviewRefused = true;
        observation.status = 200;
        const result = JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "This benchmark supports automated reviews only. Use the offered automatic authority; no human review request was sent.",
              },
            ],
          },
        });
        observation.responseBytes = Buffer.byteLength(result);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(result);
        await onObservation(observation);
        return;
      }
      await new Promise((resolve) => {
        const upstream = request(
          url,
          { method: req.method, headers: forwardHeaders(req.headers) },
          (incoming) => {
            observation.status = incoming.statusCode;
            if (
              gateway &&
              !isTool &&
              /text\/event-stream/i.test(
                String(incoming.headers["content-type"] ?? ""),
              )
            ) {
              measurements.classify({
                id,
                kind: "mcp_stream",
                role,
                operation: null,
                requestHash: hash(bytes),
              });
              observation.kind = "mcp_stream";
            }
            res.writeHead(
              incoming.statusCode,
              forwardHeaders(incoming.headers),
            );
            const chunks = [];
            let size = 0;
            incoming.on("data", (chunk) => {
              size += chunk.length;
              if (size <= MAX_BYTES) chunks.push(chunk);
            });
            incoming.once("end", () => {
              try {
                assert.ok(size <= MAX_BYTES, "observation_body_limit");
                const raw = Buffer.concat(chunks);
                observation.responseBytes = raw.length;
                observation.responseHash = hash(raw);
                if (incoming.statusCode >= 400) {
                  if (onPrivateFailure) {
                    const saved = Promise.resolve(
                      onPrivateFailure({
                        id,
                        status: incoming.statusCode,
                        requestBody: bytes,
                        responseBody: raw,
                        requestEncoding:
                          req.headers["content-encoding"] ?? null,
                        responseEncoding:
                          incoming.headers["content-encoding"] ?? null,
                      }),
                    );
                    pending.add(saved);
                    saved
                      .catch(() => {
                        observation.privateFailureWitnessError = true;
                      })
                      .finally(() => pending.delete(saved));
                  }
                  try {
                    const error = JSON.parse(
                      decode(
                        raw,
                        incoming.headers["content-encoding"],
                      ).toString("utf8"),
                    )?.error;
                    const text =
                      typeof error?.message === "string" ? error.message : "";
                    observation.errorType = [
                      "invalid_request_error",
                      "authentication_error",
                      "permission_error",
                      "not_found_error",
                      "rate_limit_error",
                      "api_error",
                      "overloaded_error",
                    ].includes(error?.type)
                      ? error.type
                      : "other";
                    observation.errorFlags = {
                      thinking: /thinking|signature/i.test(text),
                      toolBinding: /tool_use|tool_result|tool.*id/i.test(text),
                      metadata: /user_id|metadata/i.test(text),
                      model:
                        /unsupported.*model|model.*not.*supported|unknown.model/i.test(
                          text,
                        ),
                      context: /context|too many tokens|too long/i.test(text),
                    };
                  } catch {
                    observation.errorType = "unparsed";
                  }
                }
                if (anthropic || codex) {
                  Object.assign(
                    observation,
                    extractResponseCounters({
                      bytes: raw,
                      encoding: incoming.headers["content-encoding"],
                      protocol: anthropic ? "anthropic" : "responses",
                    }),
                  );
                  observation.logicalFailure = observation.modelFailed;
                } else if (isTool) {
                  const value = rpcValue(
                    decode(raw, incoming.headers["content-encoding"]).toString(
                      "utf8",
                    ),
                  );
                  observation.logicalFailure =
                    !!value?.error ||
                    value?.result?.isError === true ||
                    (value?.result?.resultType !== undefined &&
                      value.result.resultType !== "complete");
                }
              } catch {
                observation.observationError =
                  "response_observation_incomplete";
              }
              resolve();
            });
            incoming.once("error", () => {
              observation.observationError = "upstream_stream_error";
              res.destroy();
              resolve();
            });
            incoming.pipe(res);
          },
        );
        upstreams.add(upstream);
        upstream.once("close", () => upstreams.delete(upstream));
        upstream.once("error", () => {
          observation.observationError = "upstream_connection_error";
          if (!res.headersSent) res.writeHead(502);
          res.end();
          resolve();
        });
        req.once("aborted", () => upstream.destroy());
        res.once("close", () => {
          if (!res.writableFinished) upstream.destroy();
        });
        upstream.end(bytes);
      });
      await onObservation(observation);
    } catch {
      if (observation)
        observation.observationError ??= "observer_or_forwarding_failure";
      if (!res.headersSent)
        res.writeHead(409, { "content-type": "application/json" });
      if (!res.destroyed)
        res.end('{"error":{"type":"benchmark_proxy_refused"}}');
    }
  }
  return {
    server,
    observations,
    assignClaudeRoles(events) {
      const roles = new Map();
      const spawnMessages = new Set();
      for (const event of events)
        if (
          event.type === "assistant" &&
          typeof event.message?.id === "string"
        ) {
          const key = hash(event.message.id);
          const role = event.parent_tool_use_id ? "child" : "parent";
          assert.ok(
            !roles.has(key) || roles.get(key) === role,
            "conflicting_sdk_response_role",
          );
          roles.set(key, role);
          if (
            role === "parent" &&
            Array.isArray(event.message.content) &&
            event.message.content.some(
              (block) =>
                block.type === "tool_use" &&
                ["Agent", "Task"].includes(block.name),
            )
          )
            spawnMessages.add(key);
        }
      for (const observation of observations)
        if (
          observation.kind === "llm_client" &&
          roles.has(observation.responseMessageHash)
        ) {
          const role = roles.get(observation.responseMessageHash);
          measurements.assignRole({ id: observation.id, role });
          observation.role = role;
        }
      const firstSpawn = observations.find(
        (observation) =>
          observation.kind === "llm_client" &&
          spawnMessages.has(observation.responseMessageHash),
      );
      if (firstSpawn)
        for (const observation of observations)
          if (
            observation.kind === "llm_client" &&
            observation.role === "unknown" &&
            observation.id < firstSpawn.id
          ) {
            // These requests precede the only native spawn. They belong to the
            // root process (including its retries), not a child that does not exist.
            measurements.assignRole({ id: observation.id, role: "parent" });
            observation.role = "parent";
            observation.roleEvidence = "before_observed_native_spawn";
          }
      const identityRoles = new Map();
      for (const observation of observations)
        if (observation.clientIdentityHash && observation.role !== "unknown") {
          const set =
            identityRoles.get(observation.clientIdentityHash) ?? new Set();
          set.add(observation.role);
          identityRoles.set(observation.clientIdentityHash, set);
        }
      for (const observation of observations)
        if (
          observation.kind === "llm_client" &&
          observation.role === "unknown"
        ) {
          const set = identityRoles.get(observation.clientIdentityHash);
          if (set?.size === 1) {
            const [role] = set;
            measurements.assignRole({ id: observation.id, role });
            observation.role = role;
          }
        }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...pending]);
      headerKey.fill(0);
    },
  };
}

function countDeclaredTools(value) {
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + countDeclaredTools(item), 0);
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value.tools)) return countDeclaredTools(value.tools);
  return value.type === "function" || value.function || value.input_schema
    ? 1
    : 0;
}

export function extractResponseCounters({ bytes, encoding, protocol }) {
  const text = decode(bytes, encoding).toString("utf8");
  const values = text.trim().startsWith("{")
    ? [JSON.parse(text)]
    : text.split(/\r?\n\r?\n/).flatMap((frame) => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") return [];
        return [JSON.parse(data)];
      });
  const counters = {};
  const conflicts = new Set();
  const modelFailed = values.some(
    (value) =>
      value.type === "error" ||
      value.type === "response.failed" ||
      value.response?.status === "failed",
  );
  const terminalObserved = values.some((value) =>
    protocol === "anthropic"
      ? value.type === "message_stop"
      : value.type === "response.completed" ||
        (value.object === "response" && value.status === "completed"),
  );
  let messageId, model, serviceTier;
  for (const value of values) {
    const message =
      protocol === "anthropic"
        ? value.message
        : (value.response ?? (value.object === "response" ? value : null));
    if (message?.id) messageId = message.id;
    if (message?.model) model = message.model;
    serviceTier = message?.service_tier ?? value.service_tier ?? serviceTier;
    const usage = message?.usage ?? value.usage;
    if (!usage || typeof usage !== "object") continue;
    for (const [target, source] of Object.entries({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cachedNested: usage.input_tokens_details?.cached_tokens,
      cachedLegacy: usage.cache_read_input_tokens,
      writeNested: usage.input_tokens_details?.cache_write_tokens,
      write30mNested:
        usage.input_tokens_details?.cache_write_tokens_details?.ttl_30m_tokens,
      write12hNested:
        usage.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens,
      writeLegacy: usage.cache_creation_input_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens,
    }))
      if (source !== undefined) {
        const next = count(source);
        if (
          counters[target] !== undefined &&
          counters[target] !== next &&
          !["output", "reasoning"].includes(target)
        )
          conflicts.add(target);
        counters[target] = next;
      }
  }
  const cacheRead =
    protocol === "anthropic"
      ? (counters.cachedLegacy ?? null)
      : (counters.cachedNested ?? counters.cachedLegacy ?? null);
  const cacheReadConflict =
    protocol === "responses" &&
    counters.cachedNested !== undefined &&
    counters.cachedLegacy !== undefined &&
    counters.cachedNested !== counters.cachedLegacy;
  let cacheWrite =
    protocol === "anthropic"
      ? (counters.writeLegacy ?? null)
      : (counters.writeNested ?? counters.writeLegacy ?? null);
  if (protocol === "responses") {
    if (
      counters.writeNested !== undefined &&
      counters.writeLegacy !== undefined &&
      counters.writeNested !== counters.writeLegacy
    )
      conflicts.add("cacheWriteAliases");
    if (
      Number.isSafeInteger(counters.write30mNested) &&
      Number.isSafeInteger(counters.write12hNested)
    ) {
      const total = counters.write30mNested + counters.write12hNested;
      if (cacheWrite === null) cacheWrite = total;
      else if (cacheWrite !== total) conflicts.add("cacheWriteBreakdown");
    }
  }
  const writeConflict = [...conflicts].some(
    (field) => field.startsWith("write") || field.startsWith("cacheWrite"),
  );
  return {
    modelFailed,
    terminalObserved,
    responseMessageHash: typeof messageId === "string" ? hash(messageId) : null,
    model:
      typeof model === "string" &&
      /^(?:claude|gpt)-[a-zA-Z0-9_.-]+$/.test(model)
        ? model
        : null,
    serviceTier: ["default", "standard", "priority", "flex"].includes(
      serviceTier,
    )
      ? serviceTier
      : null,
    counters: {
      input: conflicts.has("input") ? null : (counters.input ?? null),
      output: counters.output ?? null,
      cacheRead:
        cacheReadConflict ||
        conflicts.has("cachedNested") ||
        conflicts.has("cachedLegacy")
          ? null
          : cacheRead,
      cacheWrite: writeConflict ? null : cacheWrite,
      ...(protocol === "responses" && counters.write30mNested !== undefined
        ? {
            cacheWrite30m: conflicts.has("write30mNested")
              ? null
              : counters.write30mNested,
          }
        : {}),
      ...(protocol === "responses" && counters.write12hNested !== undefined
        ? {
            cacheWrite12h: conflicts.has("write12hNested")
              ? null
              : counters.write12hNested,
          }
        : {}),
      reasoning: counters.reasoning ?? null,
    },
    cacheReadConflict,
    counterConflictFields: [...conflicts],
    rawCounterFields: counters,
  };
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function forwardHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !HOP_HEADERS.has(name.toLowerCase()),
    ),
  );
}
async function boundedBytes(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    assert.ok(size <= MAX_BYTES, "request_body_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function decode(bytes, encoding) {
  if (!encoding || encoding === "identity") return bytes;
  if (encoding === "gzip")
    return bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_BYTES })
      : bytes;
  if (encoding === "deflate")
    return inflateSync(bytes, { maxOutputLength: MAX_BYTES });
  if (encoding === "br")
    return brotliDecompressSync(bytes, { maxOutputLength: MAX_BYTES });
  throw new Error("unsupported_observation_encoding");
}
function rpcValue(text) {
  if (text.trim().startsWith("{")) return JSON.parse(text);
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .findLast(Boolean);
  return data ? JSON.parse(data) : null;
}
const MAX_BYTES = 8 * 1024 * 1024;
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const ROUTING_HEADERS = [
  "session_id",
  "conversation_id",
  "x-codex-turn-state",
  "x-codex-installation-id",
  "chatgpt-account-id",
  "openai-conversation-id",
];
const PROJECT_OPERATIONS = [
  "project_list",
  "project_read",
  "project_search",
  "project_edit",
  "project_check",
  "project_publish",
];
const HELPERS = [
  "get_remedy_plans",
  "execute_remedy_plan",
  "get_guardrails_policy",
  "get_guardrails_deployment",
  "get_default_guardrails",
];
