import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import {
  entraErrorLogFields,
  MICROSOFT_COPILOT_OAUTH_SCOPES,
} from "@/services/microsoft-copilot-token";
import { ApiError, constructResponseSchema } from "@/types";

/**
 * Entra ID OAuth device flow for Microsoft Copilot (RFC 8628), proxied
 * through the backend because Entra's device endpoints do not allow browser
 * CORS.
 *
 * The flow only obtains the user's Entra refresh token: `start` requests a
 * device/user code pair, the user authorizes at microsoft.com/devicelogin,
 * and `poll` is called by the frontend until Entra returns the tokens. The
 * frontend then creates the provider key through the standard
 * CreateLlmProviderApiKey endpoint (storing the refresh token as the key), so
 * this flow adds no second key-creation path. Returning the token to its
 * owner over the authenticated session is equivalent to a manual MSAL flow.
 *
 * Entra differences from the GitHub device flow that this file encodes:
 * - both endpoints take application/x-www-form-urlencoded bodies;
 * - poll "errors" like authorization_pending arrive as HTTP 400 with the
 *   error name in the JSON body (GitHub returns 200 + error field);
 * - there is no community client id — the operator must register an Entra
 *   public-client app and set ARCHESTRA_MICROSOFT_COPILOT_CLIENT_ID.
 */
const microsoftCopilotAuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/microsoft-copilot-auth/device/start",
    {
      schema: {
        operationId: RouteId.MicrosoftCopilotDeviceAuthStart,
        description:
          "Start the Entra ID device flow used to connect a Microsoft 365 Copilot account",
        tags: ["Microsoft Copilot Auth"],
        response: constructResponseSchema(DeviceStartResponseSchema),
      },
    },
    async ({ user }) => {
      assertClientIdConfigured();

      // Both endpoints relay traffic to Entra; cap per user so a misbehaving
      // client can't drive Microsoft rate-limit pressure through the backend.
      if (
        await isRateLimited(
          `${CacheKey.MicrosoftCopilotDeviceAuthRateLimit}-start-${user.id}`,
          { windowMs: 10 * 60_000, maxRequests: 10 },
        )
      ) {
        throw new ApiError(
          429,
          "Too many Microsoft sign-in attempts — try again later",
        );
      }

      const response = await fetch(`${oauthBaseUrl()}/oauth2/v2.0/devicecode`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.llm["microsoft-copilot"].clientId,
          scope: MICROSOFT_COPILOT_OAUTH_SCOPES,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        logger.error(
          { status: response.status, ...entraErrorLogFields(body) },
          "[MicrosoftCopilotAuth] device code request failed",
        );
        throw new ApiError(
          502,
          "Microsoft did not accept the device code request",
        );
      }

      const parsed = EntraDeviceCodePayloadSchema.safeParse(
        await response.json(),
      );
      if (!parsed.success) {
        throw new ApiError(
          502,
          "Microsoft returned an unexpected device code payload",
        );
      }
      const payload = parsed.data;

      return {
        deviceCode: payload.device_code,
        userCode: payload.user_code,
        verificationUri:
          payload.verification_uri ?? "https://microsoft.com/devicelogin",
        interval: payload.interval ?? 5,
        expiresIn: payload.expires_in ?? 900,
      };
    },
  );

  fastify.post(
    "/api/microsoft-copilot-auth/device/poll",
    {
      schema: {
        operationId: RouteId.MicrosoftCopilotDeviceAuthPoll,
        description:
          "Poll the Entra ID device flow once; returns the refresh token when the user has authorized",
        tags: ["Microsoft Copilot Auth"],
        body: z.object({
          deviceCode: z.string().min(1),
        }),
        response: constructResponseSchema(DevicePollResponseSchema),
      },
    },
    async ({ body, user }) => {
      assertClientIdConfigured();

      // The frontend polls at Entra's requested interval (>= 5s); this cap
      // only trips on clients ignoring interval/slow_down.
      if (
        await isRateLimited(
          `${CacheKey.MicrosoftCopilotDeviceAuthRateLimit}-poll-${user.id}`,
          { windowMs: 60_000, maxRequests: 30 },
        )
      ) {
        throw new ApiError(
          429,
          "Polling too fast — honor the device-flow interval",
        );
      }

      const response = await fetch(`${oauthBaseUrl()}/oauth2/v2.0/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.llm["microsoft-copilot"].clientId,
          device_code: body.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      // Entra reports flow states (authorization_pending, …) as HTTP 400 with
      // the error name in the body, so parse the body before judging status.
      let payload: {
        access_token?: string;
        refresh_token?: string;
        error?: string;
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        logger.error(
          { status: response.status },
          "[MicrosoftCopilotAuth] device token poll returned a non-JSON body",
        );
        throw new ApiError(
          502,
          "Microsoft did not accept the device token poll",
        );
      }

      if (payload.access_token) {
        if (!payload.refresh_token) {
          // offline_access missing from the app registration's consented
          // scopes: without a refresh token the key would die within an hour.
          logger.error(
            "[MicrosoftCopilotAuth] token response has no refresh_token — check that offline_access is consented",
          );
          throw new ApiError(
            502,
            "Microsoft sign-in returned no refresh token — the Entra app registration must include the offline_access scope",
          );
        }
        return {
          status: "complete" as const,
          refreshToken: payload.refresh_token,
        };
      }

      switch (payload.error) {
        case "authorization_pending":
          return { status: "pending" as const };
        case "slow_down":
          return { status: "slow_down" as const };
        case "expired_token":
          throw new ApiError(
            400,
            "The Microsoft sign-in expired before it was authorized — start again",
          );
        case "authorization_declined":
          throw new ApiError(400, "Microsoft sign-in was declined");
        default:
          logger.error(
            { status: response.status, error: payload.error },
            "[MicrosoftCopilotAuth] device token poll returned an error",
          );
          throw new ApiError(
            502,
            `Microsoft sign-in failed${payload.error ? `: ${payload.error}` : ""}`,
          );
      }
    },
  );
};

export default microsoftCopilotAuthRoutes;

// ===== Internal helpers =====

const DeviceStartResponseSchema = z.object({
  /**
   * Opaque code the frontend round-trips to the poll endpoint. Usable only
   * with this deployment's client id to authorize the caller's own Microsoft
   * account, never returned to anyone but the authenticated initiator.
   */
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  /** Seconds the client must wait between polls. */
  interval: z.number(),
  /** Seconds until the device code expires. */
  expiresIn: z.number(),
});

const DevicePollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("slow_down") }),
  z.object({
    status: z.literal("complete"),
    /**
     * The caller's own Entra refresh token, used by the frontend as the
     * `apiKey` of a standard CreateLlmProviderApiKey call. It is redeemed for
     * short-lived Graph access tokens at request time.
     */
    refreshToken: z.string(),
  }),
]);

/**
 * The fields Archestra reads from Entra's device-authorization response
 * (RFC 8628 §3.2); extra fields (message, verification_uri_complete) pass
 * through unvalidated.
 */
const EntraDeviceCodePayloadSchema = z.looseObject({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().optional(),
  interval: z.number().optional(),
  expires_in: z.number().optional(),
});

function assertClientIdConfigured(): void {
  if (!config.llm["microsoft-copilot"].clientId) {
    throw new ApiError(
      400,
      "Microsoft Copilot sign-in is not configured — set ARCHESTRA_MICROSOFT_COPILOT_CLIENT_ID to the Application (client) ID of an Entra app registration with public client flows enabled",
    );
  }
}

function oauthBaseUrl(): string {
  const { authBaseUrl, tenantId } = config.llm["microsoft-copilot"];
  return `${authBaseUrl.replace(/\/+$/, "")}/${tenantId}`;
}
