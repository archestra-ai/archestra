import { createHash } from "node:crypto";
import { pipeline, Transform } from "node:stream";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import type { FastifyHttpProxyOptions } from "@fastify/http-proxy";
import { z } from "zod";
import {
  getUnverifiedToolAttestationGatewayId,
  takeLeadingAttestation,
  verifyToolAttestation,
} from "@/archestra-mcp-server/tool-attestation";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import AgentModel from "@/models/agent";
import { trackBackgroundWork } from "@/utils/background-work";
import { buildClaudeMcpToolDefinitions } from "./mcp-tool-token-estimate";

class ClaudeCodeToolTokenCountObserver {
  // Request-local handoff, never a cache of request bodies or credentials.
  private readonly pending = new WeakMap<object, PendingCount>();

  async prepare(
    request: object,
    body: unknown,
    upstream: string,
  ): Promise<void> {
    const deadline = performance.now() + PREPARATION_TIMEOUT_MS;
    try {
      const parsed = CountRequestSchema.safeParse(body);
      if (!parsed.success) return;
      const { tools, model } = parsed.data;
      const firstMarker = takeLeadingAttestation(tools[0].description).marker;
      const gatewayId =
        firstMarker && getUnverifiedToolAttestationGatewayId(firstMarker);
      if (!gatewayId) return;
      const gateway = await findGatewayBeforeDeadline(gatewayId, deadline);
      if (!gateway) return;

      const names = new Set<string>();
      let serverName: string | undefined;
      for (const tool of tools) {
        if (performance.now() >= deadline) return;
        if (names.has(tool.name)) return;
        names.add(tool.name);
        const { marker } = takeLeadingAttestation(tool.description);
        const verified =
          marker &&
          verifyToolAttestation({
            organizationId: gateway.organizationId,
            marker,
          });
        if (!verified || verified.gatewayId !== gatewayId) return;
        const [unnamespaced] = buildClaudeMcpToolDefinitions({
          tools: [
            { name: verified.advertisedName, inputSchema: tool.input_schema },
          ],
          serverName: "",
        });
        const prefix = "mcp__";
        const suffix = unnamespaced.name.slice(prefix.length);
        if (!tool.name.startsWith(prefix) || !tool.name.endsWith(suffix))
          return;
        const currentServerName = tool.name.slice(
          prefix.length,
          -suffix.length,
        );
        if (!/^[a-zA-Z0-9_-]+$/.test(currentServerName)) return;
        if (serverName !== undefined && currentServerName !== serverName)
          return;
        serverName = currentServerName;
      }
      const fingerprint = toolFingerprint(tools, upstream);
      if (performance.now() >= deadline) return;
      this.pending.set(request, {
        organizationId: gateway.organizationId,
        gatewayId,
        model,
        fingerprint,
      });
    } catch {
      // Observation is optional; DB or validation failure never changes forwarding.
    }
  }

  onResponse: NonNullable<
    NonNullable<FastifyHttpProxyOptions["replyOptions"]>["onResponse"]
  > = (request, reply, response) => {
    const pending = this.pending.get(request);
    this.pending.delete(request);
    const contentType = reply.getHeader("content-type");
    const encoding = responseEncoding(reply.getHeader("content-encoding"));
    if (
      !pending ||
      reply.statusCode !== 200 ||
      typeof contentType !== "string" ||
      contentType.split(";")[0].trim().toLowerCase() !== "application/json" ||
      encoding === null
    ) {
      reply.send(response.stream);
      return;
    }

    let bytes = 0;
    let chunks: Buffer[] = [];
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else chunks = [];
        callback(null, chunk);
      },
      flush(callback) {
        if (
          bytes <= MAX_RESPONSE_BYTES &&
          !request.raw.aborted &&
          !reply.raw.destroyed
        ) {
          trackBackgroundWork(
            recordCount(pending, Buffer.concat(chunks), encoding),
          );
        }
        chunks = [];
        callback();
      },
    });
    reply.send(tap);
    // Pipeline propagates upstream errors and client cancellation in both directions.
    pipeline(response.stream, tap, () => {});
  };
}

export const claudeCodeToolTokenCountObserver =
  new ClaudeCodeToolTokenCountObserver();

