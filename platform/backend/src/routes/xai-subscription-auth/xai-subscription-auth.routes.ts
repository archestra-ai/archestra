import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { isRateLimited } from "@/agents/utils";
import { CacheKey } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { decodeJwtClaims } from "@/services/openai-codex-credentials";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import {
  xaiOauthEndpoints,
  xaiOauthErrorLogFields,
} from "@/services/xai-subscription-token";
import { ApiError, constructResponseSchema } from "@/types";

const DEVICE_AUTH_START_RATE_LIMIT = {
  windowMs: 10 * 60_000,
  maxRequests: 10,
};

const DEVICE_AUTH_POLL_RATE_LIMIT = {
  windowMs: 60_000,
  maxRequests: 30,
};

/**
 * xAI OAuth device flow for the SuperGrok subscription (RFC 8628),
 * proxied through the backend.
 *
 * A loopback (localhost) redirect — what a desktop CLI would use — can't work for
 * a hosted, custom-domain deployment, so the device flow is used instead: `start`
 * requests a device/user code pair, the user approves at accounts.x.ai, and
 * `poll` is called by the frontend until xAI returns the tokens. This is the same
 * shape as the GitHub/Microsoft Copilot and ChatGPT/Codex device flows already in
 * this repo.
 *
 * xAI implements RFC 8628 to the letter — form-encoded bodies, `authorization_
 * pending`/`slow_down` in the error field, the standard device_code grant — so
 * unlike the ChatGPT/Codex routes this file carries no vendor workarounds. The
 * endpoints come from the issuer's OIDC discovery document rather than being
 * hardcoded (see services/xai-subscription-token).
 *
 * The flow only obtains the user's OAuth credential (the refresh token, encoded).
 * The frontend then creates the provider key through the standard
 * CreateLlmProviderApiKey endpoint (an `xai` key whose secret is that encoded
 * credential), so this flow adds no second key-creation path.
 */
const xaiSubscriptionAuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    "/api/xai-subscription-auth/device/start",
    {
      schema: {
        operationId: RouteId.XaiSubscriptionDeviceAuthStart,
        description:
          "Start the xAI OAuth device flow used to connect a SuperGrok subscription as a provider credential",
        tags: ["xAI Subscription Auth"],
        response: constructResponseSchema(DeviceStartResponseSchema),
      },
    },
    async ({ user }) => {
      // Both endpoints relay traffic to xAI; cap per user so a misbehaving
      // client can't drive xAI rate-limit pressure through the backend.
      if (
        await isRateLimited(
          `${CacheKey.XaiSubscriptionDeviceAuthRateLimit}-start-${user.id}`,
          DEVICE_AUTH_START_RATE_LIMIT,
        )
      ) {
        throw new ApiError(
          429,
          "Too many SuperGrok sign-in attempts — try again later",
        );
      }

      const { clientId, scopes } = config.llm.xai.subscription;
      const { deviceAuthorizationEndpoint } = await xaiOauthEndpoints();

      const response = await fetch(deviceAuthorizationEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ client_id: clientId, scope: scopes }),
        redirect: "manual",
      });
      if (!response.ok) {
        const body = await response.text();
        logger.error(
          { status: response.status, ...xaiOauthErrorLogFields(body) },
          "[XaiSubscriptionAuth] device code request failed",
        );
        throw new ApiError(502, "xAI did not accept the device code request");
      }

      const parsed = DeviceCodePayloadSchema.safeParse(await response.json());
      if (!parsed.success) {
        logger.error(
          {
            issues: parsed.error.issues.map(
              (i) => i.path.join(".") || "(root)",
            ),
          },
          "[XaiSubscriptionAuth] unexpected device code payload shape",
        );
        throw new ApiError(
          502,
          "xAI returned an unexpected device code payload",
        );
      }
      const payload = parsed.data;
      const verificationUri = validateVerificationUri(
        payload.verification_uri_complete ?? payload.verification_uri,
      );

      return {
        deviceCode: payload.device_code,
        userCode: payload.user_code,
        // `verification_uri_complete` embeds the user code, so approving is a
        // single click; the plain URI (where the code is typed) is the fallback.
        verificationUri,
        interval: payload.interval ?? 5,
        expiresIn: payload.expires_in ?? 900,
      };
    },
  );

  fastify.post(
    "/api/xai-subscription-auth/device/poll",
    {
      schema: {
        operationId: RouteId.XaiSubscriptionDeviceAuthPoll,
        description:
          "Poll the xAI OAuth device flow once; returns the encoded provider credential when the user has authorized",
        tags: ["xAI Subscription Auth"],
        body: z.object({
          deviceCode: z.string().min(1),
        }),
        response: constructResponseSchema(DevicePollResponseSchema),
      },
    },
    async ({ body, user }) => {
      // The frontend polls at xAI's requested interval (>= 5s); this cap only
      // trips on clients ignoring interval/slow_down.
      if (
        await isRateLimited(
          `${CacheKey.XaiSubscriptionDeviceAuthRateLimit}-poll-${user.id}`,
          DEVICE_AUTH_POLL_RATE_LIMIT,
        )
      ) {
        throw new ApiError(
          429,
          "Polling too fast — honor the device-flow interval",
        );
      }

      const { clientId } = config.llm.xai.subscription;
      const { tokenEndpoint } = await xaiOauthEndpoints();

      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: body.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        redirect: "manual",
      });

      // RFC 8628 reports flow states (authorization_pending, …) as HTTP 400 with
      // the error name in the body, so parse the body before judging status.
      let payload: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        error?: string;
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        logger.error(
          { status: response.status },
          "[XaiSubscriptionAuth] device token poll returned a non-JSON body",
        );
        throw new ApiError(502, "xAI did not accept the device token poll");
      }

      if (payload.access_token) {
        if (!payload.refresh_token) {
          // offline_access missing from the granted scopes: without a refresh
          // token the key would die with the first access token.
          logger.error(
            "[XaiSubscriptionAuth] token response has no refresh_token — check that offline_access is among ARCHESTRA_XAI_SUBSCRIPTION_SCOPES",
          );
          throw new ApiError(
            502,
            "SuperGrok sign-in returned no refresh token — the offline_access scope must be requested",
          );
        }
        const identityClaims = payload.id_token
          ? decodeJwtClaims(payload.id_token)
          : undefined;
        const userId =
          typeof identityClaims?.sub === "string"
            ? identityClaims.sub.trim()
            : "";
        if (!userId) {
          logger.error(
            "[XaiSubscriptionAuth] token response has no usable id_token subject",
          );
          throw new ApiError(
            502,
            "SuperGrok sign-in returned no account identity — reconnect and ensure the openid scope is requested",
          );
        }
        const email =
          typeof identityClaims?.email === "string" && identityClaims.email
            ? identityClaims.email
            : undefined;
        return {
          status: "complete" as const,
          credential: encodeXaiSubscriptionCredential({
            refreshToken: payload.refresh_token,
            userId,
            ...(email ? { email } : {}),
          }),
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
            "The SuperGrok sign-in expired before it was authorized — start again",
          );
        case "access_denied":
          throw new ApiError(400, "SuperGrok sign-in was declined");
        default:
          // Remaining poll errors are user-triggered outcomes of the device
          // flow, not backend faults — log at warn, not error.
          logger.warn(
            { status: response.status, error: payload.error },
            "[XaiSubscriptionAuth] device token poll returned an error",
          );
          throw new ApiError(
            502,
            `SuperGrok sign-in failed${payload.error ? `: ${payload.error}` : ""}`,
          );
      }
    },
  );
};

