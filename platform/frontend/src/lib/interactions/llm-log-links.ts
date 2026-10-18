// Links into the LLM log detail page, `/llm/logs/:id`. The page shows one
// session, keyed the way the session list keys it: by its session id, or, for
// a request logged without a session, by that request's own id.

/** The query parameters that preselect one record on the detail page. */
export const LLM_LOG_FOCUS_PARAM = {
  request: "request",
  toolCall: "toolCall",
} as const;

/** One session's page, optionally with a request or tool call preselected. */
export function llmSessionHref(
  sessionKey: string,
  focus?: { request: string } | { toolCall: string },
): string {
  const path = `/llm/logs/${encodeURIComponent(sessionKey)}`;
  if (!focus) return path;
  const [param, value] =
    "request" in focus
      ? [LLM_LOG_FOCUS_PARAM.request, focus.request]
      : [LLM_LOG_FOCUS_PARAM.toolCall, focus.toolCall];
  return `${path}?${param}=${encodeURIComponent(value)}`;
}

/**
 * One request, preselected on its session's page. A request logged without a
 * session is a session of its own, so its page already shows only it.
 */
export function llmRequestHref(request: {
  id: string;
  sessionId: string | null;
}): string {
  return request.sessionId === null
    ? llmSessionHref(request.id)
    : llmSessionHref(request.sessionId, { request: request.id });
}
