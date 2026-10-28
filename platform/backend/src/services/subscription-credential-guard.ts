import {
  ArchestraInternalErrorCode,
  providerDisplayNames,
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
  stripBearerTransportPrefix,
  subscriptionKindFromCredential,
} from "@archestra/shared";
import { ApiError } from "@/types/api";
import { decodeOpenAiCodexCredential } from "./openai-codex-credentials";
import { decodeXaiSubscriptionCredential } from "./xai-subscription-credentials";

export function assertSubscriptionCredentialForProvider(params: {
  apiKey: string | undefined;
  provider: SupportedProvider;
}): void {
  const { provider } = params;
  const credential = stripBearerTransportPrefix(params.apiKey);
  const kind = subscriptionKindFromCredential(credential);
  if (!kind) {
    return;
  }

  const definition = SUBSCRIPTION_CREDENTIALS[kind];
  const decodes =
    kind === "chatgpt"
      ? decodeOpenAiCodexCredential(credential) !== null
      : kind === "x-premium"
        ? decodeXaiSubscriptionCredential(credential) !== null
        : true;
  if (definition.provider === provider && decodes) {
    return;
  }

  throw new ApiError(
    401,
    definition.provider === provider
      ? `${definition.label} credential is unreadable. Reconnect the account to continue.`
      : `The selected ${providerDisplayNames[provider]} key contains a ${definition.label} credential for another provider. Reconnect the correct credential.`,
    ArchestraInternalErrorCode.ProviderAuthRequired,
  );
}

export { stripBearerTransportPrefix } from "@archestra/shared";
