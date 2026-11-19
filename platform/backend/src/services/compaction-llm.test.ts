import { afterEach, describe, expect, test } from "vitest";
import config, { parseOpenAppaConfig } from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { compactionTranscriptToolOutput } from "./compaction-llm";

describe("compactionTranscriptToolOutput", () => {
  const openappa = config.openappa;
  afterEach(() => {
    config.openappa = openappa;
  });

  test.for([
    { enabled: true, expected: "withheld" },
    { enabled: false, expected: "included" },
  ])("is $expected when the OpenAPPA switch is enabled=$enabled", async ({
    enabled,
    expected,
  }) => {
    config.openappa = parseOpenAppaConfig();
    await GuardrailsDeploymentModel.setEnabled(enabled);

    expect(await compactionTranscriptToolOutput()).toBe(expected);
  });
});
