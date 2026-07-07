import {
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import logger from "@/logging";
import { LlmProviderApiKeyModel, VirtualApiKeyModel } from "@/models";
import {
  type AnthropicCreditVerdict,
  probeAnthropicCredit,
} from "@/routes/chat/model-fetchers/anthropic-credit-probe";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import { ApiError } from "@/types";

/**
 * A non-fatal warning attached to a connection setup when the Anthropic key it
 * bound couldn't be confirmed to have a usable balance. None of the probed keys
 * were usable, so the reason is one of:
 * - `insufficient_balance` — a key's remaining usage balance is too low, whether
 *   out of credit or over a usage/spend limit (do-not-retry).
 * - `unverified` — every probe was inconclusive (transient errors after retries —
 *   retry-friendly).
 */
export type ConnectionCreditWarning =
  | { kind: "insufficient_balance" }
  | { kind: "unverified" };

/** How many Anthropic keys we'll credit-probe before giving up (bounds cost/latency). */
const MAX_CREDIT_PROBE_CANDIDATES = 4;

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
}): Promise<{
  virtualApiKeyId: string;
  creditWarning?: ConnectionCreditWarning;
}> {
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

  // Anthropic keys can pass the (free) /v1/models test at creation yet be out of
  // credit, which then fails Claude Desktop silently. Credit-probe the resolved
  // key; if it's exhausted (or unverifiable), fall through to the org's other
  // accessible Anthropic keys and bind the first one with credit. If none pass,
  // still bind the originally-resolved key and surface a non-fatal warning.
  const { keyToBind, creditWarning } =
    !isPerUser && provider === "anthropic"
      ? await selectAnthropicKeyByCredit({
          resolvedKey: providerApiKey,
          organizationId,
          userId,
          userTeamIds,
        })
      : { keyToBind: providerApiKey, creditWarning: undefined };

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
        providerApiKeyId: keyToBind.id,
      });
      return { virtualApiKeyId: existing.id, creditWarning };
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
    providerApiKeys: [{ provider, providerApiKeyId: keyToBind.id }],
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
      providerApiKeyId: keyToBind.id,
    });
    return { virtualApiKeyId: winner.id, creditWarning };
  }

  return { virtualApiKeyId: virtualKey.id, creditWarning };
}

/**
 * Ensures the per-user passthrough virtual key used to attribute /connection
 * passthrough requests (Claude Code subscription, Claude Desktop API key) to the
 * acting user via the X-Archestra-Virtual-Key header. The key carries NO provider
 * credential — it only identifies the user. One key per user (named like the
 * standard connection key); LLM proxy access is governed by the user's own
 * access permissions at request time, so the key is not bound to any proxy.
 *
 * Reuses the existing key when present and still typed passthrough with a
 * readable secret; recreates it otherwise. Creation happens only here (at
 * setup-create time, never at render time) because secrets-manager writes do not
 * roll back with a DB transaction. Returns the virtual key id; the raw value is
 * re-read at render time via {@link readVirtualKeyValue}.
 */
