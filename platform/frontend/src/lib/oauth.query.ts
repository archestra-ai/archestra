import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery } from "@tanstack/react-query";

const {
  initiateOAuth,
  handleOAuthCallback,
  getOAuthClientInfo,
  submitOAuthConsent,
} = archestraApiSdk;

export const oauthKeys = {
  all: ["oauth"] as const,
  clientInfo: (clientId: string) =>
    [...oauthKeys.all, "clientInfo", clientId] as const,
};

export function useInitiateOAuth() {
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.InitiateOAuthData["body"],
    ): Promise<archestraApiTypes.InitiateOAuthResponses["200"]> => {
      const response = await initiateOAuth({ body: data });
      if (response.error || !response.data) {
        const msg =
          response.error && typeof response.error.error === "string"
            ? response.error.error
            : response.error?.error?.message || "Failed to initiate OAuth flow";
        throw new Error(msg);
      }
      return response.data;
    },
  });
}

export function useOAuthClientInfo(clientId: string | null) {
  return useQuery({
    queryKey: oauthKeys.clientInfo(clientId ?? ""),
    queryFn: async () => {
      if (!clientId) return null;
      const response = await getOAuthClientInfo({
        query: { client_id: clientId },
      });
      if (response.error) {
        return null;
      }
      return response.data;
    },
    enabled: !!clientId,
  });
}

export function useHandleOAuthCallback() {
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.HandleOAuthCallbackData["body"],
    ): Promise<archestraApiTypes.HandleOAuthCallbackResponses["200"]> => {
      const response = await handleOAuthCallback({ body: data });
      if (response.error || !response.data) {
        const msg =
          response.error?.error?.message || "Failed to complete OAuth";
        throw new Error(msg);
      }
      return response.data;
    },
  });
}

export function useSubmitOAuthConsent() {
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.SubmitOAuthConsentData["body"],
    ): Promise<archestraApiTypes.SubmitOAuthConsentResponses["200"]> => {
      const response = await submitOAuthConsent({ body: data });
      if (response.error || !response.data) {
        throw new Error("Failed to process consent");
      }
      return response.data;
    },
  });
}
