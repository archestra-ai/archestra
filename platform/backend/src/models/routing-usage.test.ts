import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import InteractionModel from "@/models/interaction";
import RoutingDecisionModel from "@/models/routing-decision";
import RoutingUsageModel from "@/models/routing-usage";
import { describe, expect, test } from "@/test";
import {
  makeRoutingModel,
  makeScorerVersion,
  plannedDecision,
} from "@/test/auto-routing";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import type { InsertInteraction } from "@/types/interaction";

describe("routing usage", () => {
  test("a retried interaction write contributes its usage once", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { organizationId, profileId, decision, scorer } = await setup({
      makeAgent,
      makeOrganization,
    });
    const id = randomUUID();

    await InteractionModel.record(
      interaction({ id, profileId, decisionId: decision.id }),
    );
    await InteractionModel.record(
      interaction({ id, profileId, decisionId: decision.id }),
    );

    const [row] = await fitHistory({
      organizationId,
      scorerVersionId: scorer.id,
      inputWatermark: twoDaysAhead(),
    });
    expect(row.short.input).toBe(100);
  });

  test("an interaction that fails to persist contributes nothing", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { organizationId, profileId, decision } = await setup({
      makeAgent,
      makeOrganization,
    });
    const other = await makeAgent({ organizationId });
    const id = randomUUID();
    await InteractionModel.record(interaction({ id, profileId: other.id }));

    await expect(
      InteractionModel.record(
        interaction({ id, profileId, decisionId: decision.id }),
      ),
    ).rejects.toThrow("different attribution");

    expect(await db.select().from(schema.routingUsageTable)).toEqual([]);
  });

  test("an interaction without usage contributes nothing", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { profileId, decision } = await setup({
      makeAgent,
      makeOrganization,
    });

    await InteractionModel.record({
      ...interaction({ id: randomUUID(), profileId, decisionId: decision.id }),
      inputTokens: null,
      outputTokens: null,
    });

    expect(await db.select().from(schema.routingUsageTable)).toEqual([]);
  });

  test("concurrent completions of one shared session sum exactly", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { organizationId, profileId, decision, scorer } = await setup({
      makeAgent,
      makeOrganization,
    });
    const completions = 25;

    await Promise.all(
      Array.from({ length: completions }, () =>
        InteractionModel.record(
          interaction({ id: randomUUID(), profileId, decisionId: decision.id }),
        ),
      ),
    );

    const [row] = await fitHistory({
      organizationId,
      scorerVersionId: scorer.id,
      inputWatermark: twoDaysAhead(),
    });
    expect(row.short).toEqual({
      input: 100 * completions,
      cacheRead: 1_000 * completions,
      cacheWrite: 50 * completions,
      output: 20 * completions,
    });
  });

  test("a request whose decision was purged mid-flight still persists, and its orphan usage is ignored", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { organizationId, profileId, decision, scorer } = await setup({
      makeAgent,
      makeOrganization,
    });
    const looked = await RoutingDecisionModel.find({
      organizationId,
      sessionKey: decision.sessionKey,
    });
    expect(looked?.id).toBe(decision.id);
    await db
      .update(schema.routingDecisionsTable)
      .set({ createdAt: new Date(Date.now() - 91 * DAY_MS) })
      .where(eq(schema.routingDecisionsTable.id, decision.id));
    expect((await RoutingDecisionModel.purgeExpired()).decisions).toBe(1);

    const id = randomUUID();
    await InteractionModel.record(
      interaction({ id, profileId, decisionId: decision.id }),
    );

    const [stored] = await db
      .select({ id: schema.interactionsTable.id })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, id));
    expect(stored?.id).toBe(id);
    expect(await db.select().from(schema.routingUsageTable)).toHaveLength(1);
    expect(
      await fitHistory({
        organizationId,
        scorerVersionId: scorer.id,
        inputWatermark: twoDaysAhead(),
      }),
    ).toEqual([]);
  });

  describe("fit history", () => {
    test("counts only sessions idle for a day before the watermark", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const { organizationId, profileId, decision, scorer } = await setup({
        makeAgent,
        makeOrganization,
      });
      const idle = await addDecision({
        organizationId,
        sessionId: "idle",
        scorerVersionId: scorer.id,
      });
      await recordAt({ profileId, decisionId: decision.id, ago: 23 * HOUR_MS });
      await recordAt({ profileId, decisionId: decision.id, ago: 30 * HOUR_MS });
      await recordAt({ profileId, decisionId: idle.id, ago: 25 * HOUR_MS });

      const rows = await fitHistory({
        organizationId,
        scorerVersionId: scorer.id,
      });

      expect(rows.map((row) => row.createdAt)).toEqual([idle.createdAt]);
    });

    test("reads only the active scorer version, scored sessions, and the last 35 days", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const { organizationId, profileId, decision, scorer } = await setup({
        makeAgent,
        makeOrganization,
      });
      const otherScorer = await makeScorerVersion();
      const otherVersion = await addDecision({
        organizationId,
        sessionId: "other-version",
        scorerVersionId: otherScorer.id,
      });
      const scorerError = await addDecision({
        organizationId,
        sessionId: "scorer-error",
        scorerVersionId: scorer.id,
        overrides: { reason: "scorer_error", features: null },
      });
      const tooOld = await addDecision({
        organizationId,
        sessionId: "too-old",
        scorerVersionId: scorer.id,
      });
      await db
        .update(schema.routingDecisionsTable)
        .set({ createdAt: new Date(Date.now() - 36 * DAY_MS) })
        .where(eq(schema.routingDecisionsTable.id, tooOld.id));
      for (const decisionId of [
        decision.id,
        otherVersion.id,
        scorerError.id,
        tooOld.id,
      ]) {
        await recordAt({ profileId, decisionId, ago: 2 * DAY_MS });
      }

      const rows = await fitHistory({
        organizationId,
        scorerVersionId: scorer.id,
      });

      expect(rows.map((row) => row.createdAt)).toEqual([decision.createdAt]);
    });

    test("splits usage at the long-context threshold, strictly above it", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const { organizationId, profileId, decision, scorer } = await setup({
        makeAgent,
        makeOrganization,
      });
      // Prompt = input + cache read + cache write = 1_150 per default request.
      await recordAt({ profileId, decisionId: decision.id, ago: 2 * DAY_MS });
      await recordAt({
        profileId,
        decisionId: decision.id,
        ago: 2 * DAY_MS,
        overrides: { inputTokens: 101, inputTokensEstimated: true },
      });

      const [row] = await fitHistory({
        organizationId,
        scorerVersionId: scorer.id,
        longContextThreshold: 1_150,
      });

      expect(row.short.input).toBe(100);
      expect(row.long.input).toBe(101);
      expect(row.long.output).toBe(20);
      expect(row.features.client).toBe("claude-code");
      const stored = await db
        .select({ estimated: schema.routingUsageTable.estimated })
        .from(schema.routingUsageTable)
        .where(eq(schema.routingUsageTable.decisionId, decision.id));
      expect(stored.map((usage) => usage.estimated).sort()).toEqual([
        false,
        true,
      ]);
    });
  });
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const twoDaysAhead = () => new Date(Date.now() + 2 * DAY_MS);

