import { describe, expect, test } from "@/test";
import InteractionModel from "./interaction";
import StatisticsModel from "./statistics";

/**
 * Tests for the two statistics methods:
 *   - `getUserStatistics` — grouped by `billed_user_id` (NOT `user_id`)
 *   - `getVirtualKeyStatistics` — grouped by `virtual_api_key_id`
 */
describe("StatisticsModel.getUserStatistics", () => {
  test("groups only by billed_user_id, ignoring header-tracing user_id", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const billed = await makeUser({ name: "Billed User" });
    const tracingOnly = await makeUser({ name: "Tracing Only" });
    const agent = await makeAgent({ organizationId: org.id });

    // Interaction with only `userId` set (no billedUserId) — must NOT appear
    // in the breakdown.
    await InteractionModel.create({
      profileId: agent.id,
      userId: tracingOnly.id,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 200,
      cost: "0.5",
    });

    // Interaction with billedUserId — must appear.
    await InteractionModel.create({
      profileId: agent.id,
      userId: billed.id,
      billedUserId: billed.id,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 50,
      outputTokens: 75,
      cost: "1.25",
    });

    const stats = await StatisticsModel.getUserStatistics({
      timeframe: "24h",
      organizationId: org.id,
      isAgentAdmin: true,
    });
    const byId = new Map(stats.map((s) => [s.userId, s]));

    expect(byId.get(billed.id)?.requests).toBe(1);
    expect(byId.get(billed.id)?.inputTokens).toBe(50);
    expect(byId.get(billed.id)?.outputTokens).toBe(75);
    expect(byId.get(billed.id)?.userName).toBe("Billed User");
    expect(byId.has(tracingOnly.id)).toBe(false);
  });
});

describe("StatisticsModel.getVirtualKeyStatistics", () => {
  test("groups by virtual_api_key_id and returns vkey name", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret();
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);
    const agent = await makeAgent({ organizationId: org.id });

    const { default: VirtualApiKeyModel } = await import("./virtual-api-key");
    const { virtualKey } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "stats-vkey",
      scope: "org",
    });

    await InteractionModel.create({
      profileId: agent.id,
      virtualApiKeyId: virtualKey.id,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 20,
      cost: "0.01",
    });

    const stats = await StatisticsModel.getVirtualKeyStatistics({
      timeframe: "24h",
      userId: user.id,
      organizationId: org.id,
      isAgentAdmin: true,
    });

    const entry = stats.find((s) => s.virtualKeyId === virtualKey.id);
    expect(entry).toBeDefined();
    expect(entry?.virtualKeyName).toBe("stats-vkey");
    expect(entry?.requests).toBe(1);
    expect(entry?.inputTokens).toBe(10);
    expect(entry?.outputTokens).toBe(20);
  });
});
