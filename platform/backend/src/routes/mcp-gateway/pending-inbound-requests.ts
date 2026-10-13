import { randomUUID } from "node:crypto";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import logger from "@/logging";

const TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_REQUESTS = 256;
const MAX_PENDING_REQUESTS_PER_CALLER = 16;
/** How often a replica collects answers another replica received for it. */
const PARKED_MESSAGE_POLL_MS = 1_000;
/** One registry lease, not one lease per request. */
const OWNER_LEASE_MS = 30_000;
const OWNER_LEASE_RENEW_MS = 10_000;

type PendingInbound = {
  transport: StreamableHTTPServerTransport;
  /** The id the Server issued; the answer is fed back to it under this id. */
  id: string | number;
  agentId: string;
  organizationId: string;
  /** The caller that was asked; only it may answer. */
  caller: string;
  ownerId: string;
  createdAt: number;
  deadlineAt: number;
  expiryTimer?: NodeJS.Timeout;
};

/** Who was asked a pending request, as every replica can read it. */
export type PendingRequestRecord = {
  organizationId: string;
  agentId: string;
  caller: string;
  ownerId: string;
  deadlineAt: number;
  /**
   * waiting: unclaimed. queued: first answer, immutable.
   * answered: taken for delivery. cancelled: owner dropped it, do not claim.
   */
  status: "waiting" | "queued" | "answered" | "cancelled";
};

/** A client message one replica received for a request another one holds. */
export type ParkedClientMessage = {
  organizationId: string;
  agentId: string;
  caller: string;
  message: Record<string, unknown>;
};

/**
 * Storage shared by every replica. A client answers a server-initiated
 * request with a separate POST, and the load balancer may send that POST to a
 * replica other than the one waiting on the answer.
 *
 * Claim and take are one atomic path: the first authenticated answer wins,
 * and a later answer cannot overwrite or restage it.
 */
export interface SharedPendingRequests {
  remember(params: {
    wireId: string;
    record: PendingRequestRecord;
    ttlMs: number;
  }): Promise<void>;
  renewOwner(params: {
    ownerId: string;
    expiresAt: number;
    ttlMs: number;
  }): Promise<void>;
  lookup(wireId: string): Promise<PendingRequestRecord | undefined>;
  claim(params: {
    wireId: string;
    organizationId: string;
    agentId: string;
    caller: string;
    message: Record<string, unknown>;
  }): Promise<boolean>;
  take(params: {
    ownerId: string;
    wireIds: string[];
  }): Promise<Array<{ wireId: string; parked: ParkedClientMessage }>>;
  forget(wireId: string): Promise<void>;
}

/**
 * Maps outbound server-initiated requests (elicitation, sampling) to active transports.
 * In stateless mode, clients answer server-initiated requests with a separate POST.
 * Because each POST creates a fresh server, this registry routes the answer
 * to the original transport waiting for it.
 *
 * Each request receives a unique wire ID to prevent collisions across concurrent calls.
 * Answers are accepted only from the authenticated caller that received the request,
 * in the same organization. User identity is the caller string (`user:` before `token:`),
 * so a second token for the same user still matches.
 *
 * The registry is in-memory because it holds references to live transports.
 * Every answer, local or remote, is claimed through shared storage and delivered
 * only by taking that claim. A dead owner or a failed write delivers nothing.
 */
export class PendingInboundRequests {
  readonly ownerId = randomUUID();
  private readonly entries = new Map<string, PendingInbound>();
  private readonly shared: SharedPendingRequests | undefined;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private poller: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private leaseExpiresAt = 0;
  private closed = false;
  private shutdown: Promise<void> | undefined;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly pendingCancels = new Set<string>();
  private collectChain: Promise<Set<string>> = Promise.resolve(new Set());

  constructor(
    params: {
      shared?: SharedPendingRequests;
      pollMs?: number;
      leaseMs?: number;
      renewMs?: number;
    } = {},
  ) {
    this.shared = params.shared;
    this.pollMs = params.pollMs ?? PARKED_MESSAGE_POLL_MS;
    this.leaseMs = params.leaseMs ?? OWNER_LEASE_MS;
    this.renewMs = params.renewMs ?? OWNER_LEASE_RENEW_MS;
  }

