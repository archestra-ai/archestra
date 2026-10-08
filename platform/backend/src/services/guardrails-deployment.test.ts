import { describe, expect, test } from "vitest";
import config from "@/config";
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
});
