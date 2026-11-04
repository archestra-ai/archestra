import crypto from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";

const DEFAULT_EPHEMERAL_GRANT_TTL_SECONDS = 300;
const MIN_EPHEMERAL_GRANT_TTL_SECONDS = 30;
const MAX_EPHEMERAL_GRANT_TTL_SECONDS = 3600;

export interface EphemeralCredentialGrant {
  id: string;
  organizationId: string;
  userId: string;
  callerAgentId: string;
  allowedAgentIds: string[];
  key: string;
  value: string;
  expiresAt: number;
}

export function ephemeralCredentialGrantCacheKey(
  grantId: string,
): AllowedCacheKey {
  return `${CacheKey.EphemeralCredentialGrant}-${grantId}`;
}

function callerLockKey(callerAgentId: string): AllowedCacheKey {
  return `${CacheKey.EphemeralCredentialGrant}-caller:${callerAgentId}`;
}

function validateGrant(
  grantId: string,
  grant: EphemeralCredentialGrant | undefined,
  params: {
    organizationId: string;
    userId: string;
    callerAgentId: string;
    candidateAgentIds: string[];
  },
): string | null {
  if (!grant || grant.expiresAt <= Date.now()) {
    return `Credential grant "${grantId}" is expired, already consumed, or invalid. Call transfer_credential with ephemeral: true to mint a fresh grant before start_agent_run.`;
  }
  if (
    grant.organizationId !== params.organizationId ||
    grant.userId !== params.userId ||
    grant.callerAgentId !== params.callerAgentId
  ) {
    return `Credential grant "${grantId}" does not belong to this caller or user.`;
  }
  const candidateSet = new Set(params.candidateAgentIds);
  const matchesAnyCandidate = grant.allowedAgentIds.some((id) =>
    candidateSet.has(id),
  );
  if (!matchesAnyCandidate) {
    return `Credential grant "${grantId}" is not scoped to the requested subagent(s).`;
  }
  return null;
}

function buildGrantResolution(resolvedGrants: EphemeralCredentialGrant[]): {
  ok: true;
  grants: EphemeralCredentialGrant[];
  env: Record<string, string>;
  envForAgent: (agentId: string) => Record<string, string>;
} {
  const env: Record<string, string> = {};
  for (const grant of resolvedGrants) {
    env[grant.key] = grant.value;
  }
  return {
    ok: true,
    grants: resolvedGrants,
    env,
    envForAgent: (agentId: string) => {
      const scopedEnv: Record<string, string> = {};
      for (const grant of resolvedGrants) {
        if (grant.allowedAgentIds.includes(agentId)) {
          scopedEnv[grant.key] = grant.value;
        }
      }
      return scopedEnv;
    },
  };
}

/**
 * Shared-cache manager for short-lived, one-time credential grants minted by
 * `transfer_credential({ ephemeral: true })` and redeemed by `start_agent_run`.
 *
 * The tool call that mints a grant and the `start_agent_run` call that redeems
 * it reach whichever replica the load balancer picks, so grants live in the
 * shared cache and this class keeps no state of its own.
 */
export class EphemeralCredentialGrantManager {
  async createGrant(
    params: Omit<EphemeralCredentialGrant, "id" | "expiresAt"> & {
      ttlSeconds?: number;
    },
  ): Promise<{
    grantId: string;
    expiresInSeconds: number;
  }> {
    const requestedTtl =
      params.ttlSeconds ?? DEFAULT_EPHEMERAL_GRANT_TTL_SECONDS;
    const expiresInSeconds = Math.max(
      MIN_EPHEMERAL_GRANT_TTL_SECONDS,
      Math.min(MAX_EPHEMERAL_GRANT_TTL_SECONDS, Math.floor(requestedTtl)),
    );
    const grantId = crypto.randomUUID();
    const ttlMs = expiresInSeconds * TimeInMs.Second;
    const expiresAt = Date.now() + ttlMs;
    await cacheManager.set<EphemeralCredentialGrant>(
      ephemeralCredentialGrantCacheKey(grantId),
      {
        id: grantId,
        organizationId: params.organizationId,
        userId: params.userId,
        callerAgentId: params.callerAgentId,
        allowedAgentIds: [...new Set(params.allowedAgentIds)],
        key: params.key,
        value: params.value,
        expiresAt,
      },
      ttlMs,
    );
    return { grantId, expiresInSeconds };
  }