  /**
   * Registers an outbound request and returns the id to send it under.
   *
   * Refuses admission when either limit is full, the caller is anonymous, or
   * shared storage rejects the write. A failed registration must not be sent.
   */
  async register(params: {
    id: string | number;
    transport: StreamableHTTPServerTransport;
    agentId: string;
    organizationId: string | undefined;
    caller: string;
  }): Promise<string> {
    if (this.closed) {
      throw new Error("Pending request registry is closed");
    }
    if (!params.organizationId || !isAuthenticatedCaller(params.caller)) {
      throw new Error(
        "Server-initiated requests require an authenticated caller",
      );
    }
    this.prune();
    if (this.entries.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Too many pending server-initiated requests");
    }
    if (
      this.pendingForCaller(params.caller) >= MAX_PENDING_REQUESTS_PER_CALLER
    ) {
      throw new Error(
        "Too many pending server-initiated requests for this caller",
      );
    }

    const wireId = `archestra-${randomUUID()}`;
    const now = Date.now();
    const entry: PendingInbound = {
      ...params,
      organizationId: params.organizationId,
      ownerId: this.ownerId,
      createdAt: now,
      deadlineAt: now + TTL_MS,
    };
    this.entries.set(wireId, entry);
    entry.expiryTimer = setTimeout(() => {
      if (this.closed || this.entries.get(wireId) !== entry) return;
      void this.forget({ wireId });
    }, TTL_MS);
    entry.expiryTimer.unref();

    if (!this.shared) return wireId;

    try {
      await this.track(this.publish(wireId, entry));
    } catch (error) {
      this.removeLocal(wireId);
      throw error;
    }
    if (this.closed) {
      this.removeLocal(wireId);
      throw new Error("Pending request registry is closed");
    }
    return wireId;
  }

  /** The wire id a transport's pending request went out under, if any. */
  wireIdOf(params: {
    transport: StreamableHTTPServerTransport;
    id: string | number;
  }): string | undefined {
    this.prune();
    for (const [wireId, entry] of this.entries) {
      if (entry.transport === params.transport && entry.id === params.id) {
        return wireId;
      }
    }
    return undefined;
  }

  /**
   * Remove and return the pending entry for this wire id, if it is still
   * fresh and the answer comes from the caller that was asked. Consume-once.
   * Another caller's answer leaves the entry in place.
   */
  consume(params: {
    wireId: string | number;
    agentId: string;
    organizationId: string;
    caller: string;
  }): PendingInbound | undefined {
    const key = String(params.wireId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      void this.forget({ wireId: key });
      logger.warn(
        { agentId: entry.agentId },
        "Client answer arrived after the pending server-initiated request expired",
      );
      return undefined;
    }
    if (
      entry.agentId !== params.agentId ||
      entry.organizationId !== params.organizationId ||
      entry.caller !== params.caller
    ) {
      logger.warn(
        { agentId: params.agentId },
        "Ignored an answer to a server-initiated request asked of another caller",
      );
      return undefined;
    }
    this.removeLocal(key);
    if (this.shared && !this.closed) {
      void this.cancelShared(key);
    }
    return entry;
  }

  /**
   * Claim this answer for delivery. Local and remote answers use the same
   * shared claim; the owner delivers only by taking that claim.
   */
  async acceptAnswer(params: {
    wireId: string | number;
    agentId: string;
    organizationId: string | undefined;
    caller: string;
    message: Record<string, unknown>;
  }): Promise<boolean> {
    if (this.closed) return false;
    if (!params.organizationId || !isAuthenticatedCaller(params.caller)) {
      return false;
    }
    const wireId = String(params.wireId);
    const claim = {
      wireId,
      agentId: params.agentId,
      organizationId: params.organizationId,
      caller: params.caller,
      message: params.message,
    };
    if (!this.shared) {
      const entry = this.consume(claim);
      if (!entry || this.closed) return false;
      deliverClientMessage({ entry, message: params.message });
      return true;
    }
    const owned = this.entries.has(wireId);
    const claimed = await this.track(this.shared.claim(claim));
    if (!claimed || this.closed) return false;
    if (!owned) return true;
    const delivered = await this.collectParked();
    return delivered.has(wireId);
  }

  /** Forget a request the Server cancelled or stopped waiting on. */
  async forget(params: { wireId: string }): Promise<void> {
    this.removeLocal(params.wireId);
    if (!this.shared || this.closed) return;
    await this.cancelShared(params.wireId);
  }

