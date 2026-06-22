import { randomBytes } from "node:crypto";
import type { FastifyInstanceWithZod } from "@/server";

/**
 * Header carrying a single-use loopback nonce on an in-process `fastify.inject`
 * request. The nonce is an opaque lookup key — it carries no identity claim and
 * never leaves the process — so an external request cannot forge a loopback
 * principal. Identity lives server-side in {@link LoopbackGateway}, keyed by the
 * nonce, and is resolved by the auth middleware.
 */
export const LOOPBACK_HEADER = "x-archestra-loopback";

const NONCE_TTL_MS = 60_000;

export type LoopbackIdentity = {
  userId: string;
  organizationId: string;
};

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type LoopbackRequest = LoopbackIdentity & {
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

type LoopbackResponse = {
  status: number;
  body: unknown;
};

type NonceEntry = LoopbackIdentity & { expiresAt: number };

/**
 * Dispatches in-process requests to the platform's own HTTP API as a given
 * user, so the real auth, RBAC, validation, and audit middleware run end to end
 * — the same path a UI click takes. Used by the `archestra__api` tool.
 */
class LoopbackGateway {
  private server: FastifyInstanceWithZod | null = null;
  private readonly nonces = new Map<string, NonceEntry>();

  setServer(server: FastifyInstanceWithZod): void {
    this.server = server;
  }

  async request(params: LoopbackRequest): Promise<LoopbackResponse> {
    const server = this.server;
    if (!server) {
      throw new Error("loopback gateway has no server instance configured");
    }

    const nonce = this.issue({
      userId: params.userId,
      organizationId: params.organizationId,
    });
    try {
      const hasBody = params.body !== undefined;
      const response = await server.inject({
        method: params.method,
        url: buildUrl(params.path, params.query),
        headers: {
          [LOOPBACK_HEADER]: nonce,
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { payload: JSON.stringify(params.body) } : {}),
      });
      return { status: response.statusCode, body: parseBody(response.payload) };
    } finally {
      this.nonces.delete(nonce);
    }
  }

  /**
   * Resolve a loopback nonce to the identity it was issued for. Returns null
   * when the nonce is unknown or expired, so the request falls through to the
   * normal auth methods and is rejected.
   */
  resolve(nonce: string): LoopbackIdentity | null {
    const entry = this.nonces.get(nonce);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.nonces.delete(nonce);
      return null;
    }
    return { userId: entry.userId, organizationId: entry.organizationId };
  }

  private issue(identity: LoopbackIdentity): string {
    this.pruneExpired();
    const nonce = randomBytes(32).toString("base64url");
    this.nonces.set(nonce, {
      ...identity,
      expiresAt: Date.now() + NONCE_TTL_MS,
    });
    return nonce;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.nonces) {
      if (entry.expiresAt < now) {
        this.nonces.delete(nonce);
      }
    }
  }
}

export const loopbackGateway = new LoopbackGateway();

// === Internal helpers ===

function buildUrl(path: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }
  return `${path}?${new URLSearchParams(query).toString()}`;
}

function parseBody(payload: string): unknown {
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}
