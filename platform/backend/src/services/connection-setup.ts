import {
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import logger from "@/logging";
import { LlmProviderApiKeyModel, VirtualApiKeyModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { ApiError } from "@/types";

/**
 * Ensures the per-user virtual API key used by /connection setup scripts and
 * maps it to the provider API key the user would resolve to for `provider`
 * (personal → team → org precedence, preferring primary keys). Reuses the
 * existing key when present; recreates it when the row or its secret has been
 * revoked. Creation happens only here (at setup-create time, never at script
 * render time) because secrets-manager writes do not roll back with a DB
 * transaction.
 *
 * Returns the virtual key id; the raw value is re-read from the secrets
 * manager at render time via {@link readVirtualKeyValue}.
 */
export async function ensureConnectionVirtualKey(params: {
  organizationId: string;
  userId: string;
  userEmail: string;
  userTeamIds: string[];
  provider: SupportedProvider;
  /**
   * Admin-configured default key for this provider (from the org's
   * connectionDefaultProviderKeys mapping). Used when still valid; otherwise
   * resolution falls back to the user's personal → team → org precedence.
   */
  preferredProviderKeyId?: string | null;
}): Promise<string> {
  const {
    organizationId,
    userId,
    userEmail,
    userTeamIds,
    provider,
    preferredProviderKeyId,
  } = params;

  // Per-user providers (GitHub Copilot): the connection virtual key must wrap
  // the connecting user's OWN personal key — never an admin-configured or
  // org/team-shared default, which would hand one account's credential to
  // everyone. getCurrentApiKey already resolves only the acting user's personal
  // key for per-user providers, so skip the admin-default precedence entirely.
  const isPerUser = providerRequiresPerUserCredential(provider);
  const providerApiKey = isPerUser
    ? await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId,
        userId,
        userTeamIds,
        provider,
        conversationId: null,
      })
    : ((await resolvePreferredProviderKey({
        preferredProviderKeyId,
        organizationId,
        provider,
      })) ??
      (await LlmProviderApiKeyModel.getCurrentApiKey({
        organizationId,
        userId,
        userTeamIds,
        provider,
        conversationId: null,
      })));
  if (!providerApiKey) {
    throw new ApiError(
      400,
      isPerUser
        ? `Connect your own ${provider} account before generating a setup command — each user links their own.`
        : `No ${provider} API key is configured for your account, teams, or organization. Ask an admin to add one under LLM provider keys.`,
    );
  }

  const name = connectionVirtualKeyName(userEmail);
  const existing = await VirtualApiKeyModel.findByAuthorScopeName({
    organizationId,
    authorId: userId,
    scope: "personal",
    name,
  });

  if (existing) {
    const secret = await secretManager().getSecret(existing.secretId);
    if (secret) {
      await VirtualApiKeyModel.ensureProviderMapping({
        virtualApiKeyId: existing.id,
        provider,
        providerApiKeyId: providerApiKey.id,
      });
      return existing.id;
    }

    // Revoked out from under us (secret gone, row orphaned): replace it so
    // previously rendered scripts stay broken but new setups work.
    logger.warn(
      { virtualApiKeyId: existing.id, organizationId },
      "ensureConnectionVirtualKey: existing key has no readable secret; recreating",
    );
    await VirtualApiKeyModel.delete(existing.id);
  }

  const { virtualKey } = await VirtualApiKeyModel.create({
    organizationId,
    name,
    scope: "personal",
    authorId: userId,
    providerApiKeys: [{ provider, providerApiKeyId: providerApiKey.id }],
  });

  // Names are not unique, so two concurrent setups can both miss the lookup
  // above and create twins. Re-resolve the deterministic winner (oldest row);
  // the loser deletes its own key and converges on the winner.
  const winner = await VirtualApiKeyModel.findByAuthorScopeName({
    organizationId,
    authorId: userId,
    scope: "personal",
    name,
  });
  if (winner && winner.id !== virtualKey.id) {
    await VirtualApiKeyModel.delete(virtualKey.id);
    await VirtualApiKeyModel.ensureProviderMapping({
      virtualApiKeyId: winner.id,
      provider,
      providerApiKeyId: providerApiKey.id,
    });
    return winner.id;
  }

  return virtualKey.id;
}

/**
 * Reads the raw virtual key value for script rendering. Returns null when the
 * key row or its secret is gone (revoked) — callers must treat that as a
 * render failure, never render a placeholder.
 */
export async function readVirtualKeyValue(
  virtualApiKeyId: string,
): Promise<string | null> {
  const virtualKey = await VirtualApiKeyModel.findById(virtualApiKeyId);
  if (!virtualKey) return null;

  const secret = await secretManager().getSecret(virtualKey.secretId);
  const token = (secret?.secret as { token?: string } | undefined)?.token;
  return token ?? null;
}

// ===================================================================
// Internal helpers
// ===================================================================

/**
 * Validates the admin-mapped key at use time (it may have been deleted or
 * repointed since the mapping was saved). Invalid → null → precedence
 * fallback.
 */
async function resolvePreferredProviderKey(params: {
  preferredProviderKeyId: string | null | undefined;
  organizationId: string;
  provider: SupportedProvider;
}) {
  if (!params.preferredProviderKeyId) return null;
  const key = await LlmProviderApiKeyModel.findById(
    params.preferredProviderKeyId,
  );
  if (
    !key ||
    key.organizationId !== params.organizationId ||
    key.provider !== params.provider
  ) {
    logger.warn(
      {
        providerApiKeyId: params.preferredProviderKeyId,
        provider: params.provider,
        organizationId: params.organizationId,
      },
      "resolvePreferredProviderKey: configured default key invalid; falling back to precedence resolution",
    );
    return null;
  }
  return key;
}

function connectionVirtualKeyName(userEmail: string): string {
  // Virtual key names cap at 256 chars; emails are well under that.
  return `Connection setup — ${userEmail}`.slice(0, 256);
}
