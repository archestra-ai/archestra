import { randomUUID } from "node:crypto";
import { logContentNotStored } from "@archestra/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingHistoryModel from "@/models/routing-history";
import { beforeEach, describe, expect, type TestFixtures, test } from "@/test";
import {
  configureAutoRouting,
  makeScorerVersion,
  plannedDecision,
} from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useMswServer } from "@/test/msw";
import type { InteractionRequest } from "@/types";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import {
  cancelBackfill,
  describeBackfill,
  runBackfill,
  startBackfillScan,
  startBackfillScoring,
} from "./backfill";
import { completeFit, prepareFit, readFitWindow, runFit } from "./fit";
import { updateAutoRoutingSettings } from "./settings";
import { activeSourceVersion } from "./signals";

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DAY_MS = 24 * 60 * 60 * 1000;

const ANSWERS = {
  model: "jev-1.13.0",
  answers: {
    tier_needed: {
      type: "score",
      score: 1.1,
      confidence: 0.6,
      probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
    },
    long_context: { type: "noul", noul: 0.35 },
  },
};

type MakeInteraction = TestFixtures["makeInteraction"];

describe("auto routing backfill", () => {
  const server = useMswServer();
  let organizationId: string;
  let userId: string;
  let profileId: string;
  let makeInteraction: MakeInteraction;
  let prompts: string[];

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
      makeInteraction: fixture,
    }) => {
      config.autoRouting.enabled = true;
      organizationId = (await makeOrganization()).id;
      userId = (await makeUser()).id;
      await configureAutoRouting(organizationId);
      profileId = (await AgentModel.getOrgLlmProxy(organizationId)).id;
      const secret = await makeSecret({ secret: { apiKey: "sk-typesafe" } });
      await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "jev",
      });
      makeInteraction = fixture;
      prompts = [];
      answerJev();
    },
  );

  function answerJev(respond?: () => Promise<void>) {
    server.use(
      http.post(JEV_ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { state: { prompt: string } };
        prompts.push(body.state.prompt);
        await respond?.();
        return HttpResponse.json(ANSWERS);
      }),
    );
  }

  /** One chat-completions turn of `sessionId` opening with `text`. */
  function turn(
    sessionId: string,
    text: string,
    overrides: Parameters<MakeInteraction>[1] = {},
    profile = profileId,
  ) {
    return makeInteraction(profile, {
      sessionId,
      sessionSource: "header",
      source: "api",
      request: { model: "gpt-4o", messages: [{ role: "user", content: text }] },
      createdAt: new Date(Date.now() - 3 * DAY_MS),
      inputTokens: 1_000,
      outputTokens: 200,
      ...overrides,
    });
  }

  async function sessions(count: number) {
    const keys = Array.from({ length: count }, (_, i) => `session-${i}`);
    for (const [i, key] of keys.entries()) {
      await turn(key, `Task number ${i}`, {
        createdAt: new Date(Date.now() - (2 + i) * DAY_MS),
      });
    }
    return keys;
  }

  async function scan() {
    await startBackfillScan(organizationId, userId);
    await runBackfill();
  }

  async function scanAndScore(body: {
    maxSessions?: number;
    maxCostUsd?: number;
  }) {
    await scan();
    await startBackfillScoring(organizationId, userId, {
      maxSessions: body.maxSessions ?? 3000,
      maxCostUsd: body.maxCostUsd ?? 10,
    });
    await runBackfill();
  }

  /** Each history session's reading by `scorerVersionId`, by session key. */
  async function readings(scorerVersionId?: string) {
    const version = scorerVersionId ?? (await activeSourceVersion()).id;
    const rows = await db
      .select({
        key: schema.routingHistorySessionsTable.sessionKey,
        status: schema.routingHistoryScoresTable.status,
        version: schema.routingHistoryScoresTable.scorerVersionId,
      })
      .from(schema.routingHistorySessionsTable)
      .leftJoin(
        schema.routingHistoryScoresTable,
        eq(
          schema.routingHistoryScoresTable.historySessionId,
          schema.routingHistorySessionsTable.id,
        ),
      )
      .where(
        eq(schema.routingHistorySessionsTable.organizationId, organizationId),
      );
    return Object.fromEntries(
      rows
        .filter((row) => row.version === null || row.version === version)
        .map((row) => [row.key, row.status ?? "unscored"]),
    );
  }

  test("scores each client session's opening main turn, through the organization's own rows", async ({
    makeOrganization,
  }) => {
    const claude = {
      sessionSource: "claude_code_header",
      type: "anthropic:messages" as const,
      externalAgentId: "claude-code",
    };
    await turn(
      "title-first",
      "Please write a 5-10 word title for this conversation",
      { ...claude, createdAt: new Date(Date.now() - 4 * DAY_MS) },
    );
    await turn("title-first", "Fix the login redirect", claude);
    await turn("side-turn", "Summarize the diff", {
      sessionSource: "opencode_session",
      source: "opencode:subagent",
      createdAt: new Date(Date.now() - 4 * DAY_MS),
    });
    await turn("side-turn", "Add pagination to the users API", {
      sessionSource: "opencode_session",
      source: "opencode:main",
    });
    const parent = await turn("delta", "Earlier opening", {
      createdAt: new Date(Date.now() - 40 * DAY_MS),
    });
    await turn("delta", "Only the new suffix", { parentId: parent.id });
    for (const attempt of [1, 2]) {
      await turn("failover", "Write the migration tests", {
        attempt,
        attemptOutcome: attempt === 1 ? "failed" : "success",
      });
    }
    await turn("metadata-only", "", {
      request: logContentNotStored() as unknown as InteractionRequest,
    });
    await turn("encrypted", "Sealed prompt", {
      encryptedChatConversationId: randomUUID(),
    });
    const other = await makeOrganization();
    await turn(
      "shared-id",
      "Another organization's prompt",
      { createdAt: new Date(Date.now() - 4 * DAY_MS) },
      (await AgentModel.getOrgLlmProxy(other.id)).id,
    );
    await turn("shared-id", "This organization's prompt");
    await turn("openai-user", "A user id, not a session", {
      sessionSource: "openai_user",
    });
    await turn("still-active", "Started an hour ago", {
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    await turn("chat", "An Archestra chat turn", { source: "chat" });

    await scanAndScore({});

    expect(prompts.sort()).toEqual(
      [
        "Add pagination to the users API",
        "Fix the login redirect",
        "This organization's prompt",
        "Write the migration tests",
      ].sort(),
    );
    expect(await readings()).toEqual({
      "title-first": "scored",
      "side-turn": "scored",
      failover: "scored",
      "shared-id": "scored",
      delta: "no_text",
      "metadata-only": "no_text",
      encrypted: "no_text",
    });
    const [failover] = await db
      .select()
      .from(schema.routingHistorySessionsTable)
      .where(eq(schema.routingHistorySessionsTable.sessionKey, "failover"));
    expect(failover).toMatchObject({ interactions: 2, totalTokens: 2_400 });
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({ status: "done", eligibleSessions: 7 });
    expect(backfill?.breakdown).toContainEqual({
      apiShape: "messages",
      client: "claude-code",
      sessions: 1,
    });
  });

  test("reads every turn the database stored at sub-millisecond precision", async () => {
    const first = await turn("precise", "Port the parser to a tokenizer", {
      createdAt: new Date(Date.now() - 3 * DAY_MS),
    });
    const second = await turn("precise", "Now add tests for that", {
      createdAt: new Date(Date.now() - 3 * DAY_MS + 60_000),
    });
    await db
      .update(schema.interactionsTable)
      .set({ createdAt: sql`created_at + interval '0.4 milliseconds'` })
      .where(inArray(schema.interactionsTable.id, [first.id, second.id]));

    await scanAndScore({});

    expect(prompts).toEqual(["Port the parser to a tokenizer"]);
    const usage = await db.select().from(schema.routingHistoryUsageTable);
    expect(usage.map((row) => row.interactionId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  test("the first enable scans for free; a later save does not scan again", async () => {
    await sessions(2);
    await updateAutoRoutingSettings(organizationId, { budgetUsdPerDay: 40 });
    await runBackfill();
    await updateAutoRoutingSettings(organizationId, { budgetUsdPerDay: 45 });

    const rows = await db
      .select()
      .from(schema.routingBackfillsTable)
      .where(eq(schema.routingBackfillsTable.organizationId, organizationId));
    expect(rows).toMatchObject([
      { status: "scanned", populationSessions: 2, startedBy: null },
    ]);
    expect(prompts).toHaveLength(0);
  });

  test("samples the lowest-ranked sessions, the same ones on every run", async () => {
    const keys = await sessions(8);
    await scanAndScore({ maxSessions: 3 });

    const ranks = await db.execute<{ key: string }>(sql`
      select key from unnest(${sql.raw(`ARRAY[${keys.map((key) => `'${key}'`).join(", ")}]`)}) as key
      order by hashtextextended(key, 0)
      limit 3`);
    const expected = ranks.rows.map((row) => row.key).sort();
    const scored = Object.entries(await readings())
      .filter(([, status]) => status === "scored")
      .map(([key]) => key)
      .sort();
    expect(scored).toEqual(expected);
    expect(prompts).toHaveLength(3);
  });

  test("a run that stops or dies resumes where it committed, calling the scorer once per session", async () => {
    await sessions(10);
    await scan();
    await startBackfillScoring(organizationId, userId, {
      maxSessions: 10,
      maxCostUsd: 10,
    });
    // A worker claims the backfill and dies; its lease is already expired.
    await RoutingBackfillModel.claimNext({
      owner: "dead-worker",
      leaseTtlSeconds: -1,
    });

    await runBackfill({ timeBudgetMs: 0 });
    const partial = await describeBackfill(organizationId);
    expect(partial.backfill?.status).toBe("running");
    expect(partial.backfill?.progress?.scored).toBeLessThan(10);

    await runBackfill();
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "done",
      progress: { sample: 10, scored: 10 },
    });
    expect(new Set(prompts).size).toBe(10);
    expect(prompts).toHaveLength(10);
  });

  test("cancelling mid-score drops the readings still in flight", async () => {
    await sessions(5);
    await scan();
    await startBackfillScoring(organizationId, userId, {
      maxSessions: 5,
      maxCostUsd: 10,
    });
    let cancelled: Promise<void> | null = null;
    answerJev(async () => {
      cancelled ??= cancelBackfill(organizationId);
      await cancelled;
    });

    await runBackfill();

    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "cancelled",
      progress: { scored: 0 },
    });
    expect(prompts.length).toBeLessThanOrEqual(4);
  });

  test("stops at the cost ceiling and still lets the next fit read what it scored", async () => {
    await sessions(6);
    const before = await AutoRoutingSettingsModel.find(organizationId);

    await scanAndScore({ maxSessions: 6, maxCostUsd: 0.002 });

    expect(prompts).toHaveLength(2);
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "done",
      error: "Stopped at the cost ceiling.",
      spentCostUsd: 0.002,
      progress: { scored: 2 },
    });
    expect(
      (await AutoRoutingSettingsModel.find(organizationId))?.generation,
    ).toBeGreaterThan(before?.generation ?? 0);
  });

  test("a scorer change supersedes the run; a re-score reads the same sessions again", async () => {
    await sessions(4);
    await scan();
    const previous = await makeScorerVersion();
    const waiting = await RoutingBackfillModel.findLatest(organizationId);
    await RoutingBackfillModel.startScore({
      id: waiting?.id ?? "",
      scorerVersionId: previous.id,
      maxSessions: 4,
      maxCostUsd: 10,
      startedBy: userId,
    });

    await runBackfill();
    const superseded = await describeBackfill(organizationId);
    expect(superseded.backfill?.status).toBe("superseded");
    expect(superseded.scoreOffer).toMatchObject({
      sessions: 4,
      remaining: 4,
      rescore: true,
    });
    expect(prompts).toHaveLength(0);

    await startBackfillScoring(organizationId, userId, {
      maxSessions: 4,
      maxCostUsd: 10,
    });
    await runBackfill();
    // Readings of the earlier version stay next to the new ones.
    const [first] = await RoutingHistoryModel.nextToScore({
      organizationId,
      windowStart: new Date(0),
      cutoff: new Date(),
      maxSessions: 4,
      scorerVersionId: previous.id,
      limit: 1,
    });
    await db.transaction((tx) =>
      RoutingHistoryModel.recordScore(
        {
          historySessionId: first.id,
          scorerVersionId: previous.id,
          status: "no_text",
          features: null,
          scorerCost: null,
        },
        tx,
      ),
    );

    expect(prompts).toHaveLength(4);
    expect((await describeBackfill(organizationId)).scoreOffer).toBeNull();
    const running = (await activeSourceVersion()).id;
    const window = (scorerVersionId: string) =>
      readFitWindow({
        organizationId,
        scorerVersionId,
        inputWatermark: new Date(),
      });
    expect((await window(running)).pastSessions).toBe(4);
    expect((await window(previous.id)).pastSessions).toBe(0);
  });

  test("live routing wins over history for a session it has seen", async () => {
    const [seen] = await sessions(2);
    await scanAndScore({});
    const scorerVersionId = (await activeSourceVersion()).id;
    const trio = await AutoRoutingSettingsModel.find(organizationId);
    const [decision] = await db
      .insert(schema.routingDecisionsTable)
      .values({
        ...plannedDecision({
          organizationId,
          sessionKey: RoutingSessionKeySchema.parse(seen),
          modelId: trio?.normalModelId ?? "",
          scorerVersionId,
        }),
        createdAt: new Date(Date.now() - 3 * DAY_MS),
      })
      .returning();
    await db.insert(schema.routingUsageTable).values({
      interactionId: randomUUID(),
      decisionId: decision.id,
      createdAt: decision.createdAt,
      input: 1_000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 100,
      estimated: false,
    });

    const window = await readFitWindow({
      organizationId,
      scorerVersionId,
      inputWatermark: new Date(),
    });

    expect(window).toMatchObject({ sessions: 2, pastSessions: 1 });
  });

  test("a fit after the backfill learns from it at the population's volume; one started before cannot publish", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(6);
    await scan();
    await startBackfillScoring(organizationId, userId, {
      maxSessions: 3,
      maxCostUsd: 10,
    });
    const before = await prepareFit(organizationId);

    await runBackfill();

    const stale = before && (await completeFit(before));
    expect(stale).toMatchObject({
      kind: "rejected",
      reason: "stale_generation",
    });
    const run = await runFit(organizationId);
    expect(run?.published.plan).toMatchObject({
      status: "active",
      diagnostics: {
        history: { sessions: 3, past_sessions: 3, volume_source: "history" },
      },
    });
    // Three scored sessions stand for the six eligible, started over five days.
    expect(run?.published.plan.summary?.sessions_per_day).toBeCloseTo(6 / 5);
  });

  test("readiness counts scored history; live traffic sizes the plan once it spans a week", async () => {
    await sessions(3);
    await scanAndScore({});
    const scorerVersionId = (await activeSourceVersion()).id;
    const window = () =>
      readFitWindow({
        organizationId,
        scorerVersionId,
        inputWatermark: new Date(),
      });
    expect(await window()).toMatchObject({
      sessions: 3,
      volumeSource: "history",
    });

    const settings = await AutoRoutingSettingsModel.find(organizationId);
    await seedFitHistory({
      organizationId,
      modelId: settings?.normalModelId ?? "",
      scorerVersionId,
      sessions: 10,
    });

    expect(await window()).toMatchObject({
      sessions: 13,
      pastSessions: 3,
      volumeSource: "live",
    });
  });
});