/** Returns a provider count only for the entire current, ordered tool surface. */
export async function getObservedClaudeCodeToolTokenCount(
  params: {
    organizationId: string;
    gatewayId: string;
  } & Parameters<typeof buildClaudeMcpToolDefinitions>[0],
): Promise<{
  total: number;
  model: string;
  observedAt: string;
} | null> {
  try {
    const cached = StoredCountSchema.safeParse(
      await cacheManager.get(cacheKey(params)),
    );
    if (!cached.success) return null;
    const fingerprint = toolFingerprint(
      buildClaudeMcpToolDefinitions(params),
      config.llm.anthropic.baseUrl,
    );
    if (cached.data.fingerprint !== fingerprint) return null;
    const { total, model, observedAt } = cached.data;
    return { total, model, observedAt };
  } catch {
    return null;
  }
}

const StoredCountSchema = z.strictObject({
  fingerprint: z.string(),
  total: z.number().int().nonnegative(),
  model: z.string().min(1).max(200),
  observedAt: z.iso.datetime(),
});

const CountRequestSchema = z.strictObject({
  model: z.string().min(1).max(200),
  tools: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(1024),
        description: z.string(),
        input_schema: z.record(z.string(), z.unknown()),
      }),
    )
    .nonempty(),
  messages: z.tuple([
    z.strictObject({ role: z.literal("user"), content: z.literal("foo") }),
  ]),
});

type PendingCount = {
  organizationId: string;
  gatewayId: string;
  model: string;
  fingerprint: string;
};
const MAX_RESPONSE_BYTES = 4096;
const COUNT_TTL_MS = 60 * 60 * 1000;
const PREPARATION_TIMEOUT_MS = 100;
const RESPONSE_DECODERS = {
  br: promisify(brotliDecompress),
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
};
type ResponseEncoding = "identity" | keyof typeof RESPONSE_DECODERS;

function responseEncoding(header: unknown): ResponseEncoding | null {
  if (header === undefined) return "identity";
  if (typeof header !== "string") return null;
  const encoding = header.trim().toLowerCase();
  switch (encoding) {
    case "identity":
    case "br":
    case "gzip":
    case "deflate":
      return encoding;
    default:
      return null;
  }
}

async function findGatewayBeforeDeadline(gatewayId: string, deadline: number) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return null;
  const lookup = AgentModel.findGatewayAgentById(gatewayId);
  // A timed-out database read can still settle later; keep teardown aware of it.
  trackBackgroundWork(lookup);
  return new Promise<Awaited<typeof lookup>>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), remaining);
    timeout.unref();
    lookup.then(
      (gateway) => {
        clearTimeout(timeout);
        resolve(gateway);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function recordCount(
  pending: PendingCount,
  raw: Buffer,
  encoding: ResponseEncoding,
): Promise<void> {
  try {
    // Decode only the bounded observation copy; the proxy forwards original bytes.
    const decoded =
      encoding === "identity"
        ? raw
        : await RESPONSE_DECODERS[encoding](raw, {
            maxOutputLength: MAX_RESPONSE_BYTES,
          });
    const result: unknown = JSON.parse(decoded.toString("utf8"));
    if (
      typeof result !== "object" ||
      result === null ||
      !("input_tokens" in result)
    )
      return;
    const inputTokens = result.input_tokens;
    if (
      typeof inputTokens !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0
    )
      return;
    await cacheManager.set(
      cacheKey(pending),
      {
        fingerprint: pending.fingerprint,
        // Claude's /context MCP category removes its fixed 500-token overhead.
        total: Math.max(0, inputTokens - 500),
        model: pending.model,
        observedAt: new Date().toISOString(),
      },
      COUNT_TTL_MS,
    );
  } catch {
    // Invalid responses and cache failures remain invisible to the proxied request.
  }
}

function cacheKey(params: { organizationId: string; gatewayId: string }) {
  return `${CacheKey.McpToolTokenCount}-${params.organizationId}:${params.gatewayId}` as const;
}

function toolFingerprint(
  tools: ReturnType<typeof buildClaudeMcpToolDefinitions>,
  upstream: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, upstream, tools }))
    .digest("hex");
}
