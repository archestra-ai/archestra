import { describe, expect, test, vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    chatops: { signupWelcomeEnabled: false },
  }),
);

import { shouldSendSignupWelcome } from "./auto-provision";

describe("shouldSendSignupWelcome with ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED=false", () => {
  test("welcome is skipped even without any SSO identity provider", async () => {
    expect(await shouldSendSignupWelcome()).toBe(false);
  });
});
