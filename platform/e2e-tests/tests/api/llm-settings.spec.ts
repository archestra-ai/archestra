import { expect, test } from "./fixtures";

test.describe("LLM Settings API", () => {
  // Run serially since tests modify shared organization settings
  test.describe.configure({ mode: "serial" });

  test("should update compression scope to organization", async ({
    request,
    updateLlmSettings,
  }) => {
    const response = await updateLlmSettings(request, {
      compressionScope: "organization",
      convertToolResultsToToon: true,
    });

    const org = await response.json();
    expect(org.compressionScope).toBe("organization");
    expect(org.convertToolResultsToToon).toBe(true);
  });

  test("should update compression scope to team", async ({
    request,
    updateLlmSettings,
  }) => {
    const response = await updateLlmSettings(request, {
      compressionScope: "team",
      convertToolResultsToToon: false,
    });

    const org = await response.json();
    expect(org.compressionScope).toBe("team");
    expect(org.convertToolResultsToToon).toBe(false);
  });

  test("should read back LLM settings after update", async ({
    request,
    makeApiRequest,
    updateLlmSettings,
  }) => {
    // Set to a known state
    await updateLlmSettings(request, {
      compressionScope: "organization",
      convertToolResultsToToon: false,
    });

    // Read back via GET /api/organization
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization",
    });

    const org = await response.json();
    expect(org.compressionScope).toBe("organization");
    expect(org.convertToolResultsToToon).toBe(false);
  });

  test("should update limit cleanup interval", async ({
    request,
    updateLlmSettings,
  }) => {
    const response = await updateLlmSettings(request, {
      limitCleanupInterval: "12h",
    });

    const org = await response.json();
    expect(org.limitCleanupInterval).toBe("12h");
  });

  test("should handle compression scope team and read back correctly", async ({
    request,
    makeApiRequest,
    updateLlmSettings,
  }) => {
    // Save compression scope as "team"
    const updateResponse = await updateLlmSettings(request, {
      compressionScope: "team",
      convertToolResultsToToon: false,
    });

    const updatedOrg = await updateResponse.json();
    expect(updatedOrg.compressionScope).toBe("team");

    // Read back organization settings - should not error
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/organization",
    });
    expect(getResponse.status()).toBe(200);

    const org = await getResponse.json();
    expect(org.compressionScope).toBe("team");
  });

  // Clean up: reset to safe defaults
  test("cleanup: reset LLM settings to defaults", async ({
    request,
    updateLlmSettings,
  }) => {
    await updateLlmSettings(request, {
      compressionScope: "organization",
      convertToolResultsToToon: false,
      limitCleanupInterval: "1h",
    });
  });
});
