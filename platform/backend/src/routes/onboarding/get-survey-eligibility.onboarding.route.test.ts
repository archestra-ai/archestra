import config from "@/config";
import {
  InteractionModel,
  McpToolCallModel,
  OrganizationModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/onboarding/survey-eligibility", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    // Analytics defaults off outside production, and the survey respects the
    // opt-out; enable it so eligibility is testable. Restored automatically.
    config.analytics.enabled = true;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: onboardingRoutes } = await import("./onboarding.routes");
    await app.register(onboardingRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function getEligibility() {
    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/survey-eligibility",
    });
    expect(response.statusCode).toBe(200);
    return response.json().eligible as boolean;
  }

  test("eligible on a pristine unlicensed instance", async () => {
    expect(await getEligibility()).toBe(true);
  });

  test("ineligible when the enterprise license env flag is set", async () => {
    // Restored automatically after the test by the shared setup.
    config.enterpriseFeatures.core = true;
    expect(await getEligibility()).toBe(false);
  });

  test("ineligible when analytics is disabled (phone-home opt-out)", async () => {
    config.analytics.enabled = false;
    expect(await getEligibility()).toBe(false);
  });

  test("ineligible once the survey was submitted for the organization", async () => {
    await OrganizationModel.markOnboardingSurveyCompleted(organizationId);
    expect(await getEligibility()).toBe(false);
  });

  test("ineligible when LLM proxy interactions exist", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await InteractionModel.create({
      profileId: agent.id,
      request: {
        model: "gpt-4",
        messages: [{ role: "user", content: "Hello" }],
      },
      response: {
        id: "test-response",
        object: "chat.completion",
        created: Date.now(),
        model: "gpt-4",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hi", refusal: null },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
      type: "openai:chatCompletions",
    });

    expect(await getEligibility()).toBe(false);
  });

  test("ineligible when MCP tool calls exist", async ({ makeAgent }) => {
    const agent = await makeAgent();
    await McpToolCallModel.create({
      agentId: agent.id,
      mcpServerName: "test-server",
      method: "tools/call",
      toolCall: { id: "call-1", name: "testTool", arguments: {} },
      toolResult: { ok: true },
    });

    expect(await getEligibility()).toBe(false);
  });
});
