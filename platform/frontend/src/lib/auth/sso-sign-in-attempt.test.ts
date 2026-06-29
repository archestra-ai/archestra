import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSsoSignInAttempt,
  clearSsoSignInRedirectPath,
  getSsoSignInRedirectPath,
  hasSsoSignInAttempt,
  recordSsoSignInAttempt,
} from "./sso-sign-in-attempt";

describe("sso-sign-in-attempt", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores and clears SSO sign-in state with the intended redirect path", () => {
    recordSsoSignInAttempt("/chat/conv_123");

    expect(hasSsoSignInAttempt()).toBe(true);
    expect(getSsoSignInRedirectPath()).toBe("/chat/conv_123");

    clearSsoSignInAttempt();

    expect(hasSsoSignInAttempt()).toBe(false);
    expect(getSsoSignInRedirectPath()).toBeNull();
  });

  it("can clear only the redirect path after the fallback consumes it", () => {
    recordSsoSignInAttempt("/chat/conv_123");

    clearSsoSignInRedirectPath();

    expect(hasSsoSignInAttempt()).toBe(true);
    expect(getSsoSignInRedirectPath()).toBeNull();
  });
});