  /**
   * Forget every request that depended on a transport that has closed.
   * The registry holds the live transport the answer POST writes back to; a
   * closed transport cannot deliver that answer, so TTL cannot keep it alive.
   */
  forgetTransport(params: { transport: StreamableHTTPServerTransport }): void {
    const dropped: string[] = [];
    for (const [wireId, entry] of this.entries) {
      if (entry.transport !== params.transport) continue;
      logger.warn(
        { agentId: entry.agentId },
        "Dropping pending server-initiated request because its transport closed",
      );
      this.removeLocal(wireId);
      dropped.push(wireId);
    }
    if (dropped.length === 0 || !this.shared || this.closed) return;
    for (const wireId of dropped) this.pendingCancels.add(wireId);
    this.stopLease();
    this.leaseExpiresAt = 0;
    this.startCollecting();
    void this.track(this.expireLeaseAndRetryCancels()).catch((error) => {
      logger.error(
        { error },
        "Could not cancel a shared pending request after its transport closed",
      );
    });
  }

  /**
   * Stop collecting and wait for in-flight registration, polling, and cleanup.
   * No shared write starts after this resolves.
   */
  close(): Promise<void> {
    this.shutdown ??= this.finishClose();
    return this.shutdown;
  }

  private async publish(wireId: string, entry: PendingInbound): Promise<void> {
    await this.ensureLease();
    if (this.closed || !this.shared) {
      throw new Error("Pending request registry is closed");
    }
    await this.shared.remember({
      wireId,
      record: {
        organizationId: entry.organizationId,
        agentId: entry.agentId,
        caller: entry.caller,
        ownerId: entry.ownerId,
        deadlineAt: entry.deadlineAt,
        status: "waiting",
      },
      ttlMs: Math.max(1, entry.deadlineAt - Date.now()),
    });
    if (this.closed) {
      this.removeLocal(wireId);
      await this.shared.forget(wireId);
      throw new Error("Pending request registry is closed");
    }
    this.startCollecting();
    this.startLease();
  }

  private async ensureLease(): Promise<void> {
    if (!this.shared) return;
    if (this.leaseExpiresAt - Date.now() > this.leaseMs / 2) return;
    await this.renewLease();
  }

  private async renewLease(): Promise<void> {
    if (
      this.closed ||
      !this.shared ||
      this.entries.size === 0 ||
      this.pendingCancels.size > 0
    ) {
      this.stopLease();
      return;
    }
    const expiresAt = Date.now() + this.leaseMs;
    await this.shared.renewOwner({
      ownerId: this.ownerId,
      expiresAt,
      ttlMs: this.leaseMs,
    });
    if (this.closed) return;
    this.leaseExpiresAt = expiresAt;
  }

  private startCollecting(): void {
    if (this.poller || this.closed) return;
    this.poller = setInterval(() => {
      if (this.closed) return;
      void this.collectParked().catch((error) => {
        logger.debug({ error }, "Collecting parked client answers failed");
      });
    }, this.pollMs);
    this.poller.unref();
  }

