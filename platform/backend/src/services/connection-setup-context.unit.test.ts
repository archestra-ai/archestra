import { afterEach, expect, test, vi } from "vitest";
import {
  issueConnectionSetupContext,
  verifyConnectionSetupContext,
} from "./connection-setup-context";

const identity = {
  userId: "user-1",
  organizationId: "org-1",
  gatewayId: "gateway-1",
  setupId: "approved-setup-1",
  secret: "a-shared-signing-key-for-setup",
};

afterEach(() => vi.useRealTimers());

test("the approved setup context is bound to its caller and gateway", () => {
  const token = issueConnectionSetupContext(identity);
  expect(verifyConnectionSetupContext({ ...identity, token })).toBe(true);
  expect(
    verifyConnectionSetupContext({ ...identity, userId: "other-user", token }),
  ).toBe(false);
  expect(
    verifyConnectionSetupContext({
      ...identity,
      organizationId: "other-org",
      token,
    }),
  ).toBe(false);
  expect(
    verifyConnectionSetupContext({
      ...identity,
      gatewayId: "other-gateway",
      token,
    }),
  ).toBe(false);
  expect(
    verifyConnectionSetupContext({ ...identity, secret: "wrong-key", token }),
  ).toBe(false);
});

test("tampering or adding a second signature cannot extend the exemption", () => {
  const token = issueConnectionSetupContext(identity);
  const [payload, signature] = token.slice("cs1_".length).split(".");
  expect(
    verifyConnectionSetupContext({
      ...identity,
      token: `cs1_${payload}A.${signature}`,
    }),
  ).toBe(false);
  expect(
    verifyConnectionSetupContext({
      ...identity,
      token: `${token}.another-part`,
    }),
  ).toBe(false);
  expect(
    verifyConnectionSetupContext({ ...identity, token: `${token}.` }),
  ).toBe(false);
  expect(
    verifyConnectionSetupContext({ ...identity, token: "not-a-setup-context" }),
  ).toBe(false);
});

test("the signed exception expires ten minutes after script redemption", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
  const token = issueConnectionSetupContext(identity);
  vi.setSystemTime(new Date("2026-09-29T12:09:59.999Z"));
  expect(verifyConnectionSetupContext({ ...identity, token })).toBe(true);
  vi.setSystemTime(new Date("2026-09-29T12:10:00.000Z"));
  expect(verifyConnectionSetupContext({ ...identity, token })).toBe(false);
  vi.setSystemTime(new Date("2026-09-29T11:59:59.000Z"));
  expect(verifyConnectionSetupContext({ ...identity, token })).toBe(false);
});

test("a missing signing secret fails closed", () => {
  expect(() =>
    issueConnectionSetupContext({ ...identity, secret: "" }),
  ).toThrow("Connection setup signing key is missing");
  const token = issueConnectionSetupContext(identity);
  expect(verifyConnectionSetupContext({ ...identity, secret: "", token })).toBe(
    false,
  );
});
