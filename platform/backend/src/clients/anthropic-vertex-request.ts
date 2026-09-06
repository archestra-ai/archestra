const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
const ANTHROPIC_VERTEX_API_VERSION = "vertex-2023-10-16";
const ANTHROPIC_VERTEX_MODEL_ID_PATTERN = /^[a-zA-Z0-9._@-]+$/;

export function getAnthropicVertexApiRoot(location: string): string {
  if (location === "global") {
    return "https://aiplatform.googleapis.com/v1";
  }
  if (location === "us" || location === "eu") {
    return `https://aiplatform.${location}.rep.googleapis.com/v1`;
  }
  return `https://${location}-aiplatform.googleapis.com/v1`;
}

/**
 * Convert the Anthropic SDK's canonical Messages request into Vertex AI's
 * publisher-model request. The server-controlled Google credential always
 * replaces caller-supplied provider credentials.
 */
export async function buildAnthropicVertexRequest(params: {
  input: RequestInfo | URL;
  init?: RequestInit;
  project: string;
  location: string;
  authHeaders: HeadersInit;
}): Promise<Request> {
  const { input, init, project, location, authHeaders } = params;
  const request = new Request(input, init);
  const sourceUrl = new URL(request.url);

  if (
    request.method.toUpperCase() !== "POST" ||
    !sourceUrl.pathname.endsWith(ANTHROPIC_MESSAGES_PATH)
  ) {
    return request;
  }

  const body = await parseRequestBody(request);
  const model = body.model;
  if (
    typeof model !== "string" ||
    !ANTHROPIC_VERTEX_MODEL_ID_PATTERN.test(model)
  ) {
    throw new Error("Invalid Anthropic Vertex AI model ID");
  }

  delete body.model;
  body.anthropic_version ??= ANTHROPIC_VERTEX_API_VERSION;

  const operation = body.stream === true ? "streamRawPredict" : "rawPredict";
  const url = new URL(
    `${getAnthropicVertexApiRoot(location)}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/anthropic/models/${model}:${operation}`,
  );
  const headers = buildVertexHeaders(request.headers, authHeaders);

  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

async function parseRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = (await request.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected an object body for Anthropic Vertex AI request");
  }
  return body as Record<string, unknown>;
}

function buildVertexHeaders(
  sourceHeaders: Headers,
  authHeaders: HeadersInit,
): Headers {
  const headers = new Headers(sourceHeaders);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("anthropic-version");
  headers.delete("anthropic-beta");
  headers.delete("content-length");

  new Headers(authHeaders).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.set("content-type", "application/json");
  return headers;
}
