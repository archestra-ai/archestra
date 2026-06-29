import { getOAuthCallbackErrorState } from "./oauth-callback.utils";

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
