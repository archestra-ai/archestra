import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { LlmUsageRollupModel } from "@/models";
import type { UsageWindow } from "@/models/llm-usage-rollup";
import { llmUsageRollup } from "@/services/llm-usage-rollup";
import { describe, expect, test } from "@/test";

describe("LlmUsageRollupModel", () => {
  test("rolled hours read the same rows as raw interactions", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    await seedMixedUsage({
      makeInteraction,
      agentId: agent.id,
      organizationId,
    });

    await drain();
    const window = (await LlmUsageRollupModel.window("7d")) as UsageWindow;

    expect(window.served).not.toBeNull();
    expect(await rolledHourCount()).toBeGreaterThan(0);
    expect(await factRows(window)).toEqual(await factRows(rawOnly(window)));
  });

  test("a change to a rolled hour is read from raw rows until it is recomputed", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    const row = await makeInteraction(agent.id, {
      createdAt: hoursAgo(5),
      cost: "1",
      model: "gpt-4o",
    });
    await drain();

    await db
      .update(schema.interactionsTable)
      .set({ cost: "4" })
      .where(eq(schema.interactionsTable.id, row.id));

    const window = (await LlmUsageRollupModel.window("7d")) as UsageWindow;
    expect(await markedHours()).toEqual([hourOf(row.createdAt)]);
    expect(await totalCost(window)).toBe(4);

    await drain();
    expect(await markedHours()).toEqual([]);
    expect(await totalCost(window)).toBe(4);
  });

  test("marks the hours of rollup-relevant changes only", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
    makeUser,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    const leaver = await makeUser();
    const attributed = await makeInteraction(agent.id, {
      createdAt: hoursAgo(11),
      userId: leaver.id,
    });
    const repriced = await makeInteraction(agent.id, {
      createdAt: hoursAgo(10),
    });
    const previewed = await makeInteraction(agent.id, {
      createdAt: hoursAgo(9),
    });
    const deleted = await makeInteraction(agent.id, { createdAt: hoursAgo(8) });
    const receipted = await makeInteraction(agent.id, {
      createdAt: hoursAgo(7),
    });
    await insertReceipt({
      interactionId: receipted.id,
      organizationId,
      components: [{ model: "gpt-4o", kind: "message", cost: "1" }],
    });
    await drain();
    expect(await markedHours()).toEqual([]);

    await db
      .update(schema.interactionsTable)
      .set({ sessionPreview: { firstUserMessage: "hi" } as never })
      .where(eq(schema.interactionsTable.id, previewed.id));
    await makeInteraction(agent.id, {}); // stamped now: settles on its own
    expect(await markedHours()).toEqual([]);

    await db
      .update(schema.interactionsTable)
      .set({ cost: "2" })
      .where(eq(schema.interactionsTable.id, repriced.id));
    await db
      .delete(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, deleted.id));
    await db
      .update(schema.interactionBillingTable)
      .set({
        usage: receiptUsage([{ model: "o3", kind: "message", cost: "3" }]),
      })
      .where(eq(schema.interactionBillingTable.interactionId, receipted.id));
    const backdated = await makeInteraction(agent.id, {
      createdAt: hoursAgo(6),
    });
    // Deleting a user sets its interactions' user_id to NULL.
    await db
      .delete(schema.usersTable)
      .where(eq(schema.usersTable.id, leaver.id));

    expect(await markedHours()).toEqual(
      [attributed, repriced, deleted, receipted, backdated].map((r) =>
        hourOf(r.createdAt),
      ),
    );
  });

  test("a bulk update marks each hour once, inside a savepoint too", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    // Rows of two hours, interleaved.
    const hour = new Date(hoursAgo(8).setUTCMinutes(0, 0, 0));
    const rows = [];
    for (const minutes of [10, 130, 20, 140, 30, 150]) {
      rows.push(
        await makeInteraction(agent.id, {
          createdAt: new Date(hour.getTime() + minutes * 60_000),
        }),
      );
    }
    await drain();

    await db.transaction(async (tx) => {
      await tx.transaction(async (savepoint) => {
        for (const [index, row] of rows.entries()) {
          await savepoint
            .update(schema.interactionsTable)
            .set({ cost: String(index + 1) })
            .where(eq(schema.interactionsTable.id, row.id));
        }
      });
    });

    const marks = await db.select().from(schema.llmUsageRollupDirtyTable);
    expect(marks.map((mark) => mark.version)).toEqual([1, 1]);
  });

  test("a change committed during a recompute keeps its hour marked", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    const first = await makeInteraction(agent.id, { createdAt: hoursAgo(3) });
    const second = await makeInteraction(agent.id, {
      createdAt: new Date(first.createdAt.getTime() + 1000),
    });
    await drain();
    await db
      .update(schema.interactionsTable)
      .set({ cost: "1" })
      .where(eq(schema.interactionsTable.id, first.id));

    const read = await LlmUsageRollupModel.nextMarkedHour();
    await db
      .update(schema.interactionsTable)
      .set({ cost: "2" })
      .where(eq(schema.interactionsTable.id, second.id));
    await LlmUsageRollupModel.recomputeMarkedHour(
      read as NonNullable<typeof read>,
    );

    const [mark] = await db.select().from(schema.llmUsageRollupDirtyTable);
    expect(mark.settleAfter).toBeNull();
    await drain();
    expect(await markedHours()).toEqual([]);
    const window = (await LlmUsageRollupModel.window("7d")) as UsageWindow;
    expect(await totalCost(window)).toBe(3);
  });

  test("changes to the hour being written do not hold back rolling", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    const old = await makeInteraction(agent.id, { createdAt: hoursAgo(6) });
    const current = await makeInteraction(agent.id, {});
    for (const cost of ["1", "2", "3"]) {
      await db
        .update(schema.interactionsTable)
        .set({ cost })
        .where(eq(schema.interactionsTable.id, current.id));
    }

    await drain();

    const [state] = await db.select().from(schema.llmUsageRollupStateTable);
    expect(state.rolledThrough?.getTime()).toBeGreaterThan(
      old.createdAt.getTime(),
    );
    // The current hour's mark waits until the hour is rolled.
    expect(await markedHours()).toEqual([hourOf(current.createdAt)]);
  });

  test("a whole day is read from daily rows, and its hours while one is marked", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - 2);
    const at = (hours: number) => new Date(day.getTime() + hours * 3600_000);
    const early = await makeInteraction(agent.id, {
      createdAt: at(3),
      cost: "1",
    });
    await makeInteraction(agent.id, { createdAt: at(15), cost: "2" });
    await drain();

    const window = (await LlmUsageRollupModel.window("30d")) as UsageWindow;
    expect(window.served?.days).not.toBeNull();
    expect(await dailyCost(day)).toBe(3);
    expect(await totalCost(window)).toBe(3);

    await db
      .update(schema.interactionsTable)
      .set({ cost: "5" })
      .where(eq(schema.interactionsTable.id, early.id));
    expect(await totalCost(window)).toBe(7);

    await drain();
    expect(await markedHours()).toEqual([]);
    expect(await dailyCost(day)).toBe(7);
    expect(await totalCost(window)).toBe(7);
  });

  test("a custom range reads its partial first and last hours raw", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const agent = await makeAgent({ organizationId });
    const start = new Date(hoursAgo(20).setUTCMinutes(30, 0, 0));
    const end = new Date(hoursAgo(10).setUTCMinutes(15, 0, 0));
    await seedMixedUsage({
      makeInteraction,
      agentId: agent.id,
      organizationId,
      at: [
        new Date(start.getTime() - 1000), // before the range
        start, // first instant
        new Date(start.getTime() + 3600_000),
        end, // last instant (inclusive)
        new Date(end.getTime() + 1000), // after the range
      ],
    });
    await drain();

    const window = (await LlmUsageRollupModel.window(
      `custom:${start.toISOString()}_${end.toISOString()}`,
    )) as UsageWindow;

    expect(window.served).toEqual({
      from: hourOf(new Date(start.getTime() + 3600_000)),
      to: hourOf(end),
      days: null,
    });
    expect(await factRows(window)).toEqual(await factRows(rawOnly(window)));
    expect(await requestCount(window)).toBe(3 * MIXED_ROWS_PER_INSTANT);
  });
});

