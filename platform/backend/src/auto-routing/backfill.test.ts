import { randomUUID } from "node:crypto";
import {
  AUTO_ROUTING_BACKFILL_SCORER_CALLS,
  logContentNotStored,
  SecretsManagerType,
} from "@archestra/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import logger from "@/logging";

vi.mock("@/logging");

import config from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AutoRouterModel from "@/models/auto-router";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import RoutingBackfillModel from "@/models/routing-backfill";
import RoutingHistoryModel from "@/models/routing-history";
import RoutingPlanModel from "@/models/routing-plan";
import { secretManager, secretManagerCoordinator } from "@/secrets-manager";
import { autoRoutingDispatcher } from "@/task-queue/handlers/auto-routing-dispatch-handler";
import { handleAutoRoutingFit } from "@/task-queue/handlers/auto-routing-fit-handler";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type TestFixtures,
  test,
} from "@/test";
import {
  autoRouterId,
  configureAutoRouting,
  ensureAutoRouter,
  makeScorerVersion,
  plannedDecision,
  setAutoRoutingEnabled,
  tiersBody,
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
import { diagnoseAutoRouting } from "./diagnostics";
import {
  completeFit,
  prepareFit,
  readFitHistory,
  readFitWindow,
  runFit,
  simulateFit,
} from "./fit";
import {
  createAutoRouter,
  getAutoRouter,
  setAutoRoutingEnabled as setAutoRoutingEnabledViaService,
  updateAutoRouter,
} from "./settings";
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

/** Own sessions that start a router without past ones. */
const LIVE_MIN_SESSIONS = 200;

describe("auto routing backfill", () => {
  const server = useMswServer();
  let organizationId: string;
  let routerId: string;
  let userId: string;
  let profileId: string;
  let makeInteraction: MakeInteraction;
  let prompts: string[];
  let organizationKeyId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeSecret,
      makeLlmProviderApiKey,
      makeInteraction: fixture,
    }) => {
      // The live minimum, so past sessions count from the first one scored.
      config.autoRouting.minSessions = LIVE_MIN_SESSIONS;
      organizationId = (await makeOrganization()).id;
      userId = (await makeUser()).id;
      await configureAutoRouting(organizationId);
      routerId = await autoRouterId(organizationId);
      profileId = (await AgentModel.getOrgLlmProxy(organizationId)).id;
      const secret = await makeSecret({ secret: { apiKey: "sk-typesafe" } });
      organizationKeyId = (
        await makeLlmProviderApiKey(organizationId, secret.id, {
          provider: "jev",
        })
      ).id;
      makeInteraction = fixture;
      prompts = [];
      answerJev();
    },
  );

  /** The `auto` router as it is now; a fit reads only its id, organization and past-sessions flag. */
  async function liveRouter() {
    const router = await AutoRouterModel.find(routerId);
    if (!router) throw new Error("auto router does not exist");
    return router;
  }

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

  /** The scan an admin starts from what the page shows them: the organization's newest backfill. */
  async function seen() {
    const latest = await RoutingBackfillModel.findLatest(organizationId);
    return { kind: "latest", backfillId: latest?.id ?? null } as const;
  }

  async function scan() {
    await startBackfillScan(organizationId, userId, await seen());
    await runBackfill();
  }

  /** Stops the organization's newest backfill, as the Stop button next to it does. */
  async function cancelLatest() {
    const latest = await RoutingBackfillModel.findLatest(organizationId);
    if (!latest) throw new Error("No backfill to cancel");
    await cancelBackfill(organizationId, latest.id, latest.phase);
  }

  /** Leaves `apiKeyId` with every grant but the one sharing it with the whole organization. */
  async function revokeOrganizationUse(apiKeyId: string) {
    const key = {
      organizationId,
      resource: "llmProviderApiKey",
      scope: apiKeyId,
    } as const;
    const policy = await ResourcePermissionPolicyModel.find(key);
    if (!policy) throw new Error("The key has no permission policy");
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy.revision,
      grants: policy.grants.filter(
        (grant) => grant.subject.type !== "organization",
      ),
    });
  }

  /** Moves the newest backfill on, so diagnostics rebuild their basis instead of reusing a cached one. */
  async function forgetDiagnosticsBasis() {
    await db.execute(sql`
      update routing_backfills set updated_at = updated_at + interval '1 second'
      where id = ${(await RoutingBackfillModel.findLatest(organizationId))?.id}`);
  }

  async function latestFrameId() {
    const scanned =
      await RoutingBackfillModel.findLatestScanned(organizationId);
    if (!scanned) throw new Error("No finished scan");
    return scanned.id;
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

  test("scores independent auxiliary sessions when there is no main turn", async () => {
    await turn("short", "hello", {
      sessionSource: "claude_code_header",
      type: "anthropic:messages",
    });
    await turn("subagent", "Inspect the API types", {
      sessionSource: "kilo_session",
      source: "kilo:subagent",
    });
    await turn("no-task", "Review the patch", {
      sessionSource: "kilo_session",
      source: "model_router",
    });
    await turn(
      "title-only",
      "Please write a 5-10 word title for this conversation",
      { sessionSource: "claude_code_header", type: "anthropic:messages" },
    );
    await scanAndScore({});
    expect(prompts.sort()).toEqual(
      [
        "hello",
        "Inspect the API types",
        "Review the patch",
        "Please write a 5-10 word title for this conversation",
      ].sort(),
    );
    expect(await readings()).toEqual({
      short: "scored",
      subagent: "scored",
      "no-task": "scored",
      "title-only": "scored",
    });
  });

  test("keeps looking for a main turn beyond the first page before using the fallback", async () => {
    for (let i = 0; i < 21; i++) {
      await turn("paged", "Summarize the changes", {
        sessionSource: "kilo_session",
        source: "kilo:subagent",
        createdAt: new Date(Date.now() - 4 * DAY_MS + i * 1000),
      });
    }
    await turn("paged", "Implement pagination", {
      sessionSource: "kilo_session",
      source: "kilo:main",
    });
    await scanAndScore({});
    expect(prompts).toEqual(["Implement pagination"]);
  });

  test("logs why unreadable or empty sessions were skipped without calling the scorer", async () => {
    await turn("metadata", "", {
      request: logContentNotStored() as unknown as InteractionRequest,
    });
    await turn("empty", "   ");
    await turn("sealed", "Unavailable", {
      encryptedChatConversationId: randomUUID(),
    });
    await scanAndScore({});
    expect(prompts).toEqual([]);
    expect(
      (await describeBackfill(organizationId)).backfill?.progress,
    ).toMatchObject({ noText: 3 });
    const reasons = vi
      .mocked(logger.info)
      .mock.calls.flatMap(([fields, message]) =>
        message === "[AutoRouting] Backfill session skipped"
          ? [(fields as { reason: string }).reason]
          : [],
      );
    expect(reasons.sort()).toEqual([
      "content_unavailable",
      "content_unavailable",
      "empty_user_text",
    ]);
  });

  test("persists scorer tokens in features and calculates cost from usage", async () => {
    server.use(
      http.post(JEV_ENDPOINT, () =>
        HttpResponse.json({
          ...ANSWERS,
          usage: { input_tokens: 1_000_000, output_tokens: 20 },
        }),
      ),
    );
    await turn("priced", "Implement input validation");
    await scanAndScore({});
    const [score] = await db.select().from(schema.routingHistoryScoresTable);
    expect(score).toMatchObject({
      features: { scorerUsage: { inputTokens: 1_000_000, outputTokens: 20 } },
    });
    expect(Number(score.scorerCost)).toBeCloseTo(0.042);
    expect((await describeBackfill(organizationId)).backfill).toMatchObject({
      spentCostUsd: 0.042,
    });
  });

  test("re-scores the system and tools stored on the opening request across API shapes", async () => {
    const states: Record<string, string>[] = [];
    server.use(
      http.post(JEV_ENDPOINT, async ({ request }) => {
        states.push(
          ((await request.json()) as { state: Record<string, string> }).state,
        );
        return HttpResponse.json(ANSWERS);
      }),
    );
    const system = "Review schema changes and locking.";
    const tool = {
      name: "inspect_schema",
      description: "Read table metadata.",
    };
    await turn("context-chat", "Review this migration", {
      request: {
        model: "gpt-4o",
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Review this migration" },
        ],
        tools: [
          {
            type: "function",
            function: {
              ...tool,
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });
    await turn("context-messages", "Review this migration", {
      type: "anthropic:messages",
      request: {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        system: [{ type: "text", text: system }],
        messages: [{ role: "user", content: "Review this migration" }],
        tools: [{ ...tool, input_schema: { type: "object", properties: {} } }],
      },
    });
    await turn("context-responses", "Review this migration", {
      type: "openai:responses",
      request: {
        model: "gpt-4o",
        input: [
          {
            role: "developer",
            content: [{ type: "input_text", text: system }],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "Review this migration" }],
          },
        ],
        tools: [
          {
            type: "function",
            ...tool,
            parameters: { type: "object", properties: {} },
          },
        ],
      },
    });

    await scanAndScore({});

    expect(states).toHaveLength(3);
    for (const state of states) {
      expect(state).toEqual({
        prompt: "Review this migration",
        system_prompt: system,
        tools: "Available tools: 1\ninspect_schema",
      });
    }
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
    await setAutoRoutingEnabled(organizationId, false);
    await setAutoRoutingEnabledViaService(organizationId, true);
    await runBackfill();
    await setAutoRoutingEnabledViaService(organizationId, false);
    await setAutoRoutingEnabledViaService(organizationId, true);
    await updateAutoRouter(organizationId, routerId, { budgetUsdPerDay: 45 });

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
        cancelled ??= cancelLatest();
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

  test("the history lists each job newest first, with what it scored; a scan replaced before scoring is left out", async () => {
    await sessions(4);
    await scanAndScore({ maxSessions: 4 });
    await turn("late", "One more task", {
      createdAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await scan();
    await scan();

    const { history } = await describeBackfill(organizationId);

    expect(history).toEqual([
      expect.objectContaining({
        phase: "scan",
        status: "scanned",
        foundSessions: 5,
        scoredSessions: null,
        startedByName: expect.any(String),
      }),
      expect.objectContaining({
        phase: "score",
        status: "done",
        foundSessions: 4,
        scoredSessions: 4,
        spentCostUsd: expect.any(Number),
      }),
    ]);
  });

  test("a session left pending by a stopped job counts for the job that scores it", async () => {
    await sessions(1);
    await scan();
    const scorerVersionId = (await activeSourceVersion()).id;
    const [session] = await RoutingHistoryModel.nextToScore({
      organizationId,
      windowStart: new Date(0),
      cutoff: new Date(),
      frameId: await latestFrameId(),
      maxSessions: 1,
      scorerVersionId,
      limit: 1,
    });
    const key = { historySessionId: session.id, scorerVersionId };
    const now = Date.now();
    // The stopped job reserved the call an hour ago; a later job settles it.
    await db.transaction((tx) => RoutingHistoryModel.takeAttempt(key, tx));
    await db
      .update(schema.routingHistoryScoresTable)
      .set({ createdAt: new Date(now - 60 * 60 * 1000) })
      .where(eq(schema.routingHistoryScoresTable.historySessionId, session.id));
    await db.transaction((tx) =>
      RoutingHistoryModel.recordScore(
        {
          ...key,
          status: "scored",
          features: {
            signals: {
              "jev-session": {
                version: scorerVersionId,
                tier_needed: [0.2, 0.5, 0.3],
                p_long: 0.1,
              },
            },
            client: "claude-code",
          },
          scorerCost: null,
        },
        tx,
      ),
    );

    const stopped = randomUUID();
    const later = randomUUID();
    const scored = await RoutingHistoryModel.scoredByJob(organizationId, [
      {
        id: stopped,
        scorerVersionId,
        startedAt: new Date(now - 2 * 60 * 60 * 1000),
        endedAt: new Date(now - 30 * 60 * 1000),
      },
      {
        id: later,
        scorerVersionId,
        startedAt: new Date(now - 10 * 60 * 1000),
        endedAt: null,
      },
    ]);

    expect(scored.get(stopped) ?? 0).toBe(0);
    expect(scored.get(later)).toBe(1);
  });

  test("oversized tool names fail terminally without spending the scorer budget", async () => {
    await turn("oversized", "Review this oversized agent", {
      request: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Review this oversized agent" }],
        tools: Array.from({ length: 10_000 }, (_, index) => ({
          type: "function" as const,
          function: { name: `tool_${index}`, parameters: { type: "object" } },
        })),
      },
    });
    await turn("valid", "Review this valid agent");

    await scanAndScore({ maxSessions: 2, maxCostUsd: 0.002 });

    expect(prompts).toEqual(["Review this valid agent"]);
    expect(await readings()).toEqual({ oversized: "failed", valid: "scored" });
    expect((await describeBackfill(organizationId)).backfill).toMatchObject({
      status: "done",
      spentCostUsd: 0.001,
      progress: { scored: 1 },
    });
    await runBackfill();
    expect(prompts).toHaveLength(1);
    expect(await readings()).toEqual({ oversized: "failed", valid: "scored" });
  });

  test("stops at the cost ceiling and still lets the next fit read what it scored", async () => {
    await sessions(6);
    const before = await AutoRouterModel.find(routerId);

    await scanAndScore({ maxSessions: 6, maxCostUsd: 0.002 });

    expect(prompts).toHaveLength(2);
    const { backfill } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({
      status: "done",
      error: "Stopped at the spending limit.",
      spentCostUsd: 0.002,
      progress: { scored: 2 },
    });
    expect((await AutoRouterModel.find(routerId))?.generation).toBeGreaterThan(
      before?.generation ?? 0,
    );
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
      scorerApiKeyId: organizationKeyId,
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
      frameId: await latestFrameId(),
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
    const window = async (scorerVersionId: string) =>
      readFitWindow({
        router: await liveRouter(),
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
    const trio = await AutoRouterModel.find(routerId);
    const [decision] = await db
      .insert(schema.routingDecisionsTable)
      .values({
        ...plannedDecision({
          organizationId,
          routerId,
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
      router: await liveRouter(),
      scorerVersionId,
      inputWatermark: new Date(),
    });

    expect(window).toMatchObject({ sessions: 2, pastSessions: 1 });
  });

  test("a router that does not use past sessions ignores the scanned backfill; the one that does reads it", async () => {
    await sessions(3);
    await scanAndScore({});
    const scorerVersionId = (await activeSourceVersion()).id;
    const cold = await ensureAutoRouter(organizationId, "auto:cold");
    const reading = async (router: Awaited<ReturnType<typeof liveRouter>>) => ({
      window: await readFitWindow({
        router,
        scorerVersionId,
        inputWatermark: new Date(),
      }),
      history: await readFitHistory({
        router,
        scorerVersionId,
        inputWatermark: new Date(),
        longContextThreshold: null,
      }),
    });

    const own = await reading(await liveRouter());
    const other = await reading(cold);

    expect(cold.learnFromPastSessions).toBe(false);
    expect(own.window).toMatchObject({ sessions: 3, pastSessions: 3 });
    expect(own.history.sample).toHaveLength(3);
    expect(other.window).toMatchObject({ sessions: 0, pastSessions: 0 });
    expect(other.history.sample).toHaveLength(0);
  });

  test("a scan is refused while no router learns from past sessions", async () => {
    await db
      .update(schema.autoRoutersTable)
      .set({ learnFromPastSessions: false })
      .where(eq(schema.autoRoutersTable.id, routerId));

    await expect(
      startBackfillScan(organizationId, userId, await seen()),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  /** A router of the organization that learns from past sessions but decides with another model than the default one. */
  async function customModelRouter(name: string) {
    const router = await ensureAutoRouter(organizationId, name, {
      learnFromPastSessions: true,
    });
    await db
      .update(schema.autoRoutersTable)
      .set({ scorerModel: "jev-custom-test" })
      .where(eq(schema.autoRoutersTable.id, router.id));
    return router.id;
  }

  test("a router reads past sessions only while it learns from them and decides with the default model", async () => {
    await sessions(3);
    await scanAndScore({});
    const learner = await ensureAutoRouter(organizationId, "auto:learner", {
      learnFromPastSessions: true,
    });
    const custom = await customModelRouter("auto:custom");
    const off = await ensureAutoRouter(organizationId, "auto:off");
    const reading = async (id: string) => {
      const router = await AutoRouterModel.find(id);
      if (!router) throw new Error("router does not exist");
      const window = await readFitWindow({
        router,
        scorerVersionId: (await activeSourceVersion(router.scorerModel)).id,
        inputWatermark: new Date(),
      });
      const described = await getAutoRouter(organizationId, id);
      return {
        pastSessions: window.pastSessions,
        learns: described.learnFromPastSessions,
        reads: described.readsPastSessions,
      };
    };

    expect(
      await Promise.all([routerId, learner.id, custom, off.id].map(reading)),
    ).toEqual([
      { pastSessions: 3, learns: true, reads: true },
      { pastSessions: 3, learns: true, reads: true },
      { pastSessions: 0, learns: true, reads: false },
      { pastSessions: 0, learns: false, reads: false },
    ]);
  });

  test("a scoring run's completion asks a fit of every router reading past sessions, and of no other", async () => {
    await sessions(2);
    await scan();
    const learner = await ensureAutoRouter(organizationId, "auto:learner", {
      learnFromPastSessions: true,
    });
    const ids = [
      routerId,
      learner.id,
      await customModelRouter("auto:custom"),
      (await ensureAutoRouter(organizationId, "auto:off")).id,
    ];
    const generations = () =>
      Promise.all(
        ids.map(
          async (id) => (await AutoRouterModel.find(id))?.generation ?? 0,
        ),
      );
    const before = await generations();
    await db
      .delete(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "auto_routing_fit"));

    await startScoring();
    await runBackfill();

    const after = await generations();
    expect(after.map((generation, i) => generation - before[i])).toEqual([
      1, 1, 0, 0,
    ]);
    const fits = await db
      .select({ payload: schema.tasksTable.payload })
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "auto_routing_fit"));
    expect(
      fits
        .map(({ payload }) => (payload as { routerId: string }).routerId)
        .sort(),
    ).toEqual([routerId, learner.id].sort());
  });

  test("a scoring run pays only with the organization key it pinned at admission; once that key is gone the run fails and keeps its scores", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await sessions(10);
    await scan();
    const secret = await makeSecret({ secret: { apiKey: "sk-another" } });
    await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "jev",
      isPrimary: false,
    });
    const authorizations: (string | null)[] = [];
    server.use(
      http.post(JEV_ENDPOINT, async ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        await db
          .delete(schema.llmProviderApiKeysTable)
          .where(eq(schema.llmProviderApiKeysTable.id, organizationKeyId));
        return HttpResponse.json(ANSWERS);
      }),
    );

    const started = await startScoring({ maxSessions: 10 });
    expect(started.scorerApiKeyId).toBe(organizationKeyId);
    await runBackfill();

    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "failed",
    );
    expect(authorizations.length).toBeGreaterThan(0);
    expect(new Set(authorizations)).toEqual(new Set(["Bearer sk-typesafe"]));
    const statuses = Object.values(await readings());
    expect(statuses).toContain("scored");
    expect(statuses).toContain("unscored");
  });

  test("a scoring run stops paying once the key it pinned is no longer shared with the whole organization", async () => {
    await sessions(10);
    await scan();
    const authorizations: (string | null)[] = [];
    server.use(
      http.post(JEV_ENDPOINT, async ({ request }) => {
        authorizations.push(request.headers.get("authorization"));
        await revokeOrganizationUse(organizationKeyId);
        return HttpResponse.json(ANSWERS);
      }),
    );

    await startScoring({ maxSessions: 10 });
    await runBackfill();

    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "failed",
    );
    expect(authorizations.length).toBeGreaterThan(0);
    expect(authorizations.length).toBeLessThan(10);
    const statuses = Object.values(await readings());
    expect(statuses).toContain("scored");
    expect(statuses).toContain("unscored");
  });

  test("admission pins the first organization-wide Jev key that resolves", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await sessions(2);
    await scan();
    // The primary key's secret is gone, so it no longer resolves.
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({ secretId: null })
      .where(eq(schema.llmProviderApiKeysTable.id, organizationKeyId));
    const secret = await makeSecret({ secret: { apiKey: "sk-secondary" } });
    const secondary = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "jev",
      isPrimary: false,
    });

    expect((await startScoring()).scorerApiKeyId).toBe(secondary.id);
  });

  test("a wildcard grant to everyone never makes a member's personal Jev key the payer", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await sessions(2);
    await scan();
    const everyKey = {
      organizationId,
      resource: "llmProviderApiKey",
      scope: "*",
    } as const;
    const policy = await ResourcePermissionPolicyModel.find(everyKey);
    await ResourcePermissionPolicyModel.replace({
      ...everyKey,
      revision: policy?.revision ?? 0,
      grants: [
        ...(policy?.grants ?? []),
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-personal" } });
    const personal = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "jev",
      userId,
      isPrimary: true,
    });
    // Ranked ahead of the organization's key.
    await db
      .update(schema.llmProviderApiKeysTable)
      .set({ createdAt: new Date(0) })
      .where(eq(schema.llmProviderApiKeysTable.id, personal.id));

    expect((await startScoring()).scorerApiKeyId).toBe(organizationKeyId);
  });

  test("a run whose payer loses its grant during the round that scores the last sessions still completes and refits", async () => {
    await sessions(3);
    await scan();
    server.use(
      http.post(JEV_ENDPOINT, async () => {
        await revokeOrganizationUse(organizationKeyId);
        return HttpResponse.json(ANSWERS);
      }),
    );

    await startScoring({ maxSessions: 3 });
    await runBackfill();

    expect(
      (await describeBackfill(organizationId, routerId)).backfill,
    ).toMatchObject({ status: "done", awaitingFit: true });
    expect(Object.values(await readings())).toEqual([
      "scored",
      "scored",
      "scored",
    ]);
  });

  describe("with Vault holding the key values", () => {
    const VAULT_SECRET =
      "http://vault.example.test/v1/secret/data/archestra/:name";
    const enterprise = config.enterpriseFeatures.core;
    let values: Map<string, string>;
    let vaultDown: boolean;

    beforeEach(async () => {
      config.enterpriseFeatures.core = true;
      vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_ADDR", "http://vault.example.test");
      vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_TOKEN", "example-vault-token");
      vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD", "TOKEN");
      vi.stubEnv("ARCHESTRA_HASHICORP_VAULT_KV_VERSION", "2");
      values = new Map();
      vaultDown = false;
      server.use(
        http.post(VAULT_SECRET, async ({ params, request }) => {
          const body = (await request.json()) as { data: { value: string } };
          values.set(String(params.name), body.data.value);
          return HttpResponse.json({ data: {} });
        }),
        http.get(VAULT_SECRET, ({ params }) => {
          if (vaultDown) return new HttpResponse(null, { status: 500 });
          const value = values.get(String(params.name));
          return value === undefined
            ? HttpResponse.json({ errors: [] }, { status: 404 })
            : HttpResponse.json({ data: { data: { value } } });
        }),
      );
      await secretManagerCoordinator.initialize(SecretsManagerType.Vault);
    });
    afterEach(async () => {
      await secretManagerCoordinator.initialize(SecretsManagerType.DB);
      vi.unstubAllEnvs();
      config.enterpriseFeatures.core = enterprise;
    });

    /** Gives the organization's key a Vault secret, then drops its value: the metadata row stays. */
    async function loseOrganizationKeyValue() {
      const secret = await secretManager().createSecret(
        { apiKey: "sk-gone" },
        "jev-primary",
      );
      await db
        .update(schema.llmProviderApiKeysTable)
        .set({ secretId: secret.id })
        .where(eq(schema.llmProviderApiKeysTable.id, organizationKeyId));
      values.clear();
    }

    test("admission passes over a key whose Vault value is gone to the next one that resolves", async ({
      makeLlmProviderApiKey,
    }) => {
      await sessions(2);
      await scan();
      await loseOrganizationKeyValue();
      const secret = await secretManager().createSecret(
        { apiKey: "sk-secondary" },
        "jev-secondary",
      );
      const secondary = await makeLlmProviderApiKey(organizationId, secret.id, {
        provider: "jev",
        isPrimary: false,
      });

      expect((await startScoring()).scorerApiKeyId).toBe(secondary.id);
    });

    test("admission fails while Vault itself fails, rather than passing over every key", async () => {
      await sessions(2);
      await scan();
      await loseOrganizationKeyValue();
      vaultDown = true;

      await expect(startScoring()).rejects.toMatchObject({ statusCode: 503 });
    });
  });

  test("a running job's description leaves the payer unread; an idle one reads it", async () => {
    await sessions(2);
    await scan();
    await startScoring();

    expect((await describeBackfill(organizationId)).payer).toBeNull();
    await runBackfill();
    expect((await describeBackfill(organizationId)).payer).toBe("ready");
  });

  test("scoring is refused without an organization-wide Jev key, even with a personal one", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    await sessions(2);
    await scan();
    await db
      .delete(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.id, organizationKeyId));
    const secret = await makeSecret({ secret: { apiKey: "sk-personal" } });
    await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "jev",
      userId,
    });
    expect((await describeBackfill(organizationId)).payer).toBe("no_jev_key");
    await expect(startScoring()).rejects.toMatchObject({ statusCode: 400 });
    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "scanned",
    );
    expect(prompts).toEqual([]);
  });

  test("an admin can count again right after a fresh scan whose sample is fully scored", async () => {
    await sessions(2);
    await scanAndScore({});
    const scored = await RoutingBackfillModel.findLatest(organizationId);
    expect((await describeBackfill(organizationId)).scoreOffer).toBeNull();

    await sessions(1, "new");
    await scan();

    const { backfill, scoreOffer } = await describeBackfill(organizationId);
    expect(backfill).toMatchObject({ phase: "scan", status: "scanned" });
    expect(backfill?.id).not.toBe(scored?.id);
    expect(scoreOffer).toMatchObject({ remaining: 1 });
  });

  test("a scan started from a view an admin saw before another scan is refused, and the newer scan keeps waiting", async () => {
    await sessions(2);
    await scanAndScore({});
    const stale = await seen();
    await sessions(1, "new");
    await scan();
    const waiting = await describeBackfill(organizationId);
    expect(waiting.scoreOffer).toMatchObject({ remaining: 1 });

    await expect(
      startBackfillScan(organizationId, userId, stale),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await describeBackfill(organizationId)).toEqual(waiting);
  });

  test("the offer bounds the scored sessions a sample can yield by those it skipped", async () => {
    await sessions(3);
    await turn("empty", "   ");
    await scanAndScore({});
    await sessions(1, "new");
    await scan();

    expect((await describeBackfill(organizationId)).scoreOffer).toMatchObject({
      sessions: 5,
      remaining: 1,
      usableSessions: 4,
    });
  });

  test("a stop names the phase it saw, so it never cancels the scoring that took over the scan", async () => {
    await sessions(2);
    await scan();
    const scanned = await RoutingBackfillModel.findLatest(organizationId);
    if (!scanned) throw new Error("No backfill");
    await startScoring();

    await expect(
      cancelBackfill(organizationId, scanned.id, "scan"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "running",
    );
    await cancelBackfill(organizationId, scanned.id, "score");
    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "cancelled",
    );
  });

  test("the expected traffic factor scales past traffic once, in fits, presets and budget checks alike", async ({
    makeOrganization,
  }) => {
    config.autoRouting.minSessions = 3;
    // Six sessions started over five days, each costing about $5 on the fast tier.
    for (let i = 0; i < 6; i++) {
      await turn(`heavy-${i}`, `Task number ${i}`, {
        createdAt: new Date(Date.now() - (2 + i) * DAY_MS),
        inputTokens: 5_000_000,
      });
    }
    await scanAndScore({});
    const perDay = 6 / 5;
    await AutoRouterModel.update(routerId, {
      budgetUsdPerDay: "1000.00",
      expectedTrafficFactor: 3,
    });

    const run = await runFit(routerId);
    expect(run?.published.plan.summary?.sessions_per_day).toBeCloseTo(
      3 * perDay,
    );
    const outcome = await RoutingPlanModel.findLatestOutcome(routerId);
    expect({
      factor: Number(outcome?.volumeFactor),
      source: outcome?.volumeSource,
    }).toEqual({ factor: 3, source: "history" });

    const simulated = async (body: Parameters<typeof simulateFit>[1]) => {
      const result = await simulateFit(routerId, body);
      if (result.status !== "feasible") {
        throw new Error(`The simulation is ${result.status}`);
      }
      return result.summary.sessions_per_day;
    };
    expect(
      await simulated({ budgetUsdPerDay: 1000, expectedTrafficFactor: 2 }),
    ).toBeCloseTo(2 * perDay);
    expect(
      await simulated({ budgetPreset: "balanced", expectedTrafficFactor: 2 }),
    ).toBeCloseTo(2 * perDay);
    // A raw multiplier stands in for the factor instead of compounding it.
    expect(
      await simulated({ budgetUsdPerDay: 1000, volumeMultiplier: 2 }),
    ).toBeCloseTo(2 * perDay);

    // About $6/day at the past rate, $18/day at three times it.
    const budget = { budgetUsdPerDay: 10 };
    await expect(
      updateAutoRouter(organizationId, routerId, budget),
    ).rejects.toMatchObject({ statusCode: 400 });
    await updateAutoRouter(organizationId, routerId, {
      ...budget,
      expectedTrafficFactor: 1,
    });

    const settings = await liveRouter();
    const tiers = await tiersBody(organizationId, {
      fast: { id: settings.fastModelId ?? "", provider: "openai" },
      normal: { id: settings.normalModelId ?? "", provider: "openai" },
      smart: { id: settings.smartModelId ?? "", provider: "openai" },
    });
    const create = (name: string, learnFromPastSessions: boolean) =>
      createAutoRouter(organizationId, {
        name,
        tiers,
        budgetUsdPerDay: 10,
        expectedTrafficFactor: 3,
        learnFromPastSessions,
      });
    await expect(create("auto:busy", true)).rejects.toMatchObject({
      statusCode: 400,
    });
    // Checked as if routing were on, so it cannot be created over budget while it is off.
    await setAutoRoutingEnabled(organizationId, false);
    await expect(create("auto:busy-off", true)).rejects.toMatchObject({
      statusCode: 400,
    });
    await setAutoRoutingEnabled(organizationId, true);
    expect(await create("auto:cold", false)).toMatchObject({
      fit: { status: "cold_start" },
    });
    // Without past sessions to check it on, a router is created cold.
    const empty = (await makeOrganization()).id;
    await configureAutoRouting(empty);
    const emptySettings = await AutoRouterModel.find(await autoRouterId(empty));
    expect(
      await createAutoRouter(empty, {
        name: "auto:new",
        budgetUsdPerDay: 0.01,
        expectedTrafficFactor: 3,
        tiers: await tiersBody(empty, {
          fast: { id: emptySettings?.fastModelId ?? "", provider: "openai" },
          normal: {
            id: emptySettings?.normalModelId ?? "",
            provider: "openai",
          },
          smart: { id: emptySettings?.smartModelId ?? "", provider: "openai" },
        }),
      }),
    ).toMatchObject({ fit: { status: "cold_start" } });
  });

  test("an unrequested fit names the backfill when it reads another frame than the last fit did", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(4, "early");
    await scanAndScore({});
    const [early] = await scanFrames();
    expect((await runFit(routerId))?.inputs).toMatchObject({
      trigger: "backfill",
      history: { frameId: early.id },
    });

    await AutoRouterModel.update(routerId, { budgetUsdPerDay: "45.00" });
    expect((await runFit(routerId))?.inputs.trigger).toBe("settings");

    await sessions(8, "late");
    await scanAndScore({});
    const [, late] = await scanFrames();
    expect((await runFit(routerId))?.inputs).toMatchObject({
      trigger: "backfill",
      history: { frameId: late.id },
    });

    // An outcome recorded before fits stored their frame says nothing about it.
    await db
      .update(schema.routingPlansTable)
      .set({ volumeSource: null, historyFrameId: null })
      .where(eq(schema.routingPlansTable.routerId, routerId));
    await AutoRouterModel.update(routerId, { budgetUsdPerDay: "46.00" });
    expect((await runFit(routerId))?.inputs.trigger).toBe("settings");
  });

  test("a fit after the backfill learns from it at the population's volume; one started before cannot publish", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(6);
    await scan();
    await startScoring({ maxSessions: 3 });
    const before = await prepareFit(routerId);

    await runBackfill();

    const stale = before && (await completeFit(before));
    expect(stale).toMatchObject({
      kind: "rejected",
      reason: "stale_generation",
    });
    const run = await runFit(routerId);
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
    const window = async () =>
      readFitWindow({
        router: await liveRouter(),
        scorerVersionId,
        inputWatermark: new Date(),
      });
    expect(await window()).toMatchObject({
      sessions: 3,
      volumeSource: "history",
    });

    const settings = await AutoRouterModel.find(routerId);
    await seedFitHistory({
      organizationId,
      routerId,
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

  test("a router with enough sessions of its own is fitted on them alone", async () => {
    config.autoRouting.minSessions = 10;
    await sessions(3);
    await scanAndScore({});
    const scorerVersionId = (await activeSourceVersion()).id;
    const settings = await AutoRouterModel.find(routerId);
    const seed = (count: number) =>
      seedFitHistory({
        organizationId,
        routerId,
        modelId: settings?.normalModelId ?? "",
        scorerVersionId,
        sessions: count,
      });
    const history = async () =>
      readFitHistory({
        router: await liveRouter(),
        scorerVersionId,
        inputWatermark: new Date(),
        longContextThreshold: null,
      });

    await seed(9);
    const borrowing = await history();
    expect(borrowing).toMatchObject({ sessions: 12, pastSessions: 3 });
    expect(borrowing.sample).toHaveLength(12);

    await seed(1);
    const own = await history();
    expect(own).toMatchObject({
      sessions: 10,
      pastSessions: 0,
      volumeSource: "live",
    });
    expect(own.sample).toHaveLength(10);
  });

  test("a router fitted on its own sessions keeps the past volume until they span a week", async () => {
    config.autoRouting.minSessions = 5;
    await sessions(3);
    await scanAndScore({});
    const scorerVersionId = (await activeSourceVersion()).id;
    const settings = await AutoRouterModel.find(routerId);
    await seedFitHistory({
      organizationId,
      routerId,
      modelId: settings?.normalModelId ?? "",
      scorerVersionId,
      sessions: 5,
      session: (i) => ({
        features: {
          signals: {
            "jev-session": {
              version: scorerVersionId,
              tier_needed: [0.2, 0.5, 0.3],
              p_long: 0.1,
            },
          },
          client: "claude-code",
        },
        createdAt: new Date(Date.now() - (2 + i) * DAY_MS),
      }),
    });

    const history = await readFitHistory({
      router: await liveRouter(),
      scorerVersionId,
      inputWatermark: new Date(),
      longContextThreshold: null,
    });

    expect(history).toMatchObject({
      sessions: 5,
      pastSessions: 0,
      volumeSource: "history",
      volume: { sessions: 3 },
    });
    expect(history.sample).toHaveLength(5);
  });

  describe("past sessions count toward the minimum only once they start a router sooner than its own would", () => {
    // Ten sessions above the live minimum, so a router with eleven past
    // sessions and 199 of its own starts one session sooner.
    beforeEach(() => {
      config.autoRouting.minSessions = LIVE_MIN_SESSIONS + 10;
    });

    const window = async (router?: Awaited<ReturnType<typeof liveRouter>>) => {
      const { sessions, minSessions, pastSessions } = await readFitWindow({
        router: router ?? (await liveRouter()),
        scorerVersionId: (await activeSourceVersion()).id,
        inputWatermark: new Date(),
      });
      return { sessions, minSessions, pastSessions };
    };

    test("too few leave the router on its own minimum", async () => {
      await sessions(8);
      await scanAndScore({});

      expect(await window()).toEqual({
        sessions: 0,
        minSessions: LIVE_MIN_SESSIONS,
        pastSessions: 0,
      });
      expect((await describeBackfill(organizationId)).pastSessionsNeeded).toBe(
        11,
      );
    });

    test("as many as the live minimum leaves still count none: the router would reach both minimums together", async () => {
      await sessions(10);
      await scanAndScore({});

      expect(await window()).toMatchObject({
        minSessions: LIVE_MIN_SESSIONS,
        pastSessions: 0,
      });
    });

    test("enough count toward the configured minimum, but not for a router that does not read them", async () => {
      await sessions(11);
      await scanAndScore({});
      const cold = await ensureAutoRouter(organizationId, "auto:cold");

      expect(await window()).toEqual({
        sessions: 11,
        minSessions: LIVE_MIN_SESSIONS + 10,
        pastSessions: 11,
      });
      expect(await window(cold)).toMatchObject({
        minSessions: LIVE_MIN_SESSIONS,
        pastSessions: 0,
      });
      const progress = {
        sessions: 11,
        required: LIVE_MIN_SESSIONS + 10,
        pastSessions: 11,
      };
      expect(
        (await getAutoRouter(organizationId, routerId)).status.coldStart,
      ).toMatchObject(progress);
      expect(
        await simulateFit(routerId, {
          budgetUsdPerDay: 10,
          volumeMultiplier: 1,
        }),
      ).toEqual({
        status: "cold_start",
        ...progress,
      });
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
    const before = await AutoRouterModel.find(routerId);
    await db.execute(sql`
      create function fail_generation() returns trigger language plpgsql
      as $$ begin raise exception 'generation bump failed'; end $$`);
    await db.execute(sql`
      create trigger fail_generation before update of generation on auto_routers
      for each row execute function fail_generation()`);

    await runBackfill();
    expect((await describeBackfill(organizationId)).backfill?.status).toBe(
      "running",
    );
    await db.execute(sql`drop trigger fail_generation on auto_routers`);
    await runBackfill();

    const after = await AutoRouterModel.find(routerId);
    expect(after?.generation).toBe((before?.generation ?? 0) + 1);
    expect(
      (await describeBackfill(organizationId, routerId)).backfill,
    ).toMatchObject({
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
    await runFit(routerId);
    expect(
      (await describeBackfill(organizationId, routerId)).backfill?.awaitingFit,
    ).toBe(false);
  });

  test("a router still awaits the fit its scoring asked for after a later scan becomes the backfill shown", async () => {
    await sessions(3);
    await scanAndScore({});
    await sessions(2, "later");
    await scan();

    const { backfill } = await describeBackfill(organizationId, routerId);
    expect(backfill).toMatchObject({ phase: "scan", awaitingFit: true });
    await runFit(routerId);
    expect(
      (await describeBackfill(organizationId, routerId)).backfill?.awaitingFit,
    ).toBe(false);
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

  /** The scan publications, oldest first. */
  async function scanFrames() {
    return db
      .select({ id: schema.routingBackfillsTable.id })
      .from(schema.routingBackfillsTable)
      .where(eq(schema.routingBackfillsTable.organizationId, organizationId))
      .orderBy(schema.routingBackfillsTable.createdAt);
  }

  /** The gap-free run of scored sessions, in rank order, among those the scans up to `frameId` found. */
  async function scoredPrefix(frameId: string) {
    const ranked = await db.execute<{ attempted: boolean }>(sql`
      select exists (
        select 1 from routing_history_scores sc where sc.history_session_id = s.id
      ) as attempted
      from routing_history_sessions s
      join routing_backfills b on b.id = s.backfill_id
      where s.organization_id = ${organizationId}
        and b.scanned_at <= (select scanned_at from routing_backfills where id = ${frameId})
      order by s.sample_rank, s.id`);
    const gap = ranked.rows.findIndex((row) => !row.attempted);
    return gap === -1 ? ranked.rows.length : gap;
  }

  /** Ranks the sessions the newest scan found `where` the organization's others are: ahead of or behind every one. */
  async function rankLatestScan(where: "ahead" | "behind") {
    const rank =
      where === "ahead"
        ? sql`(select min(sample_rank) - 1 from routing_history_sessions)`
        : sql`(select max(sample_rank) + 1 from routing_history_sessions)`;
    await db.execute(sql`
      update routing_history_sessions set sample_rank = ${rank}
      where backfill_id = ${await latestFrameId()}`);
  }

  async function pastSample() {
    const inputs = await prepareFit(routerId);
    if (!inputs) throw new Error("Auto routing is not configured");
    const weights = inputs.history.sample.map((row) => row.weight);
    return {
      frameId: inputs.history.frameId,
      sessions: inputs.history.pastSessions,
      sample: weights.length,
      weight: weights.reduce((total, weight) => total + weight, 0),
    };
  }

  test("a fit learns from one frame: the scan with the longest gap-free rank prefix, the newest on a tie, at its population's weight", async () => {
    await sessions(4, "early");
    await scanAndScore({ maxSessions: 4 });
    await sessions(8, "late");
    await scan();
    await rankLatestScan("behind");
    const [early, late] = await scanFrames();
    expect(await scoredPrefix(early.id)).toBe(4);
    expect(await scoredPrefix(late.id)).toBe(4);

    expect(await pastSample()).toEqual({
      frameId: late.id,
      sessions: 4,
      sample: 4,
      weight: expect.closeTo(12),
    });
  });

  test("a rescan keeps the scored frame until its own scored prefix is as long", async () => {
    await sessions(4, "early");
    await scanAndScore({ maxSessions: 4 });
    const [early] = await scanFrames();
    expect(await pastSample()).toMatchObject({
      frameId: early.id,
      sessions: 4,
    });

    await sessions(8, "late");
    await scan();
    await rankLatestScan("ahead");
    const [, late] = await scanFrames();
    expect(await scoredPrefix(late.id)).toBe(0);
    expect(await pastSample()).toMatchObject({
      frameId: early.id,
      sessions: 4,
    });

    await startScoring({ maxSessions: 12 });
    await runBackfill();
    expect(await scoredPrefix(late.id)).toBe(12);
    expect(await pastSample()).toEqual({
      frameId: late.id,
      sessions: 12,
      sample: 12,
      weight: expect.closeTo(12),
    });
  });

  test("a router keeps the frame its plan was fitted on through more unscored rescans than the newest frames a fit compares", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(4, "early");
    await scanAndScore({ maxSessions: 4 });
    const [early] = await scanFrames();
    await runFit(routerId);
    expect((await RoutingPlanModel.findActive(routerId))?.historyFrameId).toBe(
      early.id,
    );

    for (let rescan = 0; rescan < 6; rescan++) {
      await sessions(1, `rescan-${rescan}`);
      await scan();
      // Ranked ahead of every scored session, so no later frame has a scored prefix.
      await rankLatestScan("ahead");
    }
    const frames = await scanFrames();
    expect(frames).toHaveLength(7);
    expect(await scoredPrefix(frames[6].id)).toBe(0);

    expect(await pastSample()).toMatchObject({
      frameId: early.id,
      sessions: 4,
    });
  });

  test("diagnostics replay the past sessions the active plan read, whatever the router reads now, and say so once they are gone", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(4, "early");
    await scanAndScore({ maxSessions: 4 });
    const [early] = await scanFrames();
    await runFit(routerId);
    expect(await RoutingPlanModel.findActive(routerId)).toMatchObject({
      historyFrameId: early.id,
      volumeSource: "history",
    });
    const fitted = await diagnoseAutoRouting(
      await liveRouter(),
      undefined,
      true,
    );
    expect(fitted.status).toBe("ready");

    await db
      .update(schema.autoRoutersTable)
      .set({ learnFromPastSessions: false })
      .where(eq(schema.autoRoutersTable.id, routerId));
    await forgetDiagnosticsBasis();
    expect(
      await diagnoseAutoRouting(await liveRouter(), undefined, true),
    ).toEqual(fitted);

    await db
      .delete(schema.routingBackfillsTable)
      .where(eq(schema.routingBackfillsTable.id, early.id));
    expect(
      await diagnoseAutoRouting(await liveRouter(), undefined, true),
    ).toEqual({
      status: "basis_unavailable",
    });
  });

  test("diagnostics replay the past sessions a plan counted after the minimum rises above what they make up", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(4);
    await scanAndScore({ maxSessions: 4 });
    await runFit(routerId);
    expect(await RoutingPlanModel.findActive(routerId)).toMatchObject({
      diagnostics: { history: { past_sessions: 4 } },
    });
    const fitted = await diagnoseAutoRouting(
      await liveRouter(),
      undefined,
      true,
    );
    expect(fitted.status).toBe("ready");

    config.autoRouting.minSessions = 1000;
    await forgetDiagnosticsBasis();

    expect(
      await diagnoseAutoRouting(await liveRouter(), undefined, true),
    ).toEqual(fitted);
  });

  test("diagnostics show past sessions one by one only to a caller who may read the organization's logs", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(4);
    await scanAndScore({ maxSessions: 4 });
    await runFit(routerId);

    const shown = await diagnoseAutoRouting(
      await liveRouter(),
      undefined,
      true,
    );
    const hidden = await diagnoseAutoRouting(
      await liveRouter(),
      undefined,
      false,
    );

    if (shown.status !== "ready") throw new Error(shown.status);
    expect(shown.sessions).toHaveLength(4);
    expect(hidden).toEqual({ ...shown, sessions: [] });
  });

  test("diagnostics say the basis is gone once retention drops part of the past sessions the plan read", async () => {
    config.autoRouting.minSessions = 3;
    await sessions(4);
    await scanAndScore({ maxSessions: 4 });
    await runFit(routerId);
    expect(
      (await diagnoseAutoRouting(await liveRouter(), undefined, true)).status,
    ).toBe("ready");

    // The oldest of them started five days ago.
    await RoutingHistoryModel.purgeExpired({
      windowStart: new Date(Date.now() - 4.5 * DAY_MS),
      keepScorerVersionId: (await activeSourceVersion()).id,
    });
    await forgetDiagnosticsBasis();

    expect(
      await diagnoseAutoRouting(await liveRouter(), undefined, true),
    ).toEqual({
      status: "basis_unavailable",
    });
  });

  test("diagnostics replay a plan fitted on the router's own sessions after the frame it saw is gone", async () => {
    config.autoRouting.minSessions = 10;
    await sessions(3);
    await scanAndScore({});
    const settings = await AutoRouterModel.find(routerId);
    await seedFitHistory({
      organizationId,
      routerId,
      modelId: settings?.normalModelId ?? "",
      scorerVersionId: (await activeSourceVersion()).id,
      sessions: 10,
    });
    await runFit(routerId);
    expect(await RoutingPlanModel.findActive(routerId)).toMatchObject({
      historyFrameId: await latestFrameId(),
      volumeSource: "live",
      diagnostics: { history: { past_sessions: 0 } },
    });
    const fitted = await diagnoseAutoRouting(
      await liveRouter(),
      undefined,
      true,
    );
    expect(fitted.status).toBe("ready");

    await db
      .delete(schema.routingBackfillsTable)
      .where(eq(schema.routingBackfillsTable.organizationId, organizationId));

    expect(
      await diagnoseAutoRouting(await liveRouter(), undefined, true),
    ).toEqual(fitted);
  });

  test("a frame never takes in sessions a later scan found, even ones that started inside its window", async () => {
    await sessions(4, "early");
    await scanAndScore({ maxSessions: 4 });
    const [early] = await scanFrames();
    // Ingested after the first scan, but started before its newest session.
    await sessions(8, "late");
    await scan();

    const frame = await RoutingBackfillModel.findScanFrame(
      organizationId,
      early.id,
    );
    if (!frame) throw new Error("The first scan is not a frame");
    const snapshot = await RoutingHistoryModel.findFitSnapshot({
      organizationId,
      scorerVersionId: (await activeSourceVersion()).id,
      longContextThreshold: null,
      frame,
      windowStart: new Date(0),
      withSample: true,
    });
    expect(snapshot.population.sessions).toBe(4);
    expect(snapshot.scored).toBe(4);
  });

  test("a capped live sample and the past sample each stand for their whole window", async () => {
    await sessions(6);
    await scanAndScore({ maxSessions: 3 });
    const settings = await AutoRouterModel.find(routerId);
    await seedFitHistory({
      organizationId,
      routerId,
      modelId: settings?.normalModelId ?? "",
      scorerVersionId: (await activeSourceVersion()).id,
      sessions: 10,
    });

    const inputs = await prepareFit(routerId, undefined, 5);

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

  test("score cleanup retains the default and active-backfill scorers across batches, not routers' own", async ({
    makeOrganization,
  }) => {
    await sessions(1);
    await scan();
    const keep = (await activeSourceVersion()).id;
    const [own, foreign, unused, anotherUnused, active] = await Promise.all(
      Array.from({ length: 5 }, () => makeScorerVersion()),
    );
    const foreignRouter = await ensureAutoRouter((await makeOrganization()).id);
    for (const [router, scorer] of [
      [{ id: routerId }, own],
      [foreignRouter, foreign],
    ]) {
      await db
        .update(schema.autoRoutersTable)
        .set({ scorerVersionId: scorer.id })
        .where(eq(schema.autoRoutersTable.id, router.id));
    }
    const [session] = await db
      .select()
      .from(schema.routingHistorySessionsTable);
    await db.insert(schema.routingHistoryScoresTable).values(
      [{ id: keep }, own, foreign, unused, anotherUnused, active].map(
        (scorer) => ({
          historySessionId: session.id,
          scorerVersionId: scorer.id,
          status: "no_text" as const,
        }),
      ),
    );
    const running = await RoutingBackfillModel.startScore({
      id: session.backfillId,
      organizationId,
      scorerVersionId: active.id,
      scorerApiKeyId: organizationKeyId,
      maxSessions: 1,
      maxCostUsd: 1,
      startedBy: null,
    });
    expect(running?.status).toBe("running");

    expect(
      await RoutingHistoryModel.purgeExpired({
        windowStart: new Date(Date.now() - 35 * DAY_MS),
        keepScorerVersionId: keep,
        batchSize: 1,
      }),
    ).toEqual({ sessions: 0, scores: 4, backfills: 0 });
    const remaining = await db.select().from(schema.routingHistoryScoresTable);
    expect(remaining.map((score) => score.scorerVersionId).sort()).toEqual(
      [keep, active.id].sort(),
    );
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
      expect(
        (await describeBackfill(organizationId, routerId)).backfill,
      ).toMatchObject({
        awaitingFit: true,
        fitBlockedReason: null,
      });
    });

    const fitState = async () => {
      const { backfill } = await describeBackfill(organizationId, routerId);
      return {
        awaitingFit: backfill?.awaitingFit,
        blocked: backfill?.fitBlockedReason !== null,
      };
    };

    test("as blocked once auto routing is off", async () => {
      await setAutoRoutingEnabled(organizationId, false);
      await handleAutoRoutingFit({ routerId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: true });
    });

    test("as blocked without a daily budget", async () => {
      await AutoRouterModel.update(routerId, {
        budgetUsdPerDay: null,
      });
      await handleAutoRoutingFit({ routerId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: true });
    });

    test("as blocked when a tier's model is gone", async () => {
      const settings = await AutoRouterModel.find(routerId);
      await db
        .delete(schema.modelsTable)
        .where(eq(schema.modelsTable.id, settings?.fastModelId ?? ""));
      await handleAutoRoutingFit({ routerId });
      expect(await fitState()).toEqual({ awaitingFit: false, blocked: true });
    });

    test("as planned after a rejected fit, by the refit", async () => {
      const stale = await prepareFit(routerId);
      if (!stale) throw new Error("Auto routing is not configured");
      await AutoRouterModel.update(routerId, {
        budgetUsdPerDay: "45.00",
      });
      expect(await completeFit(stale)).toMatchObject({ kind: "rejected" });
      expect(await fitState()).toEqual({ awaitingFit: true, blocked: false });

      await handleAutoRoutingFit({ routerId });
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
        await handleAutoRoutingFit({ routerId });
      } finally {
        await db.execute(sql`drop trigger fail_plan on routing_plans`);
      }

      expect(await fitState()).toEqual({ awaitingFit: false, blocked: false });
      const [plan] = await RoutingPlanModel.findHistory(routerId, 1);
      expect(plan.plan.status).toBe("failed");
    });
  });

  test("the fit a completion requested stays awaited until a fit plans its generation, whenever an older one recorded its outcome", async () => {
    await sessions(2);
    await scan();
    await startScoring();
    const older = await prepareFit(routerId);
    if (!older) throw new Error("Auto routing is not configured");
    expect(await completeFit(older)).toMatchObject({ kind: "recorded" });
    await runBackfill();
    const outcome = await RoutingPlanModel.findLatestOutcome(routerId);
    if (!outcome) throw new Error("The older fit recorded no outcome");
    // The completion's stamp is its transaction's start, which can precede
    // an outcome the older generation's fit recorded while holding the lock.
    await db
      .update(schema.routingBackfillsTable)
      .set({ completedAt: new Date(outcome.createdAt.getTime() - 1000) })
      .where(eq(schema.routingBackfillsTable.organizationId, organizationId));
    expect(
      (await describeBackfill(organizationId, routerId)).backfill,
    ).toMatchObject({ awaitingFit: true });

    await handleAutoRoutingFit({ routerId });
    expect(
      (await describeBackfill(organizationId, routerId)).backfill,
    ).toMatchObject({ awaitingFit: false });
  });

  test("the score offer counts the sample as it is now, not as the scan found it", async () => {
    await sessions(2);
    await scanAndScore({});
    expect((await describeBackfill(organizationId)).scoreOffer).toBeNull();
    const [oldest] = await db
      .select({ id: schema.routingHistorySessionsTable.id })
      .from(schema.routingHistorySessionsTable)
      .orderBy(schema.routingHistorySessionsTable.startedAt)
      .limit(1);
    await db
      .delete(schema.routingHistorySessionsTable)
      .where(eq(schema.routingHistorySessionsTable.id, oldest.id));

    expect((await describeBackfill(organizationId)).scoreOffer).toBeNull();
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
    await startBackfillScan(organizationId, userId, await seen());
    await cancelLatest();

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
