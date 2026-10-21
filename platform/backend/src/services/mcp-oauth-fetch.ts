import type { Agent } from "undici";
import config from "@/config";
import logger from "@/logging";
import EnvironmentModel from "@/models/environment";
import McpServerModel from "@/models/mcp-server";
import MemberModel from "@/models/member";
import OrganizationModel from "@/models/organization";
import TeamModel from "@/models/team";
import { ApiError, type InternalMcpCatalog, type NetworkPolicy } from "@/types";
import {
  createPinnedOutboundDispatcher,
  validateOutboundUrl,
} from "@/utils/outbound-url";
import { isHostAllowedByNetworkPolicy } from "./environments/network-policy-match";

/** A refusal must escape discovery fallbacks and token-refresh classification. */
export class McpOAuthOutboundError extends ApiError {
  constructor(reason: string) {
    super(
      403,
      `MCP OAuth outbound request refused: ${reason}`,
      "mcp_oauth_outbound_refused",
    );
  }
}

/** Context comes from a stored catalog and an authorized request or installation. */
export interface McpOAuthContext {
  catalog: Pick<
    InternalMcpCatalog,
    "id" | "organizationId" | "environmentId" | "serverType" | "serverUrl"
  >;
  organizationId?: string;
  installationId?: string;
}

/**
 * Default compatibility mode is exactly the existing fetch: no context reads,
 * DNS lookups, redirect changes or added limits. Never install this globally.
 */
export function createMcpOAuthFetch(context?: McpOAuthContext): typeof fetch {
  if (!config.mcpOAuth.enforceOutboundValidation) return globalThis.fetch;
  return new GuardedMcpOAuthFetch(context).fetch;
}

// === Internal helpers ===

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

class GuardedMcpOAuthFetch {
  // Sticky across a discovery chain, including SDK-internal fallback attempts.
  private refusal: McpOAuthOutboundError | undefined;

  constructor(private readonly context?: McpOAuthContext) {}

  fetch: typeof fetch = async (input, init) => {
    if (this.refusal) throw this.refusal;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let dispatcher: Agent | undefined;
    let destinationUrl: string | undefined;
    try {
      // Request normalizes URL/method/headers without accepting dispatcher or
      // redirect overrides. Only the validated URL is passed to fetch below.
      destinationUrl = input instanceof Request ? input.url : String(input);
      const initialUrl = validateOutboundUrl(destinationUrl);
      if (!initialUrl.ok) throw new McpOAuthOutboundError(initialUrl.reason);
      const request = new Request(input, init);
      signal.throwIfAborted();
      if (request.headers.has("host"))
        throw new McpOAuthOutboundError("host header overrides are disabled");
      const policy = await abortable(resolvePolicy(this.context), signal);
      let url = request.url;
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        // Recheck the normalized initial URL and each subsequent redirect.
        destinationUrl = url;
        const validation = validateOutboundUrl(url);
        if (!validation.ok) throw new McpOAuthOutboundError(validation.reason);
        if (
          !isHostAllowedByNetworkPolicy({
            host: validation.url.hostname,
            policy,
          })
        ) {
          throw new McpOAuthOutboundError(
            "environment policy denies destination",
          );
        }
        // DNS itself cannot be canceled; destroy a late result if the deadline
        // won. No socket may be opened after cancellation.
        const pinning = createPinnedOutboundDispatcher({
          hostname: validation.url.hostname,
        });
        void pinning
          .then((result) => {
            if (signal.aborted && result.ok)
              void result.dispatcher.destroy().catch(() => {});
          })
          .catch(() => {});
        const pinned = await abortable(pinning, signal);
        if (!pinned.ok) {
          if (pinned.reason === "unresolved_host")
            throw new Error("MCP OAuth DNS resolution failed");
          throw new McpOAuthOutboundError(pinned.reason);
        }
        dispatcher = pinned.dispatcher;
        signal.throwIfAborted();
        const response = await globalThis.fetch(validation.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          // Node requires duplex for a Request's body stream.
          ...(request.body ? { duplex: "half" } : {}),
          signal,
          redirect: "manual",
          dispatcher,
        } as RequestInit);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          // Never replay a credential-bearing POST, even to the same origin.
          // Only metadata GETs without credentials may follow redirects.
          if (
            request.method !== "GET" ||
            request.headers.has("authorization") ||
            request.headers.has("cookie") ||
            [...request.headers.keys()].some(
              (key) => !["accept", "mcp-protocol-version"].includes(key),
            )
          ) {
            throw new McpOAuthOutboundError(
              "credential-bearing redirects are disabled",
            );
          }
          if (redirects >= MAX_REDIRECTS)
            throw new McpOAuthOutboundError("too many redirects");
          const location = response.headers.get("location");
          if (!location)
            throw new McpOAuthOutboundError("redirect has no location");
          url = new URL(location, validation.url).href;
          await dispatcher.destroy();
          dispatcher = undefined;
          continue;
        }
        // Buffer a bounded response before releasing its socket. This covers
        // consumers that skip bodies (404 discovery) as well as SDK consumers.
        const body = await readBoundedBody(response, signal);
        return new McpOAuthResponse(
          [204, 205, 304].includes(response.status) ? null : body,
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      }
    } catch (error) {
      if (error instanceof McpOAuthOutboundError) {
        this.refusal = error;
        // Never log full URLs, headers or bodies: they can contain credentials.
        let hostname: string | undefined;
        try {
          hostname = new URL(destinationUrl ?? "").hostname;
        } catch {
          // Malformed URLs have no safe hostname to include.
        }
        logger.warn(
          { hostname, reason: error.message },
          "MCP OAuth outbound request refused",
        );
        throw error;
      }
      // Ordinary transport failures retain discovery fallback and transient
      // refresh semantics, without leaking raw causes or credential-bearing URLs.
      const safeError = new Error(
        signal.aborted
          ? "MCP OAuth request canceled or timed out"
          : "MCP OAuth request failed",
      );
      safeError.name = signal.aborted ? "TimeoutError" : "Error";
      throw safeError;
    } finally {
      clearTimeout(timer);
      await dispatcher?.destroy().catch(() => {});
    }
  };
}

