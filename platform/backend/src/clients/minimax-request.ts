/** Normalize only the current native models; explicit legacy/custom IDs pass through. */
export function normalizeMinimaxRequest<T extends Record<string, unknown>>(
  request: T,
): T {
  if (
    request.model !== "MiniMax-M3.1-Flash" &&
    request.model !== "MiniMax-M3"
  ) {
    return request;
  }
  const body: Record<string, unknown> = { ...request };
  const extra = body.extra_body;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (body[key] === undefined) body[key] = value;
    }
    delete body.extra_body;
  }
  if (body.model === "MiniMax-M3.1-Flash") {
    body.thinking = { type: "adaptive" };
    body.reasoning_split = true;
    if (
      !["low", "medium", "high", "xhigh", "max"].includes(
        String(body.reasoning_effort),
      )
    ) {
      body.reasoning_effort = "max";
    }
    delete body.service_tier;
  } else {
    // M3 ignores effort and defaults to adaptive on the OpenAI wire.
    const thinking = body.thinking as { type?: string } | undefined;
    if (!thinking || thinking.type === "enabled")
      body.thinking = { type: "adaptive" };
    delete body.reasoning_effort;
  }
  return body as T;
}

/** Apply the same wire rules when the chat SDK calls MiniMax directly. */
export function createMinimaxFetch(baseFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    if (typeof init?.body !== "string") return baseFetch(input, init);
    return baseFetch(input, {
      ...init,
      body: JSON.stringify(normalizeMinimaxRequest(JSON.parse(init.body))),
    });
  };
}
