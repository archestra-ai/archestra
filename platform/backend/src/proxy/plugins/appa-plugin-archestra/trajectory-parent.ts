/**
 * Server-owned parent correlation for compact and fork.
 *
 * Clients often mint a new session id and leave no parent id. The plugin
 * stamps the current trajectory on every denial notice, remembers compact/fork
 * on the parent request, and recovers the parent on the next distinct session
 * for the same caller — including an out-of-band summarizer with a fresh id.
 */
export function correlateTrajectoryParent(params: {
  organizationId: string;
  callerId: string;
  agentId: string;
  sessionId: string;
  body: unknown;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  source?: string;
}): string | undefined {
  const parentFromNotices = parentFromStampedNotices(
    params.body,
    params.sessionId,
  );
  const parentFromPending = consumePendingParent(params);
  if (isCompactOrForkRequest(params.body, params.headers, params.source)) {
    rememberPendingParent(params);
  }
  return parentFromNotices ?? parentFromPending;
}

function isCompactOrForkRequest(
  body: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>> = {},
  source?: string,
): boolean {
  if (source?.endsWith(":compaction")) return true;
  const subagent = headerValue(headers, "x-openai-subagent")?.toLowerCase();
  if (subagent === "compact") return true;
  const text = requestText(body);
  if (
    /<command-name>\s*\/?(compact|fork)/i.test(text) ||
    /<fork-source>/i.test(text) ||
    /this session is being continued from a previous conversation/i.test(
      text,
    ) ||
    /\[Old tool result content cleared\]/i.test(text)
  ) {
    return true;
  }
  const metadata = clientMetadata(body);
  return (
    metadata?.request_kind === "compaction" ||
    typeof metadata?.forked_from_thread_id === "string"
  );
}

const pendingParents = new Map<
  string,
  { sessionId: string; rememberedAt: number }
>();

const PENDING_TTL_MS = 10 * 60 * 1000;

function pendingKey(params: {
  organizationId: string;
  callerId: string;
  agentId: string;
}): string {
  return `${params.organizationId}\0${params.callerId}\0${params.agentId}`;
}

function rememberPendingParent(params: {
  organizationId: string;
  callerId: string;
  agentId: string;
  sessionId: string;
}): void {
  pendingParents.set(pendingKey(params), {
    sessionId: params.sessionId,
    rememberedAt: Date.now(),
  });
}

function consumePendingParent(params: {
  organizationId: string;
  callerId: string;
  agentId: string;
  sessionId: string;
}): string | undefined {
  const key = pendingKey(params);
  const pending = pendingParents.get(key);
  if (!pending) return undefined;
  if (Date.now() - pending.rememberedAt > PENDING_TTL_MS) {
    pendingParents.delete(key);
    return undefined;
  }
  if (pending.sessionId === params.sessionId) return undefined;
  pendingParents.delete(key);
  return pending.sessionId;
}

function parentFromStampedNotices(
  body: unknown,
  childSessionId: string,
): string | undefined {
  const sessions = new Set<string>();
  walkNotices(body, (session) => sessions.add(session));
  for (const session of sessions) {
    if (session !== childSessionId) return session;
  }
  return undefined;
}

function walkNotices(
  value: unknown,
  onSession: (session: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkNotices(item, onSession);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const notice = record.notice;
  if (notice && typeof notice === "object" && !Array.isArray(notice)) {
    const meta = notice as Record<string, unknown>;
    if (
      meta.v === 1 &&
      typeof meta.call_id === "string" &&
      typeof meta.session === "string" &&
      meta.session.length > 0
    ) {
      onSession(meta.session);
    }
  }
  for (const nested of Object.values(record)) walkNotices(nested, onSession);
}

function clientMetadata(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const metadata = (body as { client_metadata?: unknown }).client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return metadata as Record<string, unknown>;
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function requestText(body: unknown): string {
  const parts: string[] = [];
  collectStrings(body, parts, 0);
  return parts.join("\n");
}

function collectStrings(value: unknown, into: string[], depth: number): void {
  if (depth > 8 || into.length > 200) return;
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, into, depth + 1);
    }
  }
}
