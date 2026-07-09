import { MICROSOFT_COPILOT_MODELS } from "@archestra/shared";
import { microsoftCopilotTokenManager } from "@/services/microsoft-copilot-token";
import { ApiError } from "@/types";
import type { ModelInfo } from "./types";

/**
 * "Fetches" Microsoft Copilot models. The Graph Chat API has no model
 * selection (requests always run against the user's Microsoft 365 Copilot),
 * so the list is the single static pseudo-model — but unlike a plain static
 * fetcher this one first redeems the stored Entra refresh token, because
 * `testProviderApiKey` uses the fetcher to validate keys on creation.
 *
 * Redemption proves the credential is a live Entra token with our scopes; it
 * deliberately does NOT probe `POST /copilot/conversations` (creating a
 * Copilot conversation as a side effect of every routine model listing would
 * be wrong). Consequence: a valid Entra token without an M365 Copilot license
 * passes key creation and fails on first chat with Graph's error surfaced.
 */
export async function fetchMicrosoftCopilotModels(
  apiKey: string,
  _baseUrlOverride?: string | null,
  _extraHeaders?: Record<string, string> | null,
): Promise<ModelInfo[]> {
  if (!apiKey) {
    throw new ApiError(
      401,
      "Microsoft Copilot requires a connected Microsoft account (no token provided)",
    );
  }

  // Throws an ApiError with Entra's real failure mode (expired/revoked
  // sign-in vs upstream error) — exactly what key validation should surface.
  await microsoftCopilotTokenManager.getAccessToken({ refreshToken: apiKey });

  return MICROSOFT_COPILOT_MODELS.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    provider: "microsoft-copilot" as const,
    capabilities: {
      supportsToolCalling: false,
    },
  }));
}