// =============================================================================
// Helpers
// =============================================================================

const MIXED_ROWS_PER_INSTANT = 3;

/**
 * Per instant: a two-model receipt, a subscription request with estimated
 * input, and a labelled request without a receipt.
 */
async function seedMixedUsage(params: {
  makeInteraction: (
    profileId: string,
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  agentId: string;
  organizationId: string;
  at?: Date[];
}) {
  const instants = params.at ?? [hoursAgo(30), hoursAgo(29.5), hoursAgo(4)];
  for (const createdAt of instants) {
    const receipted = await params.makeInteraction(params.agentId, {
      createdAt,
      model: "claude-sonnet",
      inputTokens: 900,
      outputTokens: 30,
      cost: "9",
      baselineCost: "11",
      cacheSavings: "0.5",
    });
    await insertReceipt({
      interactionId: receipted.id,
      organizationId: params.organizationId,
      components: [
        { model: "claude-sonnet", kind: "message", cost: "7" },
        { model: "claude-haiku", kind: "advisor_message", cost: "2" },
      ],
    });
    await params.makeInteraction(params.agentId, {
      createdAt,
      model: "gpt-4o",
      inputTokens: 50,
      inputTokensEstimated: true,
      outputTokens: 5,
      cost: "0.25",
      billingMode: "subscription",
    });
    await params.makeInteraction(params.agentId, {
      createdAt,
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 1,
      cost: "0.1",
      attemptOutcome: "failed_over",
      attributionLabels: { cost_center: "eng" },
    });
  }
}

async function insertReceipt(params: {
  interactionId: string;
  organizationId: string;
  components: ReceiptComponent[];
}) {
  await db.insert(schema.interactionBillingTable).values({
    interactionId: params.interactionId,
    organizationId: params.organizationId,
    billingMode: "metered",
    fingerprint: `rollup-${params.interactionId}`,
    usage: receiptUsage(params.components),
  });
}

type ReceiptComponent = {
  model: string;
  kind: "message" | "advisor_message";
  cost: string;
};

function receiptUsage(components: ReceiptComponent[]) {
  return {
    version: 1 as const,
    mode: "enforce" as const,
    status: "complete" as const,
    issues: [],
    cost: String(components.reduce((sum, c) => sum + Number(c.cost), 0)),
    components: components.map((component, index) => ({
      id: `component-${index}`,
      model: component.model,
      kind: component.kind,
      provider: "openai" as const,
      inputTokens: 100 * (index + 1),
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      prices: {
        input: "2",
        output: "4",
        cacheRead: "0.5",
        cacheWrite: null,
        cacheWrite1h: null,
        source: "test",
      },
      cost: component.cost,
    })),
  };
}

/** Run the rollup until nothing is left to roll, recompute or settle. */
async function drain() {
  for (let run = 0; run < 20; run++) {
    const result = await llmUsageRollup.run({
      timeBudgetMs: 30_000,
      throttleRatio: 0,
    });
    if (result.recomputed === 0 && result.rolled === 0) return;
  }
  throw new Error("rollup did not drain");
}

function rawOnly(window: UsageWindow): UsageWindow {
  return { ...window, served: null };
}

async function factRows(window: UsageWindow) {
  const rows = await db.select().from(LlmUsageRollupModel.facts(window));
  return rows
    .map((row) => JSON.stringify(row))
    .sort((a, b) => a.localeCompare(b));
}

async function totalCost(window: UsageWindow) {
  const facts = LlmUsageRollupModel.facts(window);
  const [row] = await db
    .select({ cost: sql<string>`SUM(${facts.cost})` })
    .from(facts);
  return Number(row.cost);
}

async function dailyCost(day: Date) {
  const daily = schema.llmUsageDailyTable;
  const [row] = await db
    .select({ cost: sql<string>`SUM(${daily.cost})` })
    .from(daily)
    .where(eq(daily.hour, day));
  return Number(row.cost);
}

async function requestCount(window: UsageWindow) {
  const facts = LlmUsageRollupModel.facts(window);
  const [row] = await db
    .select({ requests: sql<string>`SUM(${facts.requests})` })
    .from(facts);
  return Number(row.requests);
}

async function rolledHourCount() {
  const [row] = await db
    .select({
      hours: sql<number>`COUNT(DISTINCT ${schema.llmUsageHourlyTable.hour})::int`,
    })
    .from(schema.llmUsageHourlyTable);
  return row.hours;
}

async function markedHours() {
  const rows = await db
    .select({
      hour: sql<string>`${schema.llmUsageRollupDirtyTable.hour}::text`,
    })
    .from(schema.llmUsageRollupDirtyTable)
    .orderBy(schema.llmUsageRollupDirtyTable.hour);
  return rows.map((row) => row.hour);
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3600_000);
}

/** The hour containing `date`, as the database prints a timestamp. */
function hourOf(date: Date) {
  const hour = new Date(date);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString().replace("T", " ").replace(".000Z", "");
}