export default xaiSubscriptionAuthRoutes;

// ===== Internal helpers =====

const DeviceStartResponseSchema = z.object({
  /**
   * Opaque code the frontend round-trips to the poll endpoint. Usable only with
   * this deployment's client id to authorize the caller's own Grok account, never
   * returned to anyone but the authenticated initiator.
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
     * The encoded X Premium credential (refresh token plus account identity),
     * used by the frontend as the `apiKey` of a standard
     * CreateLlmProviderApiKey call against the `xai` provider. Redeemed for
     * short-lived access tokens at request time.
     */
    credential: z.string(),
  }),
]);

/**
 * The fields Archestra reads from xAI's device-authorization response
 * (RFC 8628 §3.2); extra fields pass through unvalidated.
 */
const DeviceCodePayloadSchema = z.looseObject({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  interval: z.number().optional(),
  expires_in: z.number().optional(),
});

/**
 * The frontend opens this value in a new tab, so treat it as a redirect target
 * rather than inert OAuth metadata. Pin it to the configured HTTPS origin
 * (`accounts.x.ai` by default) and reject credentials/fragments as ambiguity on
 * an authorization page.
 */
function validateVerificationUri(value: string): string {
  let verificationUrl: URL;
  let allowedOrigin: URL;
  try {
    verificationUrl = new URL(value);
    allowedOrigin = new URL(config.llm.xai.subscription.verificationOrigin);
  } catch {
    throw new ApiError(
      502,
      "The xAI sign-in service returned an unusable verification URL",
    );
  }

  if (
    verificationUrl.protocol !== "https:" ||
    allowedOrigin.protocol !== "https:" ||
    verificationUrl.origin !== allowedOrigin.origin ||
    verificationUrl.username ||
    verificationUrl.password ||
    verificationUrl.hash
  ) {
    logger.error(
      {
        verificationOrigin: verificationUrl.origin,
        expectedOrigin: allowedOrigin.origin,
      },
      "[XaiSubscriptionAuth] refusing an untrusted device verification URL",
    );
    throw new ApiError(
      502,
      "The xAI sign-in service returned an untrusted verification URL",
    );
  }
  return verificationUrl.toString();
}
