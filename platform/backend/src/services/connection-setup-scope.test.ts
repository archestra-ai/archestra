import { expect, test } from "vitest";
import { issueConnectionSetupContext } from "./connection-setup-context";
import {
  nativeSetupClientFromProvenance,
  resolveConnectionSetupScope,
} from "./connection-setup-scope";

const userId = "user-1";
const organizationId = "org-1";
const principal = {
  userId,
  organizationId,
  targetOrganizationId: organizationId,
  guardrailsActive: true,
};

test("maps native client provenance, and nothing else, to a client", () => {
  expect(nativeSetupClientFromProvenance("claude-code-header")).toBe(
    "claude-code",
  );
  expect(nativeSetupClientFromProvenance("codex-turn-metadata")).toBe("codex");
  for (const provenance of [
    "claude-metadata",
    "prompt-cache-key",
    "appa-header",
  ] as const) {
    expect(nativeSetupClientFromProvenance(provenance)).toBeUndefined();
  }
});

test("approved installer scope is bound to authenticated user, org, and gateway", async () => {
  const secret = "a-shared-signing-key-for-setup";
  const gatewayId = "gateway-1";
  const evidence = {
    kind: "approved-installer" as const,
    token: issueConnectionSetupContext({
      userId,
      organizationId,
      gatewayId,
      setupId: "approved-setup-1",
      secret,
    }),
    gatewayId,
    signingSecret: secret,
  };
  expect(await resolveConnectionSetupScope({ principal, evidence })).toEqual({
    kind: "approved-installer",
    userId,
    organizationId,
    gatewayId,
  });
  expect(
    await resolveConnectionSetupScope({
      principal: { ...principal, userId: "other-user" },
      evidence,
    }),
  ).toBeNull();
  expect(
    await resolveConnectionSetupScope({
      principal,
      evidence: { ...evidence, gatewayId: "other-gateway" },
    }),
  ).toBeNull();
  expect(
    await resolveConnectionSetupScope({
      principal: { ...principal, guardrailsActive: false },
      evidence,
    }),
  ).toBeNull();
});
