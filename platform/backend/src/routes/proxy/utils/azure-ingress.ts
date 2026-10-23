import type { IncomingMessage } from "node:http";
import { ApiError } from "@archestra/shared/types";
import type { FastifyRequest } from "fastify";

type AzureIngress = Readonly<{ deployment?: string; rawQuery: string }>;
type IngressState = { context: AzureIngress; error?: string };
const ingress = new WeakMap<IncomingMessage, IngressState>();
const AZURE_PREFIX = "/v1/azure";
const AGENT_PREFIX =
  /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i;

/** Untrusted, request-local SDK routing metadata. Never an authentication grant. */
export function getAzureProxyIngress(
  request: Pick<FastifyRequest, "raw">,
): AzureIngress | undefined {
  return ingress.get(request.raw)?.context;
}

/** Runs before route selection, after connection-setup capability rewriting. */
export function rewriteAzureProxyUrl(
  request: IncomingMessage,
  url: string,
): string {
  const queryAt = url.indexOf("?");
  const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
  const rawQuery = queryAt < 0 ? "" : url.slice(queryAt + 1);
  if (pathname !== AZURE_PREFIX && !pathname.startsWith(`${AZURE_PREFIX}/`))
    return url;
  let rest = pathname.slice(AZURE_PREFIX.length);
  const agent = rest.match(AGENT_PREFIX)?.[0] ?? "";
  rest = rest.slice(agent.length);
  if (rest.startsWith("/openai/v1/")) rest = rest.slice("/openai/v1".length);
  else if (rest.startsWith("/openai/")) rest = rest.slice("/openai".length);
  let deployment: string | undefined;
  let error: string | undefined;
  const match = rest.match(/^\/deployments\/([^/]+)(\/.*)$/);
  if (match) {
    try {
      deployment = decodeURIComponent(match[1]);
      if (
        !deployment ||
        deployment === "." ||
        deployment === ".." ||
        Array.from(deployment).some((character) => {
          const code = character.charCodeAt(0);
          return (
            code < 32 || code === 127 || character === "/" || character === "\\"
          );
        })
      ) {
        throw new Error("Invalid deployment segment");
      }
      rest = match[2];
    } catch {
      error = "Azure deployment must be a single valid path segment.";
    }
  }
  ingress.set(request, {
    context: Object.freeze({ deployment, rawQuery }),
    error,
  });
  return `${AZURE_PREFIX}${agent}${rest}${queryAt < 0 ? "" : `?${rawQuery}`}`;
}

/** Normalize native SDK auth before a route's header schema transforms it. */
export function prepareAzureProxyIngress(request: FastifyRequest): void {
  const state = ingress.get(request.raw);
  if (!state) return;
  if (state.error) throw new ApiError(400, state.error);
  const versions = new URLSearchParams(state.context.rawQuery).getAll(
    "api-version",
  );
  if (
    versions.length > 1 ||
    versions.some((value) => !/^[A-Za-z0-9._-]+$/.test(value))
  ) {
    throw new ApiError(400, "Supply one valid Azure api-version.");
  }
  for (const name of ["authorization", "api-key"]) {
    let count = 0;
    for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
      if (request.raw.rawHeaders[i].toLowerCase() === name) count++;
    }
    if (count > 1 || Array.isArray(request.raw.headers[name])) {
      throw new ApiError(
        400,
        "Duplicate Azure authentication headers are not allowed.",
      );
    }
  }
  const apiKey = request.raw.headers["api-key"];
  const authorization = request.raw.headers.authorization;
  if (typeof apiKey !== "string") return;
  if (!apiKey || /[\s,]/.test(apiKey))
    throw new ApiError(401, "Invalid Azure api-key header.");
  const bearer = authorization?.replace(/^Bearer\s+/i, "");
  if (authorization !== undefined && bearer !== apiKey) {
    throw new ApiError(
      400,
      "Conflicting Azure authentication headers are not allowed.",
    );
  }
  for (const headers of new Set([request.headers, request.raw.headers])) {
    headers.authorization = `Bearer ${apiKey}`;
    delete headers["api-key"];
  }
  // Keep native credentials out of downstream header forwarding and raw logs.
  for (let i = request.raw.rawHeaders.length - 2; i >= 0; i -= 2) {
    if (request.raw.rawHeaders[i].toLowerCase() === "api-key")
      request.raw.rawHeaders.splice(i, 2);
  }
}

/** The URL deployment selects the Azure resource, even when the body names a model. */
export function applyAzureProxyDeployment(request: FastifyRequest): void {
  const deployment = getAzureProxyIngress(request)?.deployment;
  if (
    deployment !== undefined &&
    typeof request.body === "object" &&
    request.body !== null &&
    !Array.isArray(request.body)
  ) {
    Object.assign(request.body, { model: deployment });
  }
}
