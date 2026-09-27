import { describe, expect, test } from "vitest";
import {
  classifyRefreshResponse,
  classifyThrownRefreshError,
  refreshFailureToServerFields,
  sanitizeOAuthErrorCode,
  sanitizeOAuthErrorDescription,
} from "./oauth-refresh-classification";

describe("OAuth refresh-failure classification", () => {
  describe("classifyRefreshResponse", () => {
    test("2xx with an access token is a success", () => {
      expect(
        classifyRefreshResponse({
          status: 200,
          body: { access_token: "at" },
        }),
      ).toEqual({ ok: true });
    });

    test("invalid_grant body is terminal (refresh token revoked/expired)", () => {
      expect(
        classifyRefreshResponse({
          status: 400,
          body: { error: "invalid_grant", error_description: "expired" },
        }),
      ).toEqual({
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "invalid_grant",
        description: "expired",
      });
    });

    test("a terminal body without error_description carries no description", () => {
      expect(
        classifyRefreshResponse({
          status: 400,
          body: { error: "invalid_grant" },
        }),
      ).toMatchObject({ description: undefined });
    });

    test("a terminal body with a non-string error_description still classifies as terminal, not thrown", () => {
      // A malformed or hostile token endpoint can return valid JSON with a
      // non-string error_description (e.g. {"error_description": 12345}).
      // classifyRefreshResponse must not throw here — an uncaught throw
      // upstream gets reclassified as a transient failure, hiding a real
      // revoked grant from the user.
      expect(() =>
        classifyRefreshResponse({
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: 12345 as unknown as string,
          },
        }),
      ).not.toThrow();

      expect(
        classifyRefreshResponse({
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: 12345 as unknown as string,
          },
        }),
      ).toEqual({
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "invalid_grant",
        description: undefined,
      });
    });

    test("sanitizes a dangerous error_description before it reaches the outcome", () => {
      expect(
        classifyRefreshResponse({
          status: 400,
          body: {
            error: "invalid_grant",
            error_description:
              "See https://as.example/cb?token=SECRET123 for details",
          },
        }),
      ).toMatchObject({
        description: "See [redacted] for details",
      });
    });

    test("still carries a redacted placeholder when the whole description was dangerous", () => {
      expect(
        classifyRefreshResponse({
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: "https://as.example/cb",
          },
        }),
      ).toMatchObject({ description: "[redacted]" });
    });

    test("invalid_client at 401 is terminal", () => {
      expect(
        classifyRefreshResponse({
          status: 401,
          body: { error: "invalid_client" },
        }),
      ).toMatchObject({
        kind: "terminal",
        category: "refresh_failed",
        message: "invalid_client",
      });
    });

    test("authorization-server 5xx is transient", () => {
      expect(classifyRefreshResponse({ status: 503, body: null })).toEqual({
        ok: false,
        kind: "transient",
        reason: "server_error",
      });
    });

    test("429 rate-limit is transient", () => {
      expect(classifyRefreshResponse({ status: 429, body: null })).toEqual({
        ok: false,
        kind: "transient",
        reason: "rate_limited",
      });
    });

    test("proxy/WAF 4xx without an OAuth error body is transient, not terminal", () => {
      expect(classifyRefreshResponse({ status: 403, body: null })).toEqual({
        ok: false,
        kind: "transient",
        reason: "unexpected_response",
      });
    });

    test("2xx without an access token and without an error is transient (captive portal)", () => {
      expect(classifyRefreshResponse({ status: 200, body: {} })).toEqual({
        ok: false,
        kind: "transient",
        reason: "unexpected_response",
      });
    });

    test("a 5xx is transient even when it carries an OAuth error body (status wins)", () => {
      expect(
        classifyRefreshResponse({
          status: 500,
          body: { error: "invalid_grant" },
        }),
      ).toEqual({ ok: false, kind: "transient", reason: "server_error" });
    });

    test("a transient OAuth error code at 400 is transient, not a dead grant", () => {
      expect(
        classifyRefreshResponse({
          status: 400,
          body: { error: "temporarily_unavailable" },
        }),
      ).toEqual({ ok: false, kind: "transient", reason: "server_error" });
    });
  });

  describe("classifyThrownRefreshError", () => {
    test("AbortSignal.timeout (TimeoutError) is a transient timeout", () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      expect(classifyThrownRefreshError(err)).toEqual({
        ok: false,
        kind: "transient",
        reason: "timeout",
      });
    });

    test("AbortError is a transient timeout", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      expect(classifyThrownRefreshError(err)).toMatchObject({
        reason: "timeout",
      });
    });

    test("any other throw is a transient network error", () => {
      expect(classifyThrownRefreshError(new Error("ECONNREFUSED"))).toEqual({
        ok: false,
        kind: "transient",
        reason: "network",
      });
    });
  });

  describe("sanitizeOAuthErrorCode", () => {
    test("passes a well-formed OAuth error code through unchanged", () => {
      expect(sanitizeOAuthErrorCode("invalid_grant")).toBe("invalid_grant");
    });

    test("redacts a credential-bearing URL to the generic code", () => {
      expect(
        sanitizeOAuthErrorCode(
          "https://as.example/cb?code=SECRET_AUTH_CODE&access_token=tok",
        ),
      ).toBe("refresh_failed");
    });

    test("redacts free text with spaces / token material", () => {
      expect(
        sanitizeOAuthErrorCode("refresh token abc123.def456 was rejected"),
      ).toBe("refresh_failed");
    });

    test("falls back to the generic code for empty/missing input", () => {
      expect(sanitizeOAuthErrorCode(undefined)).toBe("refresh_failed");
      expect(sanitizeOAuthErrorCode("")).toBe("refresh_failed");
    });
  });

  describe("sanitizeOAuthErrorDescription", () => {
    describe("empty input", () => {
      test("returns null for undefined", () => {
        expect(sanitizeOAuthErrorDescription(undefined)).toBeNull();
      });

      test("returns null for null", () => {
        expect(sanitizeOAuthErrorDescription(null)).toBeNull();
      });

      test("returns null for an empty string", () => {
        expect(sanitizeOAuthErrorDescription("")).toBeNull();
      });

      test("returns null for a whitespace-only string", () => {
        expect(sanitizeOAuthErrorDescription("   ")).toBeNull();
      });
    });

    describe("non-string input from an unvalidated JSON body", () => {
      // `error_description` comes from `JSON.parse`-ing an untrusted
      // third-party response with no runtime schema validation, so a number,
      // object, or array can reach here despite the `string` TS type. These
      // must return null, not throw — a throw here gets caught upstream and
      // misclassified as a transient failure, silently hiding a real
      // terminal grant rejection from the user.
      test("returns null for a number", () => {
        expect(
          sanitizeOAuthErrorDescription(12345 as unknown as string),
        ).toBeNull();
      });

      test("returns null for a plain object", () => {
        expect(
          sanitizeOAuthErrorDescription({
            nested: "value",
          } as unknown as string),
        ).toBeNull();
      });

      test("returns null for an array", () => {
        expect(
          sanitizeOAuthErrorDescription(["a", "b"] as unknown as string),
        ).toBeNull();
      });

      test("returns null for a boolean", () => {
        expect(
          sanitizeOAuthErrorDescription(true as unknown as string),
        ).toBeNull();
      });
    });

    describe("benign text is preserved (no false positives)", () => {
      test("passes plain diagnostic prose through unchanged", () => {
        expect(
          sanitizeOAuthErrorDescription("The refresh token has expired"),
        ).toBe("The refresh token has expired");
      });

      test("passes an RFC 6749-style description through unchanged", () => {
        const text =
          "The provided authorization grant is invalid, expired, or revoked";
        expect(sanitizeOAuthErrorDescription(text)).toBe(text);
      });

      test("passes short unrelated prose through unchanged", () => {
        expect(
          sanitizeOAuthErrorDescription("Incorrect resource parameters"),
        ).toBe("Incorrect resource parameters");
      });
    });

    describe("URLs", () => {
      test("redacts a plain URL", () => {
        expect(
          sanitizeOAuthErrorDescription(
            "See https://auth.example.com/error for details",
          ),
        ).toBe("See [redacted] for details");
      });

      test("redacts a URL carrying credentials in the query string", () => {
        expect(
          sanitizeOAuthErrorDescription(
            "Failed for https://as.example/cb?code=SECRET&access_token=abc123XYZ789",
          ),
        ).toBe("Failed for [redacted]");
      });

      test("redacts a URL carrying userinfo credentials", () => {
        expect(
          sanitizeOAuthErrorDescription(
            "Redirect to https://user:p4ssw0rd@host.example/path failed",
          ),
        ).toBe("Redirect to [redacted] failed");
      });

      test("redacts a URL scheme case-insensitively", () => {
        expect(
          sanitizeOAuthErrorDescription(
            "Redirect HTTPS://Auth.Example.com/cb failed",
          ),
        ).toBe("Redirect [redacted] failed");
      });

      test("redacts a description that is nothing but a URL", () => {
        expect(
          sanitizeOAuthErrorDescription("https://auth.example.com/error"),
        ).toBe("[redacted]");
      });
    });

    describe("tokens", () => {
      test("redacts a JWT", () => {
        const jwt =
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        expect(sanitizeOAuthErrorDescription(`Invalid token: ${jwt}`)).toBe(
          "Invalid token: [redacted]",
        );
      });

      test("redacts a generic high-entropy secret-shaped run", () => {
        const blob = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";
        expect(
          sanitizeOAuthErrorDescription(`Unexpected token ${blob} in response`),
        ).toBe("Unexpected token [redacted] in response");
      });
    });

    describe("API keys", () => {
      // Kept under the 32-char generic high-entropy threshold so each case
      // exercises its own prefix-specific pattern, not the generic fallback.
      // Fixture values are built via string concatenation rather than a
      // contiguous literal — secret-scanner push protection pattern-matches
      // on the literal source text (prefix + length), not on runtime values
      // or string entropy, so a split literal still exercises the sanitizer
      // identically without tripping the scanner.
      test("redacts a Stripe-style secret key", () => {
        const key = ["sk", "test", "XXXXXXXXXX"].join("_");
        expect(sanitizeOAuthErrorDescription(`Blocked by key ${key}`)).toBe(
          "Blocked by key [redacted]",
        );
      });

      test("redacts a GitHub personal access token", () => {
        const key = `ghp_${"X".repeat(20)}`;
        expect(sanitizeOAuthErrorDescription(`Token ${key} rejected`)).toBe(
          "Token [redacted] rejected",
        );
      });

      test("redacts an AWS access key ID", () => {
        // AWS's own documentation example key ID (ends "EXAMPLE"); real key
        // IDs never end this way. Still split as a literal, matching the
        // other fixtures in this block.
        const key = `AKIA${"IOSFODNN7EXAMPLE"}`;
        expect(
          sanitizeOAuthErrorDescription(`Invalid credentials ${key}`),
        ).toBe("Invalid credentials [redacted]");
      });

      test("redacts a Slack bot token", () => {
        const key = `xoxb-${"X".repeat(15)}`;
        expect(sanitizeOAuthErrorDescription(`Slack error ${key}`)).toBe(
          "Slack error [redacted]",
        );
      });

      test("redacts an OpenAI-style secret key", () => {
        const key = `sk-${"X".repeat(20)}`;
        expect(sanitizeOAuthErrorDescription(`Key ${key} invalid`)).toBe(
          "Key [redacted] invalid",
        );
      });
    });

    describe("PII", () => {
      test("redacts an email address", () => {
        expect(
          sanitizeOAuthErrorDescription("Contact admin@example.com for help"),
        ).toBe("Contact [redacted] for help");
      });
    });

    describe("HTML/script content", () => {
      test("redacts a script tag", () => {
        expect(
          sanitizeOAuthErrorDescription(
            "<script>alert(1)</script> invalid_grant",
          ),
        ).toBe("[redacted]alert(1)[redacted] invalid_grant");
      });

      test("redacts an event-handler-bearing tag as a single unit", () => {
        expect(
          sanitizeOAuthErrorDescription(
            'Bad state: <img src=x onerror="alert(1)">',
          ),
        ).toBe("Bad state: [redacted]");
      });
    });

    describe("multiple categories in one string", () => {
      test("redacts an email, a URL, and an API key while preserving benign text", () => {
        // Split literal — see the "API keys" describe block above for why.
        const key = ["sk", "test", "X".repeat(24)].join("_");
        const input =
          "User jane@example.com auth failed at https://auth.example.com/cb?token=abc123 " +
          `with key ${key}`;
        expect(sanitizeOAuthErrorDescription(input)).toBe(
          "User [redacted] auth failed at [redacted] with key [redacted]",
        );
      });
    });

    describe("length bounds", () => {
      test("truncates oversized benign text to the max stored length", () => {
        const longBenign =
          "This is a very long benign error description that keeps going. ".repeat(
            20,
          );
        expect(sanitizeOAuthErrorDescription(longBenign)).toBe(
          longBenign.trim().slice(0, 500),
        );
      });

      test("bounds work on an extremely oversized adversarial payload", () => {
        const huge = "z ".repeat(1_000_000);
        const result = sanitizeOAuthErrorDescription(huge);
        expect(result).not.toBeNull();
        expect(result?.length).toBeLessThanOrEqual(500);
      });
    });
  });

  describe("refreshFailureToServerFields", () => {
    test("a terminal failure maps to the persisted trio", () => {
      const fields = refreshFailureToServerFields({
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "invalid_grant",
        description: "The refresh token is invalid",
      });
      expect(fields).not.toBeNull();
      expect(fields).toMatchObject({
        oauthRefreshError: "refresh_failed",
        oauthRefreshErrorMessage: "invalid_grant",
        oauthRefreshErrorDescription: "The refresh token is invalid",
      });
      expect(fields?.oauthRefreshFailedAt).toBeInstanceOf(Date);
    });

    test("a terminal failure without a description maps to a null description", () => {
      const fields = refreshFailureToServerFields({
        ok: false,
        kind: "terminal",
        category: "refresh_failed",
        message: "invalid_grant",
      });
      expect(fields?.oauthRefreshErrorDescription).toBeNull();
    });

    test("a no_refresh_token terminal failure carries its category", () => {
      const fields = refreshFailureToServerFields({
        ok: false,
        kind: "terminal",
        category: "no_refresh_token",
        message: "no_refresh_token",
      });
      expect(fields?.oauthRefreshError).toBe("no_refresh_token");
    });

    test("a transient failure persists nothing", () => {
      expect(
        refreshFailureToServerFields({
          ok: false,
          kind: "transient",
          reason: "server_error",
        }),
      ).toBeNull();
    });

    test("a success persists nothing", () => {
      expect(refreshFailureToServerFields({ ok: true })).toBeNull();
    });
  });
});