  private stopCollecting(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  private startLease(): void {
    if (this.leaseTimer || this.closed || !this.shared) return;
    this.leaseTimer = setInterval(() => {
      if (this.closed) return;
      void this.track(this.renewLease()).catch((error) => {
        logger.debug({ error }, "Could not renew pending-request owner lease");
      });
    }, this.renewMs);
    this.leaseTimer.unref();
  }

  private stopLease(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  private collectParked(): Promise<Set<string>> {
    if (this.closed || !this.shared) return Promise.resolve(new Set());
    const run = this.collectChain.then(() => this.collectOnce());
    // The chain only orders ticks. Callers use the promise returned here,
    // not a later tick's deliveries.
    this.collectChain = run.then(
      () => new Set<string>(),
      () => new Set<string>(),
    );
    return this.track(run);
  }

  /** One tick: deliver claimed answers, then clean up. Cleanup cannot drop them. */
  private async collectOnce(): Promise<Set<string>> {
    const delivered = new Set<string>();
    if (this.closed || !this.shared) return delivered;
    await this.retryCancels();
    if (this.pendingCancels.size > 0) {
      this.stopLease();
      return delivered;
    }
    this.prune();
    if (this.entries.size === 0) {
      this.stopCollecting();
      this.stopLease();
      return delivered;
    }
    await this.renewLease();
    const parked = await this.shared.take({
      ownerId: this.ownerId,
      wireIds: [...this.entries.keys()],
    });
    for (const { wireId, parked: answer } of parked) {
      const entry = this.detachLocal({
        wireId,
        agentId: answer.agentId,
        organizationId: answer.organizationId,
        caller: answer.caller,
      });
      if (!entry) continue;
      deliverClientMessage({ entry, message: answer.message });
      delivered.add(wireId);
      try {
        await this.cancelShared(wireId);
      } catch (error) {
        logger.error(
          { error, wireId },
          "Could not cancel a shared pending request after delivery",
        );
      }
    }
    return delivered;
  }

  private async cancelShared(wireId: string): Promise<void> {
    if (!this.shared || this.closed) return;
    this.pendingCancels.add(wireId);
    await this.track(this.retryCancels());
  }

  private async expireLeaseAndRetryCancels(): Promise<void> {
    if (!this.shared || this.closed) return;
    try {
      await this.shared.renewOwner({
        ownerId: this.ownerId,
        expiresAt: Date.now() - 1,
        ttlMs: this.leaseMs,
      });
    } catch (error) {
      logger.error(
        { error },
        "Could not expire the owner lease after a transport closed",
      );
    }
    await this.retryCancels();
  }

  private async retryCancels(): Promise<void> {
    if (!this.shared) return;
    for (const id of [...this.pendingCancels].sort()) {
      try {
        await this.shared.forget(id);
        this.pendingCancels.delete(id);
      } catch (error) {
        logger.error(
          { error, wireId: id },
          "Could not cancel a shared pending request",
        );
        this.stopLease();
        this.leaseExpiresAt = 0;
        try {
          await this.shared.renewOwner({
            ownerId: this.ownerId,
            expiresAt: Date.now() - 1,
            ttlMs: this.leaseMs,
          });
        } catch (expireError) {
          logger.error(
            { error: expireError },
            "Could not expire the owner lease after a failed cancel",
          );
        }
        throw error;
      }
    }
    if (
      this.pendingCancels.size === 0 &&
      this.entries.size > 0 &&
      !this.closed
    ) {
      this.startLease();
    }
  }

  private async finishClose(): Promise<void> {
    this.closed = true;
    this.stopCollecting();
    this.stopLease();
    await this.drainInflight();
    const remaining = [
      ...new Set([...this.entries.keys(), ...this.pendingCancels]),
    ].sort();
    for (const wireId of this.entries.keys()) this.removeLocal(wireId);
    if (this.shared) {
      for (const wireId of remaining) {
        try {
          await this.shared.forget(wireId);
          this.pendingCancels.delete(wireId);
        } catch (error) {
          logger.error(
            { error, wireId },
            "Could not cancel a shared pending request during close",
          );
          try {
            await this.shared.renewOwner({
              ownerId: this.ownerId,
              expiresAt: Date.now() - 1,
              ttlMs: this.leaseMs,
            });
          } catch (expireError) {
            logger.error(
              { error: expireError },
              "Could not expire the owner lease during close",
            );
          }
        }
      }
    }
    await this.drainInflight();
  }

  private async drainInflight(): Promise<void> {
    for (;;) {
      const pending = [...this.inflight];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry)) void this.forget({ wireId: key });
    }
  }

  private pendingForCaller(caller: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.caller === caller) count += 1;
    }
    return count;
  }

  private isExpired(entry: PendingInbound): boolean {
    return Date.now() >= entry.deadlineAt;
  }

  private detachLocal(params: {
    wireId: string;
    agentId: string;
    organizationId: string;
    caller: string;
  }): PendingInbound | undefined {
    const entry = this.entries.get(params.wireId);
    if (!entry) return undefined;
    if (
      entry.agentId !== params.agentId ||
      entry.organizationId !== params.organizationId ||
      entry.caller !== params.caller ||
      this.isExpired(entry)
    ) {
      return undefined;
    }
    this.removeLocal(params.wireId);
    return entry;
  }

  private removeLocal(wireId: string): void {
    const entry = this.entries.get(wireId);
    if (!entry) return;
    this.entries.delete(wireId);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.then(
      () => {
        this.inflight.delete(work);
      },
      () => {
        this.inflight.delete(work);
      },
    );
    return work;
  }
}

/**
 * Feed a client's answer or cancellation to the Server that sent the request,
 * under the id that Server issued.
 */
export function deliverClientMessage(params: {
  entry: Pick<PendingInbound, "transport" | "id">;
  message: Record<string, unknown>;
}): void {
  const { entry, message } = params;
  const cancellation =
    message.method === "notifications/cancelled" &&
    typeof message.params === "object" &&
    message.params !== null;
  entry.transport.onmessage?.(
    (cancellation
      ? {
          ...message,
          params: {
            ...(message.params as Record<string, unknown>),
            requestId: entry.id,
          },
        }
      : { ...message, id: entry.id }) as unknown as JSONRPCMessage,
  );
}

function isAuthenticatedCaller(caller: string): boolean {
  return /^user:.+/.test(caller) || /^token:.+/.test(caller);
}
