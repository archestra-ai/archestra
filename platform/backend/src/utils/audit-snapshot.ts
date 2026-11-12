/**
 * The parts of an audit record every writer derives the same way: the audit
 * hook of the `/api/*` routes, the Archestra MCP tool dispatch, and the routes
 * and services that write their own record.
 */

/** Cap stored resource names — entity name columns are unbounded text. */
const AUDIT_RESOURCE_NAME_MAX_LENGTH = 512;

/**
 * Denormalized human-readable identity of the audited resource, frozen at
 * event time (never updated on later renames). Prefers the post-state (an
 * update row carries the resulting name), falls back to the prior state
 * (deletes), then to the snapshot's `email` for entities addressed by email
 * rather than name (invitations). Keep the key/snapshot precedence in sync
 * with the frontend's legacy-row fallback `resourceDisplayName`
 * (frontend/src/app/audit/logs/_parts/audit-log-action-labels.ts).
 */
export function extractAuditResourceName(
  after: Record<string, unknown> | null,
  before: Record<string, unknown> | null,
): string | null {
  for (const key of ["name", "email"]) {
    for (const snapshot of [after, before]) {
      const value = snapshot?.[key];
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) return trimmed.slice(0, AUDIT_RESOURCE_NAME_MAX_LENGTH);
    }
  }
  return null;
}

/** Drop volatile timestamp fields so diffs surface real config changes. */
export function sanitizeAuditSnapshot(
  state: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (state === null) return null;
  return deepOmitKeys(state, new Set(["updatedAt"])) as Record<string, unknown>;
}

/**
 * Resolve the client IP for an audited request.
 *
 * Prefers `request.ip` — Fastify applies the `trustProxy` setting so this
 * already incorporates `x-forwarded-for` when a trusted proxy is configured.
 * Falls back to the first hop in `x-forwarded-for` for environments where
 * `socket.remoteAddress` is unavailable (e.g. Unix-socket listeners) and for
 * setups that have a proxy but haven't configured `ARCHESTRA_TRUST_PROXY`.
 */
export function extractAuditSourceIp(request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}): string | null {
  if (request.ip) return request.ip;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string")
    return forwarded.split(",")[0]?.trim() || null;
  if (Array.isArray(forwarded)) return forwarded[0] ?? null;
  return null;
}

// === Internal helpers

function deepOmitKeys(value: unknown, keys: Set<string>): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => deepOmitKeys(v, keys));
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (keys.has(k)) continue;
      out[k] = deepOmitKeys(v, keys);
    }
    return out;
  }
  return value;
}
