declare const circuitPermitBrand: unique symbol;

/** Opaque single-use permit minted by `ScorerCircuitBreaker.acquire`. */
export interface CircuitPermit {
  readonly [circuitPermitBrand]: true;
}

/**
 * Process-local circuit breaker keyed by scorer endpoint identity.
 *
 * State transitions per key:
 * - `closed`: tracks consecutive transient failures; opens at `failureThreshold`.
 * - `open`: rejects immediately until `cooldownMs` elapses, then admits one
 *   single-flight `half_open` probe.
 * - `half_open`: rejects concurrent callers until the single probe settles.
 *   Only `recordSuccess` closes the circuit; `recordNeutral` and
 *   `recordTransientFailure` renew the cooldown, while `release` preserves the
 *   prior `openedAt` and `cooldownMs` so the next caller may probe immediately.
 *
 * Permits are opaque, single-use, and fenced by entry object identity so stale
 * completions from prior phases, evictions, or `clear()` calls cannot corrupt
 * current state.
 */
export class ScorerCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CircuitEntry>();
  private readonly activePermits = new WeakMap<CircuitPermit, PermitMetadata>();

  constructor(options?: ScorerCircuitBreakerOptions) {
    this.failureThreshold = Math.max(
      1,
      options?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    );
    this.cooldownMs = Math.max(0, options?.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.maxEntries = Math.max(1, options?.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options?.now ?? (() => performance.now());
  }

  acquire(key: string): CircuitPermit | null {
    const existing = this.entries.get(key);
    if (!existing) {
      if (this.entries.size >= this.maxEntries && !this.evictForCapacity()) {
        // Never discard an active open cooldown or half-open probe; return an
        // untracked permit whose settlement/release methods are no-ops.
        return createPermit();
      }
      const entry: ClosedEntry = { state: "closed", consecutiveFailures: 0 };
      this.entries.set(key, entry);
      return this.mintPermit(key, entry);
    }

    switch (existing.state) {
      case "closed":
        return this.mintPermit(key, existing);
      case "half_open":
        return null;
      case "open": {
        if (this.now() - existing.openedAt < existing.cooldownMs) {
          return null;
        }
        const entry: HalfOpenEntry = {
          state: "half_open",
          openedAt: existing.openedAt,
          cooldownMs: existing.cooldownMs,
        };
        this.entries.set(key, entry);
        return this.mintPermit(key, entry);
      }
    }
  }

  recordSuccess(permit: CircuitPermit): void {
    this.settle(permit, "success");
  }

  recordNeutral(permit: CircuitPermit): void {
    this.settle(permit, "neutral");
  }

  recordTransientFailure(
    permit: CircuitPermit,
    options?: { cooldownMs?: number },
  ): void {
    this.settle(permit, "transient_failure", options?.cooldownMs);
  }

  release(permit: CircuitPermit): void {
    const resolved = this.takeActive(permit);
    if (!resolved) return;

    if (resolved.entry.state === "half_open") {
      // Return to `open` preserving `openedAt` and `cooldownMs` so the next
      // caller can probe immediately without closing or wedging `half_open`.
      this.entries.set(resolved.key, {
        state: "open",
        openedAt: resolved.entry.openedAt,
        cooldownMs: resolved.entry.cooldownMs,
      });
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private mintPermit(key: string, entry: ActiveCircuitEntry): CircuitPermit {
    const permit = createPermit();
    this.activePermits.set(permit, { key, entry });
    return permit;
  }

  private takeActive(permit: CircuitPermit): PermitMetadata | null {
    const meta = this.activePermits.get(permit);
    if (!meta) return null;
    this.activePermits.delete(permit);
    return this.entries.get(meta.key) === meta.entry ? meta : null;
  }

  private settle(
    permit: CircuitPermit,
    outcome: SettleOutcome,
    cooldownOverrideMs?: number,
  ): void {
    const resolved = this.takeActive(permit);
    if (!resolved) return;

    const cooldownMs =
      cooldownOverrideMs !== undefined
        ? Math.max(0, cooldownOverrideMs)
        : this.cooldownMs;

    if (resolved.entry.state === "half_open") {
      if (outcome === "success") {
        this.entries.set(resolved.key, {
          state: "closed",
          consecutiveFailures: 0,
        });
      } else {
        // Neither a transient failure nor a 4xx/malformed 2xx probe proves
        // usable scorer recovery, so renew the cooldown.
        this.entries.set(resolved.key, {
          state: "open",
          openedAt: this.now(),
          cooldownMs,
        });
      }
      return;
    }

    if (outcome === "transient_failure") {
      resolved.entry.consecutiveFailures += 1;
      if (resolved.entry.consecutiveFailures >= this.failureThreshold) {
        this.entries.set(resolved.key, {
          state: "open",
          openedAt: this.now(),
          cooldownMs,
        });
      }
      return;
    }

    resolved.entry.consecutiveFailures = 0;
  }

  private evictForCapacity(): boolean {
    for (const [key, entry] of this.entries) {
      if (entry.state === "closed") {
        this.entries.delete(key);
        return true;
      }
    }
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.state === "open" && now - entry.openedAt >= entry.cooldownMs) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}

// === Internal ===

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 256;

interface ScorerCircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  maxEntries?: number;
  now?: () => number;
}

type SettleOutcome = "success" | "neutral" | "transient_failure";

type ClosedEntry = { state: "closed"; consecutiveFailures: number };
type OpenEntry = { state: "open"; openedAt: number; cooldownMs: number };
type HalfOpenEntry = {
  state: "half_open";
  openedAt: number;
  cooldownMs: number;
};
type ActiveCircuitEntry = ClosedEntry | HalfOpenEntry;
type CircuitEntry = ActiveCircuitEntry | OpenEntry;

interface PermitMetadata {
  readonly key: string;
  readonly entry: ActiveCircuitEntry;
}

function createPermit(): CircuitPermit {
  return {} as CircuitPermit;
}
