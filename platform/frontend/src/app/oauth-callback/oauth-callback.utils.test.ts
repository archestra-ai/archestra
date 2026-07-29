import {
  buildOAuthCallbackPayload,
  extractOAuthCallbackParams,
  getOAuthCallbackErrorState,
  toInternalReturnPath,
} from "./oauth-callback.utils";

describe("toInternalReturnPath", () => {
  const origin = "https://app.example.com";

  test("returns path, query, and hash for a same-origin URL", () => {
    expect(
      toInternalReturnPath(
        "https://app.example.com/agents/123?tab=tools#section",
        origin,
      ),
    ).toBe("/agents/123?tab=tools#section");
  });

  test("resolves a relative path against the origin", () => {
    expect(toInternalReturnPath("/mcp/registry?x=1", origin)).toBe(
      "/mcp/registry?x=1",
    );
  });

  test("returns null for a cross-origin URL", () => {
    expect(
      toInternalReturnPath("https://evil.example.com/agents", origin),
    ).toBe(null);
  });

  test("returns null for javascript: URLs", () => {
    expect(toInternalReturnPath("javascript:alert(1)", origin)).toBe(null);
  });

  test("returns null when no return URL is stored", () => {
    expect(toInternalReturnPath(null, origin)).toBe(null);
  });
});

describe("getOAuthCallbackErrorState", () => {
  test("returns null when code and state are present", () => {
    expect(
      getOAuthCallbackErrorState({
        code: "auth-code",
        error: null,
        errorDescription: null,
        state: "oauth-state",
      }),
    ).toBeNull();
  });

  test("prefers provider error description when present", () => {
    expect(
      getOAuthCallbackErrorState({
        code: null,
        error: "invalid_scope",
        errorDescription:
          "The scope used in the request ['read write'] is not valid for client scope ['READ']",
        state: "oauth-state",
      }),
    ).toEqual({
      title: "OAuth Authentication Failed",
      description:
        "The scope used in the request ['read write'] is not valid for client scope ['READ']",
    });
  });

  test("handles missing code without provider error", () => {
    expect(
      getOAuthCallbackErrorState({
        code: null,
        error: null,
        errorDescription: null,
        state: "oauth-state",
      }),
    ).toEqual({
      title: "Missing Authorization Code",
      description:
        "The OAuth provider redirected back without an authorization code. Check the provider configuration and try again.",
    });
  });

  test("handles missing state without provider error", () => {
    expect(
      getOAuthCallbackErrorState({
        code: "auth-code",
        error: null,
        errorDescription: null,
        state: null,
      }),
    ).toEqual({
      title: "Missing OAuth State",
      description:
        "The OAuth provider redirected back without a state value. Start the installation again and retry the sign-in flow.",
    });
  });
});

describe("extractOAuthCallbackParams", () => {
  it("reads every parameter the callback consumes, including iss", () => {
    // Regression: iss was sent by RFC 9207 servers, accepted by the backend,
    // and dropped here. Before the fix this extraction did not read it, so
    // this assertion is the one that would have failed.
    const params = new URLSearchParams({
      code: "auth-code",
      state: "state-1",
      iss: "https://login.example.com",
    });

    expect(extractOAuthCallbackParams(params)).toEqual({
      code: "auth-code",
      error: null,
      errorDescription: null,
      state: "state-1",
      iss: "https://login.example.com",
    });
  });

  it("reports absent parameters as null rather than omitting them", () => {
    const params = extractOAuthCallbackParams(new URLSearchParams());

    expect(params.iss).toBeNull();
    expect(params.code).toBeNull();
  });
});

describe("buildOAuthCallbackPayload", () => {
  it("carries iss to the token exchange when the server sent one", () => {
    expect(
      buildOAuthCallbackPayload({
        code: "auth-code",
        state: "state-1",
        iss: "https://login.example.com",
      }),
    ).toEqual({
      code: "auth-code",
      state: "state-1",
      iss: "https://login.example.com",
    });
  });

  it("omits iss entirely when the server sent none", () => {
    // Absent, not null: the backend schema takes an optional string, and the
    // RFC 9207 decision table distinguishes absent from present.
    const payload = buildOAuthCallbackPayload({
      code: "auth-code",
      state: "state-1",
      iss: null,
    });

    expect(payload).toEqual({ code: "auth-code", state: "state-1" });
    expect("iss" in payload).toBe(false);
  });
});