async function setup(fixtures: {
  makeAgent: (o: { organizationId: string }) => Promise<{ id: string }>;
  makeOrganization: () => Promise<{ id: string }>;
}) {
  const organization = await fixtures.makeOrganization();
  const agent = await fixtures.makeAgent({ organizationId: organization.id });
  const scorer = await makeScorerVersion();
  const decision = await addDecision({
    organizationId: organization.id,
    sessionId: "session",
    scorerVersionId: scorer.id,
  });
  return {
    organizationId: organization.id,
    profileId: agent.id,
    decision,
    scorer,
  };
}

async function addDecision(params: {
  organizationId: string;
  sessionId: string;
  scorerVersionId: string;
  overrides?: Partial<ReturnType<typeof plannedDecision>>;
}) {
  const model = await makeRoutingModel();
  const { decision } = await RoutingDecisionModel.insertOrGet({
    ...plannedDecision({
      organizationId: params.organizationId,
      sessionKey: RoutingSessionKeySchema.parse(params.sessionId),
      modelId: model.id,
      scorerVersionId: params.scorerVersionId,
    }),
    ...params.overrides,
  });
  return decision;
}

function interaction(params: {
  id: string;
  profileId: string;
  decisionId?: string;
}): InsertInteraction {
  return {
    id: params.id,
    profileId: params.profileId,
    autoRoutingDecisionId: params.decisionId,
    type: "openai:chatCompletions",
    model: "gpt-4o",
    request: { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] },
    response: {
      id: "response",
      object: "chat.completion",
      created: 0,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    },
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 50,
    cacheWrite1hTokens: 10,
  };
}

/** Records an auto-routed interaction whose usage arrived `ago` milliseconds before now. */
async function recordAt(params: {
  profileId: string;
  decisionId: string;
  ago: number;
  overrides?: Partial<InsertInteraction>;
}) {
  const id = randomUUID();
  await InteractionModel.record({
    ...interaction({
      id,
      profileId: params.profileId,
      decisionId: params.decisionId,
    }),
    ...params.overrides,
  });
  await db
    .update(schema.routingUsageTable)
    .set({ createdAt: new Date(Date.now() - params.ago) })
    .where(eq(schema.routingUsageTable.interactionId, id));
}

async function fitHistory(params: {
  organizationId: string;
  scorerVersionId: string;
  longContextThreshold?: number;
  inputWatermark?: Date;
}) {
  const history = await RoutingUsageModel.findFitHistory({
    ...params,
    inputWatermark: params.inputWatermark ?? new Date(),
    longContextThreshold: params.longContextThreshold ?? null,
  });
  return history.sample;
}
