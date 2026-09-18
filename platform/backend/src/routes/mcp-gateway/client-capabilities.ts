const TTL_MS = 60 * 60 * 1000;

type RememberedCapabilities = {
  capabilities: unknown;
  createdAt: number;
};

/**
 * Stateless mode builds a fresh Server per POST, so capabilities a client
 * declared at `initialize` are gone by the next request. A 2026-07-28 client
 * re-declares them on every request under `_meta`; a legacy client (Claude
 * Code over streamable HTTP, and similar) declares them once at initialize.
 * This store remembers the initialize declaration per profile, token and
 * client (User-Agent) so a later `tools/call` can still tell whether the
 * client answers a server-initiated request.
 *
 * In-memory on purpose: in-band elicitation answers are routed in-process
 * anyway (see pending-inbound-requests.ts), so cross-replica persistence
 * would promise more than the delivery path can keep.
 */
class ClientCapabilityStore {
  private readonly entries = new Map<string, RememberedCapabilities>();

  remember(params: { key: string; capabilities: unknown }): void {
    this.prune();
    this.entries.set(params.key, {
      capabilities: params.capabilities,
      createdAt: Date.now(),
    });
  }

  lookup(params: { key: string }): unknown {
    const entry = this.entries.get(params.key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > TTL_MS) {
      this.entries.delete(params.key);
      return undefined;
    }
    return entry.capabilities;
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, entry] of this.entries) {
      if (entry.createdAt < cutoff) {
        this.entries.delete(key);
      }
    }
  }
}

export const clientCapabilityStore = new ClientCapabilityStore();

export function clientCapabilityKey(params: {
  profileId: string;
  tokenId?: string;
  userId?: string;
  userAgent?: string;
}): string {
  const { profileId, tokenId, userId, userAgent } = params;
  // One personal token commonly serves several clients at once, and each
  // declares its own capabilities: the client software is part of the key,
  // so a client without elicitation cannot overwrite one that has it.
  return `${profileId}:${tokenId ?? userId ?? "anonymous"}:${userAgent ?? ""}`;
}
