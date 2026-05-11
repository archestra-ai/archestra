import { z } from "zod";

export const LINKED_IDP_SSO_MODE = "linked-idp";

export const LINKED_IDP_AUTH_INTENT_PATH = "/linked-idp/intent";
export const LINKED_IDP_AUTH_COMPLETE_PATH = "/linked-idp/complete";
export const LINKED_IDP_AUTH_INTENT_ENDPOINT = `/api/auth${LINKED_IDP_AUTH_INTENT_PATH}`;
export const LINKED_IDP_AUTH_COMPLETE_ENDPOINT = `/api/auth${LINKED_IDP_AUTH_COMPLETE_PATH}`;

export const CreateLinkedIdentityProviderIntentRequestSchema = z.object({
  providerId: z.string().min(1),
  redirectTo: z.string().default("/chat"),
});

export const CreateLinkedIdentityProviderIntentResponseSchema = z.object({
  intentId: z.string(),
  redirectTo: z.string(),
});

export const CompleteLinkedIdentityProviderIntentRequestSchema = z.object({
  intentId: z.string().min(1),
});

export const CompleteLinkedIdentityProviderIntentResponseSchema = z.object({
  redirectTo: z.string(),
});

export type CreateLinkedIdentityProviderIntentRequest = z.infer<
  typeof CreateLinkedIdentityProviderIntentRequestSchema
>;
export type CreateLinkedIdentityProviderIntentResponse = z.infer<
  typeof CreateLinkedIdentityProviderIntentResponseSchema
>;
export type CompleteLinkedIdentityProviderIntentRequest = z.infer<
  typeof CompleteLinkedIdentityProviderIntentRequestSchema
>;
export type CompleteLinkedIdentityProviderIntentResponse = z.infer<
  typeof CompleteLinkedIdentityProviderIntentResponseSchema
>;
