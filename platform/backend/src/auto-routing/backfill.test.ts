import { randomUUID } from "node:crypto";
import {
  AUTO_ROUTING_BACKFILL_SCORER_CALLS,
  logContentNotStored,
} from "@archestra/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingHistoryModel from "@/models/routing-history";
import RoutingPlanModel from "@/models/routing-plan";
import { autoRoutingDispatcher } from "@/task-queue/handlers/auto-routing-dispatch-handler";
import { handleAutoRoutingFit } from "@/task-queue/handlers/auto-routing-fit-handler";
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

  function answerJev(
    options: { respond?: () => Promise<void>; costUsd?: number } = {},
  ) {
    server.use(
      http.post(JEV_ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { state: { prompt: string } };
        prompts.push(body.state.prompt);
        await options.respond?.();
        return HttpResponse.json(
          options.costUsd === undefined
            ? ANSWERS
            : { ...ANSWERS, usage: { cost: options.costUsd } },
        );
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

  async function sessions(count: number, prefix = "session") {
    const keys = Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
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

  /** Starts scoring what the organization is offered, as an admin confirming it would. */
  async function startScoring(
    body: { maxSessions?: number; maxCostUsd?: number } = {},
  ) {
    const { scoreOffer } = await describeBackfill(organizationId);
    if (!scoreOffer) throw new Error("Nothing is offered for scoring");
    return startBackfillScoring(organizationId, userId, {
      backfillId: scoreOffer.backfillId,
      scorerVersionId: scoreOffer.scorerVersionId,
      maxSessions: body.maxSessions ?? 3000,
      maxCostUsd: body.maxCostUsd ?? 10,
    });
  }

  async function scanAndScore(body: {
    maxSessions?: number;
    maxCostUsd?: number;
  }) {
    await scan();
    await startScoring(body);
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
    // Began before the window: its continuation is not a new session.
    await turn("crossing", "An old conversation", {
      createdAt: new Date(Date.now() - 36 * DAY_MS),
    });
    await turn("crossing", "Picked up again");
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
      "metadata-only": "no_text",
      encrypted: "no_text",
    });
    const [failover] = await db
      .select()
      .from(schema.routingHistorySessionsTable)
      .where(eq(schema.routingHistorySessionsTable.sessionKey, "failover"));
    expect(failover).toMatchObject({ interactions: 2, totalTokens: 2_400 });
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({ status: "done", eligibleSessions: 6 });
    expect(backfill?.breakdown).toContainEqual({
      apiShape: "messages",
      client: "claude-code",
      sessions: 1,
    });
  });

  test("a scan visits only the agents with traffic in its window", async ({
    makeAgent,
  }) => {
    const busy = await makeAgent({ organizationId });
    await makeAgent({ organizationId });
    const stale = await makeAgent({ organizationId });
    await turn("old", "Long gone", { createdAt: new Date(0) }, stale.id);
    await turn("live", "Still here", {}, busy.id);
    await turn("proxy", "Through the proxy");

    const windowStart = new Date(Date.now() - 30 * DAY_MS);
    expect(
      await RoutingHistoryModel.profileIds({
        organizationId,
        windowStart,
        cutoff: new Date(),
      }),
    ).toEqual([busy.id, profileId].sort());
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
    await startScoring({ maxSessions: 10 });
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
    await startScoring({ maxSessions: 5 });
    let cancelled: Promise<void> | null = null;
    answerJev({
      respond: async () => {
        cancelled ??= cancelBackfill(organizationId);
        await cancelled;
      },
    });

    await runBackfill();

    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "cancelled",
      progress: { scored: 0 },
    });
    expect(prompts.length).toBeLessThanOrEqual(4);
  });

  test("a new scan reports what of its sample is already scored", async () => {
    await sessions(4);
    await scanAndScore({ maxSessions: 4 });
    await turn("late", "One more task", {
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    });

    await scan();

    expect(await describeBackfill(organizationId)).toMatchObject({
      backfill: {
        status: "scanned",
        eligibleSessions: 5,
        progress: { sample: 5, scored: 4 },
      },
      scoreOffer: { remaining: 1 },
    });
  });

  test("stops at the cost ceiling and still lets the next fit read what it scored", async () => {
    await sessions(6);
    const before = await AutoRoutingSettingsModel.find(organizationId);

    await scanAndScore({ maxSessions: 6, maxCostUsd: 0.002 });

    expect(prompts).toHaveLength(2);
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "done",
      error: "Stopped at the spending limit.",
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
      organizationId,
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

    await startScoring({ maxSessions: 4 });
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
    await startScoring({ maxSessions: 3 });
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
  test("a call costing more than its reservation raises the next ones; the overshoot stays within the calls in flight", async () => {
    await sessions(20);
    // The first answer comes alone: once it reported its cost, a call
    // reserving the least a call reserves would still fit under the limit.
    let arrived = 0;
    let answerAll: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answerAll = resolve;
    });
    answerJev({
      costUsd: 0.01,
      respond: async () => {
        const call = ++arrived;
        if (call === 1) {
          setTimeout(answerAll, 300);
          return;
        }
        if (call > AUTO_ROUTING_BACKFILL_SCORER_CALLS) answerAll();
        await answered;
      },
    });

    await scanAndScore({ maxSessions: 20, maxCostUsd: 0.02 });

    expect(prompts.length).toBeLessThanOrEqual(
      AUTO_ROUTING_BACKFILL_SCORER_CALLS,
    );
    const [row] = await db
      .select()
      .from(schema.routingBackfillsTable)
      .where(eq(schema.routingBackfillsTable.organizationId, organizationId));
    expect(row).toMatchObject({
      status: "done",
      error: "Stopped at the spending limit.",
      reservedCostUsd: "0.000000",
      callCostUsd: "0.010000",
    });
    expect(Number(row.spentCostUsd)).toBeCloseTo(prompts.length * 0.01);
  });

  test("a failed usage copy pays for nothing, and the retry pays each session once", async () => {
    await sessions(3);
    await scan();
    await startScoring();
    await db.execute(sql`
      create function fail_history_usage() returns trigger language plpgsql
      as $$ begin raise exception 'usage copy failed'; end $$`);
    await db.execute(sql`
      create trigger fail_history_usage before insert on routing_history_usage
      for each row execute function fail_history_usage()`);

    await runBackfill();
    const failed = await describeBackfill(organizationId);
    expect(failed.backfill).toMatchObject({
      status: "running",
      spentCostUsd: 0,
      progress: { scored: 0 },
    });
    expect(prompts).toHaveLength(0);

    await db.execute(
      sql`drop trigger fail_history_usage on routing_history_usage`,
    );
    await runBackfill();
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "done",
      spentCostUsd: 0.003,
      progress: { scored: 3 },
    });
    expect(prompts).toHaveLength(3);
  });

  test("completion and its re-plan request commit together; the dispatcher fits what it requested", async () => {
    await sessions(2);
    await scan();
    await startScoring();
    const before = await AutoRoutingSettingsModel.find(organizationId);
    await db.execute(sql`
      create function fail_generation() returns trigger language plpgsql
      as $$ begin raise exception 'generation bump failed'; end $$`);
    await db.execute(sql`
      create trigger fail_generation before update of auto_routing_generation on agents
      for each row execute function fail_generation()`);

    await runBackfill();
    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "running",
    );
    await db.execute(sql`drop trigger fail_generation on agents`);
    await runBackfill();

    const after = await AutoRoutingSettingsModel.find(organizationId);
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
    expect((await describeBackfill(organizationId)).backfill).toMatchObject({
      status: "done",
      awaitingFit: true,
    });
    // The enqueue after the commit is lost; the dispatcher still fits.
    await db
      .delete(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "auto_routing_fit"));
    await autoRoutingDispatcher.dispatch();
    const fits = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "auto_routing_fit"));
    expect(fits).toHaveLength(1);
    await runFit(organizationId);
    expect((await describeBackfill(organizationId)).backfill?.awaitingFit).toBe(
      false,
    );
  });

  test("finds the opening past a page of auxiliary rows and decodes it by its own request shape", async () => {
    const start = Date.now() - 4 * DAY_MS;
    for (let i = 0; i < 25; i++) {
      await turn("long-preamble", "", {
        type: "openai:responses",
        request: {
          model: "gpt-4o",
          input: "Please write a 5-10 word title for this conversation",
        } as unknown as InteractionRequest,
        createdAt: new Date(start + i * 1000),
      });
    }
    await turn("long-preamble", "Refactor the billing module", {
      createdAt: new Date(start + 60_000),
    });

    await scanAndScore({});

    expect(prompts).toEqual(["Refactor the billing module"]);
    expect(await readings()).toEqual({ "long-preamble": "scored" });
  });

  test("scoring starts only for the scan and scorer the admin was offered", async () => {
    await sessions(2);
    await scan();
    const { scoreOffer: offered } = await describeBackfill(organizationId);
    if (!offered) throw new Error("Nothing is offered for scoring");
    const confirm = (offer: { backfillId: string; scorerVersionId: string }) =>
      startBackfillScoring(organizationId, userId, {
        ...offer,
        maxSessions: 2,
        maxCostUsd: 1,
      });

    await expect(
      confirm({ ...offered, scorerVersionId: (await makeScorerVersion()).id }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Another admin scans again before the first one confirms.
    await scan();
    await expect(confirm(offered)).rejects.toMatchObject({ statusCode: 409 });

    const current = await describeBackfill(organizationId);
    expect(current.backfill?.status).toBe("scanned");
    expect(current.scoreOffer?.backfillId).not.toBe(offered.backfillId);
    expect(prompts).toHaveLength(0);
    if (!current.scoreOffer) throw new Error("Nothing is offered for scoring");
    await confirm(current.scoreOffer);
    await runBackfill();
    expect(prompts).toHaveLength(2);
  });

  test("without a Jev key scoring is refused before it spends anything", async () => {
    await sessions(2);
    await scan();
    await db
      .delete(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.organizationId, organizationId));

    await expect(startScoring()).rejects.toMatchObject({ statusCode: 400 });
    await runBackfill();

    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({ status: "scanned", spentCostUsd: 0 });
    expect(prompts).toHaveLength(0);
  });

  test("a fit learns from one frame: the gap-free rank prefix of the latest scan, at its population's weight", async () => {
    await sessions(4, "early");
    await scanAndScore({ maxSessions: 4 });
    await sessions(8, "late");
    await scan();
    await startScoring({ maxSessions: 3 });
    await runBackfill();

    const ranked = await db.execute<{ key: string; attempted: boolean }>(sql`
      select s.session_key as key, exists (
        select 1 from routing_history_scores sc where sc.history_session_id = s.id
      ) as attempted
      from routing_history_sessions s
      where s.organization_id = ${organizationId}
      order by s.sample_rank, s.id`);
    const gap = ranked.rows.findIndex((row) => !row.attempted);
    const prefix = gap === -1 ? ranked.rows.length : gap;
    const inputs = await prepareFit(organizationId);
    const weights = inputs?.history.sample.map((row) => row.weight) ?? [];
    expect(weights).toHaveLength(prefix);
    expect(weights.reduce((total, weight) => total + weight, 0)).toBeCloseTo(
      12,
    );
    expect(inputs?.history.pastSessions).toBe(prefix);
  });

  test("a capped live sample and the past sample each stand for their whole window", async () => {
    await sessions(6);
    await scanAndScore({ maxSessions: 3 });
    const settings = await AutoRoutingSettingsModel.find(organizationId);
    await seedFitHistory({
      organizationId,
      modelId: settings?.normalModelId ?? "",
      scorerVersionId: (await activeSourceVersion()).id,
      sessions: 10,
    });

    const inputs = await prepareFit(organizationId, undefined, 5);

    const weights = inputs?.history.sample.map((row) => row.weight) ?? [];
    expect(weights).toHaveLength(8);
    expect(weights.reduce((total, weight) => total + weight, 0)).toBeCloseTo(
      16,
    );
  });

  test("the purge drops past sessions out of every window, obsolete readings and spent backfills, but not what a waiting scan covers", async () => {
    await sessions(3);
    await scanAndScore({});
    const done = await RoutingBackfillModel.findLatest(organizationId);
    const keep = (await activeSourceVersion()).id;
    const age = (key: string, days: number) =>
      db
        .update(schema.routingHistorySessionsTable)
        .set({ startedAt: new Date(Date.now() - days * DAY_MS) })
        .where(eq(schema.routingHistorySessionsTable.sessionKey, key));
    const purge = () =>
      RoutingHistoryModel.purgeExpired({
        windowStart: new Date(Date.now() - 35 * DAY_MS),
        keepScorerVersionId: keep,
      });
    const remaining = async () =>
      (
        await db
          .select({ key: schema.routingHistorySessionsTable.sessionKey })
          .from(schema.routingHistorySessionsTable)
      )
        .map((row) => row.key)
        .sort();
    await age("session-0", 36);
    await age("session-1", 34);
    const [kept] = await db
      .select()
      .from(schema.routingHistorySessionsTable)
      .where(eq(schema.routingHistorySessionsTable.sessionKey, "session-2"));
    await db.insert(schema.routingHistoryScoresTable).values({
      historySessionId: kept.id,
      scorerVersionId: (await makeScorerVersion()).id,
      status: "no_text",
    });

    expect(await purge()).toEqual({ sessions: 1, scores: 1, backfills: 0 });
    expect(await remaining()).toEqual(["session-1", "session-2"]);
    expect(await readings()).toEqual({
      "session-1": "scored",
      "session-2": "scored",
    });
    const usage = await db.select().from(schema.routingHistoryUsageTable);
    expect(usage).toHaveLength(2);

    // A waiting scan whose window reaches further back keeps its sessions.
    await scan();
    const waiting = await RoutingBackfillModel.findLatest(organizationId);
    await db
      .update(schema.routingBackfillsTable)
      .set({ windowStart: new Date(Date.now() - 40 * DAY_MS) })
      .where(eq(schema.routingBackfillsTable.id, waiting?.id ?? ""));
    await age("session-1", 36);
    await age("session-2", 36);
    expect(await purge()).toEqual({ sessions: 0, scores: 0, backfills: 0 });

    await db
      .update(schema.routingBackfillsTable)
      .set({ windowStart: new Date(Date.now() - 35 * DAY_MS) })
      .where(eq(schema.routingBackfillsTable.id, waiting?.id ?? ""));
    await db
      .update(schema.routingBackfillsTable)
      .set({ cutoff: new Date(Date.now() - 36 * DAY_MS) })
      .where(eq(schema.routingBackfillsTable.id, done?.id ?? ""));
    expect(await purge()).toEqual({ sessions: 2, scores: 0, backfills: 1 });
    // The waiting scan found session-0 again, from its own interactions.
    expect(await remaining()).toEqual(["session-0"]);
    expect(
      (await db.select().from(schema.routingBackfillsTable)).map(
        (row) => row.id,
      ),
    ).toEqual([waiting?.id]);
  });

  test("a late settlement from a reclaimed lease counts its call once and leaves the successor's reservation", async () => {
    await sessions(2);
    await scan();
    await startScoring();
    const claim = async () => {
      const claimed = await RoutingBackfillModel.claimNext({
        owner: "worker",
        leaseTtlSeconds: -1,
      });
      if (!claimed) throw new Error("Nothing to claim");
      return { id: claimed.id, epoch: claimed.leaseEpoch };
    };
    const reserve = async (lease: { id: string; epoch: number }) => {
      const outcome = await RoutingBackfillModel.reserve({
        lease,
        minAmount: 0.001,
        maxAttempts: 10,
      });
      if (outcome.kind !== "reserved") throw new Error(outcome.kind);
      return outcome.amount;
    };
    const settle = (
      lease: { id: string; epoch: number },
      reserved: number,
      spent: number,
    ) =>
      db.transaction((tx) =>
        RoutingBackfillModel.settle({ lease, reserved, spent }, tx),
      );
    const costs = async () => {
      const [row] = await db
        .select()
        .from(schema.routingBackfillsTable)
        .where(eq(schema.routingBackfillsTable.organizationId, organizationId));
      return {
        spent: Number(row.spentCostUsd),
        reserved: Number(row.reservedCostUsd),
      };
    };

    const stale = await claim();
    const first = await reserve(stale);
    const second = await reserve(stale);
    const current = await claim();
    const successor = await reserve(current);
    await settle(stale, first, first);
    await settle(stale, second, 0.004);

    expect(await costs()).toEqual({ spent: 0.005, reserved: successor });
    await settle(current, successor, 0.002);
    expect(await costs()).toEqual({ spent: 0.007, reserved: 0 });
  });

  test("a session whose reading never commits is paid at most twice, then counts as failed", async () => {
    const keys = await sessions(10);
    await scan();
    await startScoring();
    answerJev({ costUsd: 0.005 });
    await db.execute(sql`
      create function fail_history_score() returns trigger language plpgsql
      as $$ begin raise exception 'score commit failed'; end $$`);
    await db.execute(sql`
      create trigger fail_history_score before insert or update on routing_history_scores
      for each row when (new.status <> 'pending') execute function fail_history_score()`);
    try {
      await runBackfill();
      await runBackfill();
    } finally {
      await db.execute(
        sql`drop trigger fail_history_score on routing_history_scores`,
      );
      await db.execute(sql`drop function fail_history_score`);
    }
    for (let run = 0; run < 3; run++) await runBackfill();

    const calls = new Map<string, number>();
    for (const prompt of prompts) {
      calls.set(prompt, (calls.get(prompt) ?? 0) + 1);
    }
    const byStatus = await readings();
    const paidTwice = keys.filter(
      (_, i) => calls.get(`Task number ${i}`) === 2,
    );
    expect(Math.max(...calls.values())).toBe(2);
    expect(paidTwice.length).toBeGreaterThan(0);
    expect(keys.filter((key) => byStatus[key] === "failed").sort()).toEqual(
      paidTwice.sort(),
    );
    expect(
      keys
        .filter((key) => byStatus[key] !== "failed")
        .map((key) => byStatus[key]),
    ).toEqual(Array(keys.length - paidTwice.length).fill("scored"));

    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "done",
      progress: { sample: 10, failed: paidTwice.length },
    });
    const [row] = await db
      .select()
      .from(schema.routingBackfillsTable)
      .where(eq(schema.routingBackfillsTable.organizationId, organizationId));
    expect(Number(row.reservedCostUsd)).toBe(0);
    expect(Number(row.spentCostUsd)).toBeCloseTo(0.005 * prompts.length, 6);
  });

  describe("the fit a completed backfill requested always ends", () => {
    beforeEach(async () => {
      await sessions(2);
      await scanAndScore({});
      expect((await describeBackfill(organizationId)).backfill).toMatchObject({
        awaitingFit: true,
        fitBlockedReason: null,
      });
    });

    const fitState = async () => {
      const { backfill } = await describeBackfill(organizationId);
      return {
        awaitingFit: backfill?.awaitingFit,
        blocked: backfill?.fitBlockedReason !== null,
      };
    };

    test("as blocked once auto routing is off", async () => {
      await AutoRoutingSettingsModel.update(organizationId, { enabled: false });
      await handleAutoRoutingFit({ organizationId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: true });
    });

    test("as blocked without a daily budget", async () => {
      await AutoRoutingSettingsModel.update(organizationId, {
        budgetUsdPerDay: null,
      });
      await handleAutoRoutingFit({ organizationId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: true });
    });

    test("as blocked when a tier's model is gone", async () => {
      const settings = await AutoRoutingSettingsModel.find(organizationId);
      await db
        .delete(schema.modelsTable)
        .where(eq(schema.modelsTable.id, settings?.fastModelId ?? ""));
      await handleAutoRoutingFit({ organizationId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: true });
    });

    test("as planned after a rejected fit, by the refit", async () => {
      const stale = await prepareFit(organizationId);
      if (!stale) throw new Error("Auto routing is not configured");
      await AutoRoutingSettingsModel.update(organizationId, {
        budgetUsdPerDay: "45.00",
      });
      expect(await completeFit(stale)).toMatchObject({ kind: "rejected" });
      expect(await fitState()).toEqual({ awaitingFit: true, blocked: false });

      await handleAutoRoutingFit({ organizationId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: false });
    });

    test("as a recorded failure when the fit fails unexpectedly", async () => {
      await db.execute(sql`
        create function fail_plan() returns trigger language plpgsql
        as $$ begin raise exception 'publish failed'; end $$`);
      await db.execute(sql`
        create trigger fail_plan before insert on routing_plans
        for each row when (new.status <> 'failed') execute function fail_plan()`);
      try {
        await handleAutoRoutingFit({ organizationId });
      } finally {
        await db.execute(sql`drop trigger fail_plan on routing_plans`);
      }

      expect(await fitState()).toEqual({ awaitingFit: false, blocked: false });
      const [plan] = await RoutingPlanModel.findHistory(organizationId, 1);
      expect(plan.plan.status).toBe("failed");
    });
  });

  test("the score offer carries the window of the scan it names, not of a newer job", async () => {
    await sessions(2);
    await scan();
    const older = await RoutingBackfillModel.findLatest(organizationId);
    const olderWindow = new Date(Date.now() - 20 * DAY_MS);
    await db
      .update(schema.routingBackfillsTable)
      .set({ windowStart: olderWindow })
      .where(eq(schema.routingBackfillsTable.id, older?.id ?? ""));
    await startBackfillScan(organizationId, userId);
    await cancelBackfill(organizationId);

    const { backfill, scoreOffer } = await describeBackfill(organizationId);

    expect(backfill?.status).toBe("cancelled");
    expect(scoreOffer).toMatchObject({
      backfillId: older?.id,
      windowStart: olderWindow,
      cutoff: older?.cutoff,
    });
    expect(backfill?.windowStart).not.toEqual(olderWindow);
  });
});
