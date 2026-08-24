import { expect, test } from "@/test";
import { createCapturingLogger } from "./log-capture";

test("redacts credential fields in captured logs", () => {
  const { logger, getLogOutput } = createCapturingLogger();
  logger.level = "info";
  const credential = "credential-that-must-not-be-captured";
  const error = new Error("upstream request failed") as Error & {
    headers: Record<string, string>;
    config: Record<string, string>;
  };
  error.headers = { authorization: credential };
  error.config = { apiKey: credential };

  logger.error({ authorization: credential, error }, "connector sync failed");

  const output = getLogOutput();
  expect(output).toContain("[Redacted]");
  expect(output).toContain("upstream request failed");
  expect(output).not.toContain(credential);
});
