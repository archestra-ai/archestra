import {
  type CompleteLinkedIdentityProviderIntentRequest,
  type CompleteLinkedIdentityProviderIntentResponse,
  CompleteLinkedIdentityProviderIntentResponseSchema,
  type CreateLinkedIdentityProviderIntentRequest,
  type CreateLinkedIdentityProviderIntentResponse,
  CreateLinkedIdentityProviderIntentResponseSchema,
  LINKED_IDP_AUTH_COMPLETE_ENDPOINT,
  LINKED_IDP_AUTH_INTENT_ENDPOINT,
  LINKED_IDP_OTHER_SESSION_ERROR_CODE,
} from "@archestra/shared";

/** The link was finished in a different browser session from the one that started it. */
export class LinkedIdentityProviderOtherSessionError extends Error {}

export async function createLinkedIdentityProviderIntent(
  params: CreateLinkedIdentityProviderIntentRequest,
): Promise<CreateLinkedIdentityProviderIntentResponse> {
  const response = await fetch(LINKED_IDP_AUTH_INTENT_ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error("Failed to create identity provider link request");
  }

  return CreateLinkedIdentityProviderIntentResponseSchema.parse(
    await response.json(),
  );
}

export async function completeLinkedIdentityProviderIntent(
  intentId: string,
): Promise<CompleteLinkedIdentityProviderIntentResponse> {
  const body = {
    intentId,
  } satisfies CompleteLinkedIdentityProviderIntentRequest;

  const response = await fetch(LINKED_IDP_AUTH_COMPLETE_ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
    } | null;
    if (
      error?.code === LINKED_IDP_OTHER_SESSION_ERROR_CODE &&
      typeof error.message === "string"
    ) {
      throw new LinkedIdentityProviderOtherSessionError(error.message);
    }
    throw new Error("Failed to complete identity provider link request");
  }

  return CompleteLinkedIdentityProviderIntentResponseSchema.parse(
    await response.json(),
  );
}
