import { expect, test } from "vitest";
import {
  issueConnectionInstructionsToken,
  verifyConnectionInstructionsToken,
} from "./connection-instructions-token";

const setupId = "12345678-1234-1234-1234-123456789012";
const secret = "test-instruction-signing-secret";
test("instruction credentials authenticate only the signed installation and signing key", () => {
  const token = issueConnectionInstructionsToken({ setupId, secret });
  expect(verifyConnectionInstructionsToken({ token, secret })).toBe(setupId);
  expect(
    verifyConnectionInstructionsToken({
      token: token.replace(setupId, "22345678-1234-1234-1234-123456789012"),
      secret,
    }),
  ).toBeNull();
  expect(
    verifyConnectionInstructionsToken({ token, secret: "other-secret" }),
  ).toBeNull();
  expect(
    verifyConnectionInstructionsToken({ token: `${token}suffix`, secret }),
  ).toBeNull();
  expect(
    verifyConnectionInstructionsToken({
      token: "archestra_con_setup-ticket",
      secret,
    }),
  ).toBeNull();
  expect(verifyConnectionInstructionsToken({ token, secret: "" })).toBeNull();
});
