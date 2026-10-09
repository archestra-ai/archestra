import { describe, expect, test } from "vitest";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { readGuardrailsV2Activation } from "./guardrails-deployment";

describe("readGuardrailsV2Activation", () => {
  test("a stored false is inactive, and a thrown read is not that result", async () => {
    const previous = config.openappa.enabled;
    config.openappa.enabled = true;
    try {
      await expect(readGuardrailsV2Activation(async () => false)).resolves.toBe(
        "inactive",
      );
      await expect(
        readGuardrailsV2Activation(async () => {
          throw new Error("deployment row unavailable");
        }),
      ).rejects.toThrow("deployment row unavailable");
    } finally {
      config.openappa.enabled = previous;
    }
  });

  test("the persisted row toggles the same predicate between reads", async () => {
    const previous = config.openappa.enabled;
    config.openappa.enabled = true;
    try {
      await GuardrailsDeploymentModel.setEnabled(false);
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
      await GuardrailsDeploymentModel.setEnabled(true);
      await expect(readGuardrailsV2Activation()).resolves.toBe("active");
      config.openappa.enabled = false;
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
    } finally {
      config.openappa.enabled = previous;
    }
  });

  test("enforcement turns off at the small-team threshold unless the AI Security licence is set", async () => {
    const previous = config.openappa.enabled;
    const previousFlags = { ...config.enterpriseFeatures };
    const setFlag = (key: "core" | "aiSecurity", value: boolean) =>
      Object.defineProperty(config.enterpriseFeatures, key, {
        value,
        writable: true,
        configurable: true,
      });
    config.openappa.enabled = true;
    setFlag("core", false);
    setFlag("aiSecurity", false);
    try {
      await GuardrailsDeploymentModel.setEnabled(true);
      enterpriseTier.setUserCountForTesting(29);
      await expect(readGuardrailsV2Activation()).resolves.toBe("active");
      enterpriseTier.setUserCountForTesting(30);
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
      // The Platform licence alone does not include AI Security.
      setFlag("core", true);
      await expect(readGuardrailsV2Activation()).resolves.toBe("inactive");
      setFlag("aiSecurity", true);
      await expect(readGuardrailsV2Activation()).resolves.toBe("active");
    } finally {
      config.openappa.enabled = previous;
      setFlag("core", previousFlags.core);
      setFlag("aiSecurity", previousFlags.aiSecurity);
      enterpriseTier.setUserCountForTesting(0);
    }
  });
});
