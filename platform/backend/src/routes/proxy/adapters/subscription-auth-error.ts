import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";

/**
 * Relays the ProviderAuthRequired classification across the synthetic-HTTP hop
 * a subscription credential's fetch wrapper produces.
 *
 * A dead subscription sign-in (expired/revoked refresh token for ChatGPT/Codex
 * or X Premium) is reported by the token managers as a synthetic 401 whose body
 * carries the normalized `internal_code`. Each subscription-capable adapter's
 * `extractInternalCode` must relay it so the chat error mapper renders the
 * connect/reconnect card instead of a generic invalid-key message — this is the
 * one place that contract lives instead of a copy per adapter.
 */
export function subscriptionAuthRequiredCode(
  error: unknown,
): typeof ArchestraInternalErrorCode.ProviderAuthRequired | undefined {
  return get(error, "error.internal_code") ===
    ArchestraInternalErrorCode.ProviderAuthRequired
    ? ArchestraInternalErrorCode.ProviderAuthRequired
    : undefined;
}