export async function ensureConnectionPassthroughKey(params: {
  organizationId: string;
  userId: string;
  userEmail: string;
}): Promise<string> {
  const { organizationId, userId, userEmail } = params;

  const name = connectionPassthroughKeyName(userEmail);
  const existing = await VirtualApiKeyModel.findByAuthorScopeName({
    organizationId,
    authorId: userId,
    scope: "personal",
    name,
  });

  if (existing) {
    const secret =
      existing.keyType === "passthrough"
        ? await secretManager().getSecret(existing.secretId)
        : null;
    if (existing.keyType === "passthrough" && secret) {
      return existing.id;
    }
    // Wrong type (name squatted) or secret revoked out from under us: replace
    // the row so previously rendered scripts stay broken but new setups work.
    logger.warn(
      {
        virtualApiKeyId: existing.id,
        organizationId,
        keyType: existing.keyType,
      },
      "ensureConnectionPassthroughKey: existing key not reusable; recreating",
    );
    await VirtualApiKeyModel.delete(existing.id);
  }

  const { virtualKey } = await VirtualApiKeyModel.create({
    organizationId,
    name,
    keyType: "passthrough",
    scope: "personal",
    authorId: userId,
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

/** The minimum a key needs for a credit probe: its id + how to reach Anthropic. */
interface CreditProbeCandidate {
  id: string;
  secretId: string | null;
  baseUrl: string | null;
  inferenceBaseUrl: string | null;
  extraHeaders: Record<string, string> | null;
}

/**
 * Pick which Anthropic key to bind based on remaining usage balance. Probes the
 * resolved key first, then the user's other accessible Anthropic keys (bounded),
 * and binds the first `usable` one. If none are usable, returns the
 * originally-resolved key plus a non-fatal warning: `insufficient_balance` when a
 * key was definitively out of usable balance, else `unverified` when every probe
 * was inconclusive (fail-open — never block setup on a probe).
 */
async function selectAnthropicKeyByCredit(params: {
  resolvedKey: CreditProbeCandidate;
  organizationId: string;
  userId: string;
  userTeamIds: string[];
}): Promise<{
  keyToBind: CreditProbeCandidate;
  creditWarning?: ConnectionCreditWarning;
}> {
  const { resolvedKey, organizationId, userId, userTeamIds } = params;

  const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
    organizationId,
    userId,
    userTeamIds,
    "anthropic",
  );
  // Resolved key first (preserves the admin/precedence choice when it works),
  // then the rest — bounded so a pathological key set can't fan out probes.
  const candidates: CreditProbeCandidate[] = [
    resolvedKey,
    ...available.filter((key) => key.id !== resolvedKey.id),
  ].slice(0, MAX_CREDIT_PROBE_CANDIDATES);

  // A definitive "balance too low" beats a transient one; `unverified` is the
  // fallback if we only saw inconclusive probes.
  let sawExhausted = false;
  let sawInconclusive = false;
  for (const candidate of candidates) {
    const verdict = await probeCandidateCredit(candidate);
    if (verdict === "usable") {
      return { keyToBind: candidate };
    }
    if (verdict === "exhausted") {
      sawExhausted = true;
    } else if (verdict === "inconclusive") {
      sawInconclusive = true;
    }
    // `skipped` (revoked secret): not usable, keep looking.
  }

  const creditWarning: ConnectionCreditWarning | undefined = sawExhausted
    ? { kind: "insufficient_balance" }
    : sawInconclusive
      ? { kind: "unverified" }
      : undefined;

  return { keyToBind: resolvedKey, creditWarning };
}

async function probeCandidateCredit(
  candidate: CreditProbeCandidate,
): Promise<AnthropicCreditVerdict | "skipped"> {
  // Left "" for keyless modes (e.g. Workload Identity) that carry no secretId —
  // getAnthropicAuthHeaders("") treats a falsy key as the keyless-mode trigger and
  // authenticates the probe accordingly.
  let apiKeyValue = "";
  if (candidate.secretId) {
    const value = await getSecretValueForLlmProviderApiKey(candidate.secretId);
    // Secret revoked out from under the row — skip, don't classify it.
    if (!value) return "skipped";
    apiKeyValue = value;
  }
  // A `/v1/messages` probe is an inference call, so prefer the inference base URL
  // override, then the general override, then the configured default.
  const baseUrl = candidate.inferenceBaseUrl ?? candidate.baseUrl ?? null;
  return probeAnthropicCredit(apiKeyValue, baseUrl, candidate.extraHeaders);
}

function connectionVirtualKeyName(userEmail: string): string {
  // Virtual key names cap at 256 chars; emails are well under that.
  return `Connection setup — ${userEmail}`.slice(0, 256);
}

function connectionPassthroughKeyName(userEmail: string): string {
  // Distinct from connectionVirtualKeyName so findByAuthorScopeName never
  // confuses a standard connection key with the passthrough attribution key.
  return `Connection passthrough — ${userEmail}`.slice(0, 256);
}
