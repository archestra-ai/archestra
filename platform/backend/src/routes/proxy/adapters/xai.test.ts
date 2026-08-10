import {
  ArchestraInternalErrorCode,
  SUBSCRIPTION_CREDENTIALS,
} from "@archestra/shared";
import { describe, expect, test } from "@/test";
import type { ApiError } from "@/types";
import { xaiAdapterFactory } from "./xai";

describe("createClient", () => {
  test("fails closed on a marker-prefixed credential that does not decode", () => {
    // The value classifies as subscription for billing, so letting it fall
    // through to the plain-key branch would send it as a raw bearer to a
    // possibly user-supplied base URL.
    const corrupted = `${SUBSCRIPTION_CREDENTIALS["x-premium"].marker}not-base64-json`;
    let thrown: unknown;
    try {
      xaiAdapterFactory.createClient(corrupted, {
        baseUrl: "https://api.x.ai/v1",
        source: "chat",
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ApiError).statusCode).toBe(401);
    expect((thrown as ApiError).internalCode).toBe(
      ArchestraInternalErrorCode.ProviderAuthRequired,
    );
  });

  test("still builds a plain client for a console key", () => {
    expect(() =>
      xaiAdapterFactory.createClient("xai-console-key", {
        baseUrl: "https://api.x.ai/v1",
        source: "chat",
      }),
    ).not.toThrow();
  });
});

describe("extractInternalCode", () => {
  test("classifies the structured context_length_exceeded code", () => {
    const error = { error: { code: "context_length_exceeded" } };
    expect(xaiAdapterFactory.extractInternalCode(error)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });

  test("relays provider_auth_required from the subscription fetch wrapper", () => {
    // Shape of the synthetic 401 the X Premium fetch wrapper returns when the
    // refresh token is rejected (redemptionErrorResponse in
    // services/xai-subscription-token.ts).
    const error = {
      status: 401,
      error: {
        message:
          "Your X Premium (SuperGrok) sign-in has expired or been revoked. Reconnect your X account to continue.",
        type: "authentication_error",
        internal_code: ArchestraInternalErrorCode.ProviderAuthRequired,
      },
    };
    expect(xaiAdapterFactory.extractInternalCode(error)).toBe(
      ArchestraInternalErrorCode.ProviderAuthRequired,
    );
  });

  test("leaves an ordinary 401 without the normalized code unclassified", () => {
    const error = {
      status: 401,
      error: {
        message: "Incorrect API key provided",
        type: "invalid_request_error",
      },
    };
    expect(xaiAdapterFactory.extractInternalCode(error)).toBeUndefined();
  });

  test("leaves an unrelated error unclassified", () => {
    const error = { error: { message: "invalid model specified" } };
    expect(xaiAdapterFactory.extractInternalCode(error)).toBeUndefined();
  });
});
