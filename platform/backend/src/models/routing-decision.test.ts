import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { routerFeatures } from "@/auto-routing/signals";
import db, { schema } from "@/database";
import RoutingDecisionModel from "@/models/routing-decision";
import { describe, expect, test } from "@/test";
import {
  makeRoutingModel,
  makeScorerVersion,
  plannedDecision,
} from "@/test/auto-routing";
import {
  RoutingDecisionFeaturesSchema,
  type RoutingSessionKey,
} from "@/types/auto-routing";

describe("RoutingDecisionModel", () => {
  test("concurrent first requests of a session agree on one decision", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const sessionKey = sessionKeyFor("session-1");

    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((tierIndex) =>
        RoutingDecisionModel.insertOrGet(
          plannedDecision({
            organizationId: organization.id,
            sessionKey,
            modelId: model.id,
            scorerVersionId: scorer.id,
            tierIndex: tierIndex % 3,
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.decision.id)).size).toBe(1);
    expect(
      new Set(results.map((result) => result.decision.tierIndex)).size,
    ).toBe(1);
  });

  test("the same session id in another organization gets its own decision", async ({
    makeOrganization,
  }) => {
    const first = await makeOrganization();
    const second = await makeOrganization();
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const sessionKey = sessionKeyFor("shared-session-id");

    const a = await RoutingDecisionModel.insertOrGet(
      plannedDecision({
        organizationId: first.id,
        sessionKey,
        modelId: model.id,
        scorerVersionId: scorer.id,
        tierIndex: 0,
      }),
    );
    const b = await RoutingDecisionModel.insertOrGet(
      plannedDecision({
        organizationId: second.id,
        sessionKey,
        modelId: model.id,
        scorerVersionId: scorer.id,
        tierIndex: 2,
      }),
    );

    expect(b.created).toBe(true);
    expect(b.decision.id).not.toBe(a.decision.id);
    expect(
      (
        await RoutingDecisionModel.find({
          organizationId: first.id,
          sessionKey,
        })
      )?.tierIndex,
    ).toBe(0);
    expect(
      (
        await RoutingDecisionModel.find({
          organizationId: second.id,
          sessionKey,
        })
      )?.tierIndex,
    ).toBe(2);
  });

  test("v2 features round-trip by source id and translate to router-core's input", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const values = plannedDecision({
      organizationId: organization.id,
      sessionKey: sessionKeyFor("round-trip"),
      modelId: model.id,
      scorerVersionId: scorer.id,
    });

    await RoutingDecisionModel.insertOrGet(values);
    const stored = await RoutingDecisionModel.find({
      organizationId: organization.id,
      sessionKey: values.sessionKey,
    });

    expect(stored?.featuresSchemaVersion).toBe(1);
    expect(stored?.features).toEqual(values.features);
    expect(stored?.features && routerFeatures(stored.features)).toEqual({
      tier_needed: [0.2, 0.5, 0.3],
      p_long: 0.1,
      source: "claude-code",
    });
  });

  test("features reject malformed signals", () => {
    const signal = {
      version: randomUUID(),
      tier_needed: [0.2, 0.5, 0.3],
      p_long: 0.1,
    };
    const valid = {
      signals: { "jev-session": signal },
      client: "claude-code",
    };
    const parse = (value: unknown) =>
      RoutingDecisionFeaturesSchema.safeParse(value).success;

    expect(parse(valid)).toBe(true);
    expect(parse({ ...valid, signals: {} })).toBe(false);
    expect(
      parse({
        ...valid,
        signals: { "jev-session": { ...signal, version: "v1" } },
      }),
    ).toBe(false);
    expect(
      parse({ ...valid, signals: { "jev-session": { ...signal, p_long: 2 } } }),
    ).toBe(false);
  });

  describe("sessionKey", () => {
    const virtualKeyId = randomUUID();

    test("a client session id is the key regardless of the conversation", () => {
      expect(
        RoutingDecisionModel.sessionKey({
          sessionId: "abc",
          virtualKeyId,
          firstUserMessage: { role: "user", content: "hello" },
        }),
      ).toBe(
        RoutingDecisionModel.sessionKey({
          sessionId: "abc",
          virtualKeyId: null,
          firstUserMessage: null,
        }),
      );
    });

    test("without a session id, a resent conversation keeps its key across cache-marker rewrites", () => {
      const plain = RoutingDecisionModel.sessionKey({
        sessionId: null,
        virtualKeyId,
        firstUserMessage: { role: "user", content: "fix the bug" },
      });
      const marked = RoutingDecisionModel.sessionKey({
        sessionId: null,
        virtualKeyId,
        firstUserMessage: {
          role: "user",
          content: [
            {
              type: "text",
              text: "fix the bug",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      });

      expect(plain).not.toBeNull();
      expect(marked).toBe(plain);
    });

    test("without a session id, the key separates virtual keys and first messages", () => {
      const key = (vk: string, content: string) =>
        RoutingDecisionModel.sessionKey({
          sessionId: null,
          virtualKeyId: vk,
          firstUserMessage: { role: "user", content },
        });

      expect(key(virtualKeyId, "a")).not.toBe(key(randomUUID(), "a"));
      expect(key(virtualKeyId, "a")).not.toBe(key(virtualKeyId, "b"));
    });

    test("nothing to stick to yields no key", () => {
      expect(
        RoutingDecisionModel.sessionKey({
          sessionId: null,
          virtualKeyId,
          firstUserMessage: null,
        }),
      ).toBeNull();
      expect(
        RoutingDecisionModel.sessionKey({
          sessionId: null,
          virtualKeyId: null,
          firstUserMessage: { role: "user", content: "hi" },
        }),
      ).toBeNull();
    });
  });

  test("purge removes only decisions and usage past retention, each by its own age", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const values = (session: string) =>
      plannedDecision({
        organizationId: organization.id,
        sessionKey: sessionKeyFor(session),
        modelId: model.id,
        scorerVersionId: scorer.id,
      });
    const old = await RoutingDecisionModel.insertOrGet(values("old"));
    const fresh = await RoutingDecisionModel.insertOrGet(values("fresh"));
    const now = new Date("2026-06-01T00:00:00Z");
    const daysAgo = (days: number) =>
      new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    await db
      .update(schema.routingDecisionsTable)
      .set({ createdAt: daysAgo(91) })
      .where(eq(schema.routingDecisionsTable.id, old.decision.id));
    await db
      .update(schema.routingDecisionsTable)
      .set({ createdAt: daysAgo(10) })
      .where(eq(schema.routingDecisionsTable.id, fresh.decision.id));
    const usage = (decisionId: string, createdAt: Date) => ({
      interactionId: randomUUID(),
      decisionId,
      createdAt,
      input: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 1,
      estimated: false,
    });
    await db
      .insert(schema.routingUsageTable)
      .values([
        usage(old.decision.id, daysAgo(91)),
        usage(old.decision.id, daysAgo(80)),
        usage(fresh.decision.id, daysAgo(5)),
      ]);

    expect(await RoutingDecisionModel.purgeExpired(now)).toEqual({
      decisions: 1,
      usage: 1,
    });
    expect(
      await RoutingDecisionModel.find({
        organizationId: organization.id,
        sessionKey: sessionKeyFor("old"),
      }),
    ).toBeNull();
    expect(await db.select().from(schema.routingUsageTable)).toHaveLength(2);
  });

  test("purge deletes in batches until nothing expired is left", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const model = await makeRoutingModel();
    const scorer = await makeScorerVersion();
    const now = new Date("2026-06-01T00:00:00Z");
    const expired = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
    const inserted = await db
      .insert(schema.routingDecisionsTable)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          ...plannedDecision({
            organizationId: organization.id,
            sessionKey: sessionKeyFor(`batch-${i}`),
            modelId: model.id,
            scorerVersionId: scorer.id,
          }),
          createdAt: expired,
        })),
      )
      .returning({ id: schema.routingDecisionsTable.id });
    await db.insert(schema.routingUsageTable).values(
      inserted.map(({ id }) => ({
        interactionId: randomUUID(),
        decisionId: id,
        createdAt: expired,
        input: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 1,
        estimated: false,
      })),
    );

    expect(await RoutingDecisionModel.purgeExpired(now, 2)).toEqual({
      decisions: 5,
      usage: 5,
    });
    expect(await db.select().from(schema.routingDecisionsTable)).toEqual([]);
    expect(await db.select().from(schema.routingUsageTable)).toEqual([]);
  });
});

function sessionKeyFor(sessionId: string): RoutingSessionKey {
  const key = RoutingDecisionModel.sessionKey({
    sessionId,
    virtualKeyId: null,
    firstUserMessage: null,
  });
  if (!key) throw new Error("session id must yield a key");
  return key;
}
