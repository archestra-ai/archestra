import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import InteractionModel from "./interaction";
import LimitModel, { LimitValidationService } from "./limit";

/**
 * Write-back invariants: vkey traffic never bills the key's creator, and
 * user-scope counters move on `billedUserId`, not on the tracing `userId`.
 */
describe("updateUsageAfterInteraction — budgeting invariants", () => {
  test("user-scope updates only when interaction.billedUserId is set", async ({
    makeAgent,
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const userLimit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    });

    // Header-only user (no billedUserId) — must not bill the user-scope limit.
    await InteractionModel.updateUsageAfterInteraction({
      id: "00000000-0000-0000-0000-000000000001",
      profileId: agent.id,
      userId: user.id,
      billedUserId: undefined,
      virtualApiKeyId: undefined,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 200,
    });

    // Pre-seeded row must stay at zero.
    const afterTracing = await LimitModel.getRawModelUsage(userLimit.id);
    const tracingGptRow = afterTracing.find((r) => r.model === "gpt-4o");
    expect(tracingGptRow?.currentUsageTokensIn ?? 0).toBe(0);
    expect(tracingGptRow?.currentUsageTokensOut ?? 0).toBe(0);

    // Same user as billedUserId — counter moves.
    await InteractionModel.updateUsageAfterInteraction({
      id: "00000000-0000-0000-0000-000000000002",
      profileId: agent.id,
      userId: user.id,
      billedUserId: user.id,
      virtualApiKeyId: undefined,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 200,
    });

    const afterBilling = await LimitModel.getRawModelUsage(userLimit.id);
    const billingGptRow = afterBilling.find((r) => r.model === "gpt-4o");
    expect(billingGptRow?.currentUsageTokensIn).toBe(100);
    expect(billingGptRow?.currentUsageTokensOut).toBe(200);
  });

  test("vkey call never bills the key's creator", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    // Alice owns the vkey and a tight $1 user-scope limit; Bob uses the vkey.
    const alice = await makeUser({ email: "alice@example.com" });
    const _bob = await makeUser({ email: "bob@example.com" });
    const agent = await makeAgent({ organizationId: org.id });
    const virtualKeyId = "00000000-0000-0000-0000-00000000abcd";

    const aliceLimit = await LimitModel.create({
      entityType: "user",
      entityId: alice.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });
    const vkeyLimit = await LimitModel.create({
      entityType: "virtual_api_key",
      entityId: virtualKeyId,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    });

    // Bob uses Alice's vkey: proxy sets billedUserId=undefined for vkey traffic.
    await InteractionModel.updateUsageAfterInteraction({
      id: "00000000-0000-0000-0000-000000000010",
      profileId: agent.id,
      userId: undefined,
      billedUserId: undefined,
      virtualApiKeyId: virtualKeyId,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 500,
      outputTokens: 500,
    });

    // Alice's user-scope counter stays at zero.
    const aliceUsage = await LimitModel.getRawModelUsage(aliceLimit.id);
    const aliceGptRow = aliceUsage.find((r) => r.model === "gpt-4o");
    expect(aliceGptRow?.currentUsageTokensIn ?? 0).toBe(0);
    expect(aliceGptRow?.currentUsageTokensOut ?? 0).toBe(0);

    // vkey-scope counter moves.
    const vkeyUsage = await LimitModel.getRawModelUsage(vkeyLimit.id);
    const vkeyGptRow = vkeyUsage.find((r) => r.model === "gpt-4o");
    expect(vkeyGptRow?.currentUsageTokensIn).toBe(500);
    expect(vkeyGptRow?.currentUsageTokensOut).toBe(500);
  });

  test("vkey-scope updates independent of user/agent/team walk", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const virtualKeyId = "00000000-0000-0000-0000-0000000000ff";

    const vkeyLimit = await LimitModel.create({
      entityType: "virtual_api_key",
      entityId: virtualKeyId,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    });
    const orgLimit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    });

    await InteractionModel.updateUsageAfterInteraction({
      id: "00000000-0000-0000-0000-000000000020",
      profileId: agent.id,
      userId: undefined,
      billedUserId: undefined,
      virtualApiKeyId: virtualKeyId,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
    });

    const vkeyUsage = await LimitModel.getRawModelUsage(vkeyLimit.id);
    const orgUsage = await LimitModel.getRawModelUsage(orgLimit.id);

    // vkey and org both incremented — agent→org walk runs regardless of vkey.
    expect(vkeyUsage[0].currentUsageTokensIn).toBe(100);
    expect(orgUsage[0].currentUsageTokensIn).toBe(100);
  });

  test("billed_user_id persists on the interaction row", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const interaction = await InteractionModel.create({
      profileId: agent.id,
      billedUserId: user.id,
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 10,
    });

    const [row] = await db
      .select({
        billedUserId: schema.interactionsTable.billedUserId,
        virtualApiKeyId: schema.interactionsTable.virtualApiKeyId,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));

    expect(row.billedUserId).toBe(user.id);
    expect(row.virtualApiKeyId).toBeNull();
  });

  test("Chat UI session bills the session user even with an org-scope upstream key", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const secret = await makeSecret({ secret: { apiKey: "sk-org" } });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      scope: "org",
    });

    const userLimit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 50,
      model: ["gpt-4o"],
    });
    await db
      .insert(schema.limitModelUsageTable)
      .values({
        limitId: userLimit.id,
        model: "gpt-4o",
        currentUsageTokensIn: 10_000_000,
        currentUsageTokensOut: 10_000_000,
      })
      .onConflictDoUpdate({
        target: [
          schema.limitModelUsageTable.limitId,
          schema.limitModelUsageTable.model,
        ],
        set: {
          currentUsageTokensIn: 10_000_000,
          currentUsageTokensOut: 10_000_000,
        },
      });
    await LimitModel.patch({
      id: userLimit.id,
      data: { lastCleanup: new Date() },
    });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      billedUserId: user.id,
      model: "gpt-4o",
    });

    expect(result).not.toBeNull();
  });

  test("virtual_api_key_id persists as NULL when absent", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "no-vkey agent" });

    const interaction = await InteractionModel.create({
      profileId: agent.id,
      // billedUserId / virtualApiKeyId intentionally omitted
      type: "openai:chatCompletions",
      request: { model: "gpt-4o", messages: [] } as never,
      response: { choices: [] } as never,
      model: "gpt-4o",
      inputTokens: 0,
      outputTokens: 0,
    });

    const [row] = await db
      .select({
        billedUserId: schema.interactionsTable.billedUserId,
        virtualApiKeyId: schema.interactionsTable.virtualApiKeyId,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));

    // Drizzle translates runtime `undefined` → SQL NULL on write.
    expect(row.billedUserId).toBeNull();
    expect(row.virtualApiKeyId).toBeNull();
  });
});