  /**
   * Restore previously consumed grants for the remainder of their original
   * lifetime, skipping any grant whose `expiresAt` has already passed.
   */
  async restoreGrants(grants: EphemeralCredentialGrant[]): Promise<void> {
    const now = Date.now();
    for (const grant of grants) {
      const remainingTtlMs = grant.expiresAt - now;
      if (remainingTtlMs <= 0) {
        continue;
      }
      await cacheManager.set(
        ephemeralCredentialGrantCacheKey(grant.id),
        grant,
        remainingTtlMs,
      );
    }
  }

  /**
   * Validate and resolve one or more ephemeral credential grants without
   * deleting them yet, so a launch that is refused before a pod is started
   * does not spend the caller's grant.
   */
  async resolveGrants(params: {
    grantIds: string[];
    organizationId: string;
    userId: string;
    callerAgentId: string;
    candidateAgentIds: string[];
  }): Promise<
    | {
        ok: true;
        grants: EphemeralCredentialGrant[];
        env: Record<string, string>;
        envForAgent: (agentId: string) => Record<string, string>;
      }
    | { ok: false; message: string }
  > {
    const uniqueGrantIds = [...new Set(params.grantIds)];
    if (uniqueGrantIds.length === 0) {
      return {
        ok: true,
        grants: [],
        env: {},
        envForAgent: () => ({}),
      };
    }

    const resolvedGrants: EphemeralCredentialGrant[] = [];
    for (const grantId of uniqueGrantIds) {
      const grant = await cacheManager.get<EphemeralCredentialGrant>(
        ephemeralCredentialGrantCacheKey(grantId),
        { throwOnError: true },
      );
      const validationError = validateGrant(grantId, grant, params);
      if (validationError) {
        return { ok: false, message: validationError };
      }
      if (grant) {
        resolvedGrants.push(grant);
      }
    }

    return buildGrantResolution(resolvedGrants);
  }

  /**
   * Atomically validate and consume one or more ephemeral credential grants
   * once the winning launch has passed preflight and is ready to start.
   */
  async consumeGrants(params: {
    grantIds: string[];
    organizationId: string;
    userId: string;
    callerAgentId: string;
    candidateAgentIds: string[];
  }): Promise<
    | {
        ok: true;
        grants: EphemeralCredentialGrant[];
        env: Record<string, string>;
        envForAgent: (agentId: string) => Record<string, string>;
        restore: () => Promise<void>;
      }
    | { ok: false; message: string }
  > {
    const uniqueGrantIds = [...new Set(params.grantIds)];
    if (uniqueGrantIds.length === 0) {
      return {
        ok: true,
        grants: [],
        env: {},
        envForAgent: () => ({}),
        restore: async () => {},
      };
    }

    return cacheManager.withLock(
      callerLockKey(params.callerAgentId),
      async (cache) => {
        const resolvedGrants: EphemeralCredentialGrant[] = [];
        for (const grantId of uniqueGrantIds) {
          const grant = await cache.get<EphemeralCredentialGrant>(
            ephemeralCredentialGrantCacheKey(grantId),
          );
          const validationError = validateGrant(grantId, grant, params);
          if (validationError) {
            return { ok: false, message: validationError };
          }
          if (grant) {
            resolvedGrants.push(grant);
          }
        }

        for (const grantId of uniqueGrantIds) {
          await cache.delete(ephemeralCredentialGrantCacheKey(grantId));
        }

        let restored = false;
        const resolution = buildGrantResolution(resolvedGrants);
        return {
          ...resolution,
          restore: async () => {
            if (restored) return;
            restored = true;
            await this.restoreGrants(resolvedGrants);
          },
        };
      },
    );
  }
}

export const ephemeralCredentialGrantManager =
  new EphemeralCredentialGrantManager();
