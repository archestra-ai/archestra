import crypto from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";

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
}

/**
 * In-memory manager for short-lived, one-time credential grants minted by
 * `transfer_credential({ ephemeral: true })` and redeemed by `start_agent_run`.
 *
 * Keeps ephemeral secrets out of `user_credentials` and avoids mutating subagent
 * declarations in the database when a caller (such as a CI workflow) wants to
 * bind a per-invocation token strictly to the single winning subagent pod.
 */
class EphemeralCredentialGrantManager {
  private readonly grants = new LRUCacheManager<EphemeralCredentialGrant>({
    maxSize: 2_000,
    defaultTtl: 5 * TimeInMs.Minute,
  });

  createGrant(
    params: Omit<EphemeralCredentialGrant, "id"> & { ttlSeconds?: number },
  ): {
    grantId: string;
    expiresInSeconds: number;
  } {
    const requestedTtl =
      params.ttlSeconds ?? DEFAULT_EPHEMERAL_GRANT_TTL_SECONDS;
    const expiresInSeconds = Math.max(
      MIN_EPHEMERAL_GRANT_TTL_SECONDS,
      Math.min(MAX_EPHEMERAL_GRANT_TTL_SECONDS, Math.floor(requestedTtl)),
    );
    const grantId = crypto.randomUUID();
    this.grants.set(
      grantId,
      {
        id: grantId,
        organizationId: params.organizationId,
        userId: params.userId,
        callerAgentId: params.callerAgentId,
        allowedAgentIds: [...new Set(params.allowedAgentIds)],
        key: params.key,
        value: params.value,
      },
      expiresInSeconds * TimeInMs.Second,
    );
    return { grantId, expiresInSeconds };
  }

  /**
   * Atomically validate and consume one or more ephemeral credential grants for
   * a `start_agent_run` call. If any grant ID is expired, unknown, owned by a
   * different user/caller, or does not cover the candidate subagent pool, no
   * grants are consumed and an error is returned.
   */
  consumeGrants(params: {
    grantIds: string[];
    organizationId: string;
    userId: string;
    callerAgentId: string;
    candidateAgentIds: string[];
  }):
    | {
        ok: true;
        env: Record<string, string>;
        envForAgent: (agentId: string) => Record<string, string>;
      }
    | { ok: false; message: string } {
    const uniqueGrantIds = [...new Set(params.grantIds)];
    if (uniqueGrantIds.length === 0) {
      return {
        ok: true,
        env: {},
        envForAgent: () => ({}),
      };
    }

    const resolvedGrants: EphemeralCredentialGrant[] = [];
    const candidateSet = new Set(params.candidateAgentIds);

    for (const grantId of uniqueGrantIds) {
      const grant = this.grants.get(grantId);
      if (!grant) {
        return {
          ok: false,
          message: `Credential grant "${grantId}" is expired, already consumed, or invalid. Call transfer_credential with ephemeral: true to mint a fresh grant before start_agent_run.`,
        };
      }
      if (
        grant.organizationId !== params.organizationId ||
        grant.userId !== params.userId ||
        grant.callerAgentId !== params.callerAgentId
      ) {
        return {
          ok: false,
          message: `Credential grant "${grantId}" does not belong to this caller or user.`,
        };
      }
      const matchesAnyCandidate = grant.allowedAgentIds.some((id) =>
        candidateSet.has(id),
      );
      if (!matchesAnyCandidate) {
        return {
          ok: false,
          message: `Credential grant "${grantId}" is not scoped to the requested subagent(s).`,
        };
      }
      resolvedGrants.push(grant);
    }

    for (const grantId of uniqueGrantIds) {
      this.grants.delete(grantId);
    }

    const env: Record<string, string> = {};
    for (const grant of resolvedGrants) {
      env[grant.key] = grant.value;
    }

    return {
      ok: true,
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

  clear(): void {
    this.grants.clear();
  }
}

export const ephemeralCredentialGrantManager =
  new EphemeralCredentialGrantManager();
