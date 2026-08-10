import { ArchestraInternalErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { xaiAdapterFactory } from "./xai";

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