class McpOAuthResponse extends Response {
  override async json() {
    try {
      return await super.json();
    } catch {
      throw new Error("MCP OAuth response is not valid JSON");
    }
  }
}

async function resolvePolicy(
  context?: McpOAuthContext,
): Promise<NetworkPolicy | null> {
  if (!context) throw new McpOAuthOutboundError("missing catalog context");
  const { catalog, installationId } = context;
  let organizationId: string | null | undefined =
    context.organizationId ?? catalog.organizationId;
  if (catalog.organizationId && organizationId !== catalog.organizationId) {
    throw new McpOAuthOutboundError("catalog organization mismatch");
  }
  if (installationId) {
    const installation = await McpServerModel.findById(installationId);
    if (!installation || installation.catalogId !== catalog.id) {
      throw new McpOAuthOutboundError("installation context mismatch");
    }
    if (installation.teamId) {
      const team = await TeamModel.findById(installation.teamId, {
        includeMembers: false,
      });
      if (!team || (organizationId && team.organizationId !== organizationId)) {
        throw new McpOAuthOutboundError("installation organization mismatch");
      }
      organizationId = team.organizationId;
    }
    if (!organizationId) {
      if (installation.ownerId) {
        const ids = await MemberModel.findOrganizationIdsByUserId(
          installation.ownerId,
        );
        if (ids.length > 1) {
          throw new McpOAuthOutboundError(
            "installation owner belongs to multiple organizations; explicit organization context required",
          );
        }
        if (ids.length === 1) organizationId = ids[0];
      }
    }
    if (
      !organizationId ||
      !(await McpServerModel.findByIdInOrg(installationId, organizationId))
    ) {
      throw new McpOAuthOutboundError("missing installation organization");
    }
  }
  if (!organizationId)
    throw new McpOAuthOutboundError("missing organization context");
  const organization = await OrganizationModel.getById(organizationId);
  if (!organization) throw new McpOAuthOutboundError("organization not found");
  let policy = organization.defaultNetworkPolicy;
  if (catalog.environmentId) {
    const environment = await EnvironmentModel.findByIdForOrganization(
      catalog.environmentId,
      organizationId,
    );
    if (!environment)
      throw new McpOAuthOutboundError("environment not found in organization");
    policy = environment.networkPolicy ?? policy;
  }
  // OAuth can run before the remote transport guard. Enforce its base-host
  // policy first too; local catalog OAuth is still backend-originated traffic.
  if (catalog.serverType === "remote" && catalog.serverUrl) {
    if (
      !isHostAllowedByNetworkPolicy({
        host: new URL(catalog.serverUrl).hostname,
        policy,
      })
    ) {
      throw new McpOAuthOutboundError("environment policy denies MCP server");
    }
  }
  return policy;
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new McpOAuthOutboundError("response too large");
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks, size)).buffer;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(
            new DOMException(
              "MCP OAuth request canceled or timed out",
              "TimeoutError",
            ),
          );
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
