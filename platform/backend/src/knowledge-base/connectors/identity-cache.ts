// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { scryptSync } from "node:crypto";
import { CacheKey, cacheManager } from "@/cache-manager";
import defaultLogger from "@/logging";
import type { ConnectorCredentials } from "@/types";

/**
 * Cross-pass, cross-pod cache for upstream identity lookups (account id →
 * email/profile), backed by the shared `cacheManager`. Permission passes used
 * to re-resolve every distinct principal on every run (30m/1h cadence) even
 * though these mappings barely ever change; this keeps them for a day.
 *
 * Entries are scoped by upstream host AND credential (hashed, never stored
 * raw): what a credential can SEE differs (Cloud email privacy, admin-API
 * fallbacks), so a low-privilege credential's result must not leak to a
 * better-privileged connector on the same host. Values are wrapped so a
 * cached negative (`null` — the common hidden-email case) is distinguishable
 * from a miss. Cache failures degrade to no caching — an identity entry is a
 * pure optimization and must never fail a pass.
 */
export class ConnectorIdentityCache<T> {
  private prefix: `${typeof CacheKey.KbConnectorIdentity}-${string}`;
  private readonly refresh: boolean;

  constructor(params: {
    /** Lookup family, e.g. "confluence-email", "github-profile". */
    namespace: string;
    host: string;
    credentials: ConnectorCredentials;
    /**
     * Serve no cached reads this pass (entries are still rewritten). Full
     * reconcile passes set this so identity changes never wait out the TTL —
     * an admin's manual sync must observe them immediately.
     */
    refresh?: boolean;
  }) {
    this.refresh = params.refresh ?? false;
    // The credential is derived through scrypt, not a fast hash: on
    // Server/DC basic auth the apiToken can be a human-chosen password, and a
    // memory-hard KDF keeps a leaked cache key from being cheaply inverted.
    // Runs once per connector per pass, so the ~50ms cost is immaterial.
    // codeql[js/insufficient-password-hash] scrypt (memory-hard KDF) fingerprints a potentially low-entropy apiToken for cache-key isolation, not password verification.
    const fingerprint = scryptSync(
      // The admin API key rides along: it changes what emails the credential
      // can SEE, so a connector with one must not share entries with one
      // without.
      `${params.credentials.apiToken}\n${params.credentials.adminApiKey ?? ""}`,
      `archestra-kb-identity\n${params.host}\n${params.credentials.email ?? ""}`,
      16,
    ).toString("hex");
    this.prefix = `${CacheKey.KbConnectorIdentity}-${params.namespace}:${fingerprint}`;
  }

  async get(accountId: string): Promise<T | undefined> {
    if (this.refresh) return undefined;
    const entry = await cacheManager.get<{ value: T }>(this.key(accountId));
    return entry?.value;
  }

  async set(accountId: string, value: T): Promise<void> {
    try {
      await cacheManager.set(
        this.key(accountId),
        { value },
        IDENTITY_CACHE_TTL_MS,
      );
    } catch (error) {
      defaultLogger.debug(
        { error, namespace: this.prefix },
        "Could not persist connector identity cache entry; continuing uncached",
      );
    }
  }

  private key(
    accountId: string,
  ): `${typeof CacheKey.KbConnectorIdentity}-${string}` {
    return `${this.prefix}:${accountId}`;
  }
}

/**
 * TTL for identity entries: a day bounds the staleness of the rare upstream
 * email/profile change while eliminating the per-pass re-resolution of every
 * distinct principal.
 */
const IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
