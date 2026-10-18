import { SOURCE_HEADER } from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import { isWellFormedAppaId } from "@/openappa/service";
import { followAppaSessionHeader } from "@/proxy/plugins/appa-plugin-archestra/host/ingress";
import { extractSessionInfo } from "@/routes/proxy/utils/headers/session-id";
import { isLoopbackRequest } from "@/utils/network";

/**
 * The LLM proxy session a gateway request belongs to, read the way the LLM
 * proxy reads the same request's headers, so a tool call and the interactions
 * of the turn that issued it name the same session.
 *
 * Only header signals exist on an MCP request, so this runs the proxy's own
 * extraction without a body or a resolved client: `X-Archestra-Session-Id`,
 * the `X-Archestra-Meta` session segment, Open WebUI's chat id, and Claude
 * Code's session header, then the OpenAPPA session header under the proxy's
 * rule. The proxy's body signals (Claude `metadata.user_id`, OpenAI `user`,
 * Codex `client_metadata`) and its client-gated generic headers (Codex and
 * OpenCode `session-id` and friends) never apply here, so a request carrying
 * only those links to no session rather than to a guessed one.
 */
export function gatewayLlmSessionId(
  request: FastifyRequest,
): string | undefined {
  const headers = request.headers as Record<
    string,
    string | string[] | undefined
  >;
  const { sessionId } = followAppaSessionHeader({
    headers,
    // The proxy ignores the OpenAPPA header for its chat sources, and trusts
    // a chat source only from loopback. Mirror both so a remote caller that
    // claims to be chat cannot move its calls to another session.
    source:
      readHeader(request, SOURCE_HEADER) === "chat" &&
      isLoopbackRequest(request)
        ? "chat"
        : "api",
    ordinarySession: extractSessionInfo({
      headers,
      body: undefined,
      externalAgentId: undefined,
    }),
  });
  return sessionId ?? undefined;
}

/**
 * The model's own id for the tool call a `tools/call` request executes, when
 * the client sends it: Claude Code stamps the `tool_use` id as
 * `_meta["claudecode/toolUseId"]`, and an OpenAPPA client may name its logical
 * call id as `_meta["com.archestra/logicalToolCallId"]`. The JSON-RPC id is a
 * transport value, never this.
 */
export function gatewayLlmToolCallId(body: unknown): string | undefined {
  if (!isRecord(body) || body.method !== "tools/call") return;
  const params = body.params;
  if (!isRecord(params) || !isRecord(params._meta)) return;
  const meta = params._meta;
  for (const key of LLM_TOOL_CALL_ID_META_KEYS) {
    const value = meta[key];
    if (isBoundedId(value)) return value;
  }
  return;
}

// ===

/** Most specific first: a provider id beats a client's logical id. */
const LLM_TOOL_CALL_ID_META_KEYS = [
  "claudecode/toolUseId",
  "com.archestra/logicalToolCallId",
] as const;

function isBoundedId(value: unknown): value is string {
  return isWellFormedAppaId(value) && Buffer.byteLength(value, "utf8") <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
