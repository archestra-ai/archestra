export const LINKED_IDP_SSO_MODE = "linked-idp";

export async function createLinkedIdentityProviderIntent(params: {
  providerId: string;
  redirectTo: string;
}) {
  const response = await fetch("/api/auth/linked-idp/intent", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error("Failed to create identity provider link request");
  }

  return (await response.json()) as {
    intentId: string;
    redirectTo: string;
  };
}

export async function completeLinkedIdentityProviderIntent(intentId: string) {
  const response = await fetch("/api/auth/linked-idp/complete", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intentId }),
  });

  if (!response.ok) {
    throw new Error("Failed to complete identity provider link request");
  }

  return (await response.json()) as {
    redirectTo: string;
  };
}
