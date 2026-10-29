import { randomBytes, randomUUID } from "node:crypto";
import { eq, getTableColumns, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import InteractionModel from "./interaction";
import InteractionUserActivityModel from "./interaction-user-activity";

test("proxy-shaped appends preserve defaults, all credential combinations and exact activity on replay", async ({
  makeOrganization,
  makeAgent,
  makeUser,
  makeVirtualApiKey,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const user = await makeUser();
  const otherUser = await makeUser();
  const key = await makeVirtualApiKey(organization.id);
  let counted = 0;
  for (const enabled of [false, true]) {
    await InteractionUserActivityModel.setEnabled(enabled);
    if (enabled) {
      while (!(await InteractionUserActivityModel.rebuildBatch()).ready) {}
      counted = 4;
    }
    for (const credentials of [
      {},
      { virtualKeyId: key.id },
      { passthroughVirtualKeyId: key.id },
      { virtualKeyId: key.id, passthroughVirtualKeyId: key.id },
    ]) {
      const values: typeof schema.interactionsTable.$inferInsert = {
        id: randomUUID(),
        profileId: agent.id,
        request: {
          model: "synthetic",
          messages: [{ role: "user", content: "quotes ' and unicode λ" }],
        },
        response: {
          id: "synthetic",
          object: "chat.completion",
          created: 0,
          model: "synthetic",
          choices: [],
        },
        type: "openai:chatCompletions",
        inputTokens: 7,
        outputTokens: 3,
        model: "synthetic",
        baselineCost: "999.9999999999",
        cost: "0.1000000000",
        processedRequest: null,
        userId: user.id,
        sessionId: null,
        sessionSource: null,
        baselineModel: "synthetic",
        source: "api",
        authMethod: "passthrough_virtual_key",
        cacheReadTokens: null,
        cacheWriteTokens: null,
        cacheCost: "1.2300000000",
        cacheSavings: null,
        cacheWrite1hTokens: null,
        environmentId: null,
        inputTokensEstimated: false,
        billingMode: "metered",
        durationMs: 12,
        sessionPreview: null,
        attributionLabels: { team: "quoted ' λ" },
        ...credentials,
      };
      const created = await InteractionUserActivityModel.append(values);
      expect(created).toMatchObject(values);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.createdAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
      const [native] = await db
        .insert(schema.interactionsTable)
        .values({
          ...values,
          id: randomUUID(),
          createdAt: created.createdAt,
        })
        .returning();
      expect(created).toEqual({ ...native, id: created.id });
      // Remove the direct-insert control: it deliberately bypasses accounting.
      await db
        .delete(schema.interactionsTable)
        .where(eq(schema.interactionsTable.id, native.id));
      expect(await InteractionUserActivityModel.append(values)).toEqual(
        created,
      );
      await expect(
        InteractionUserActivityModel.append({
          ...values,
          userId: otherUser.id,
        }),
      ).rejects.toThrow();
      if (enabled) {
        counted++;
        expect(
          await db.select().from(schema.interactionUserActivityTable),
        ).toMatchObject([
          {
            organizationId: organization.id,
            userId: user.id,
            activityCount: counted,
          },
        ]);
      }
    }
  }
  expect(await db.select().from(schema.interactionsTable)).toHaveLength(8);
});

test("proxy-shaped append keeps JSON null distinct from SQL null and falls back for extra columns", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const user = await makeUser();
  // The payload is the public function's driver-encoded contract: JSON values
  // are strings containing JSON, while an outer null means SQL NULL.
  const values: typeof schema.interactionsTable.$inferInsert = {
    id: randomUUID(),
    profileId: agent.id,
    userId: user.id,
    request: { model: "synthetic", messages: [] },
    response: {
      id: "synthetic",
      object: "chat.completion",
      created: 0,
      model: "synthetic",
      choices: [],
    },
    type: "openai:chatCompletions",
    inputTokens: 1,
    outputTokens: 1,
    model: "synthetic",
    baselineCost: null,
    cost: null,
    processedRequest: null,
    sessionId: null,
    sessionSource: null,
    baselineModel: "synthetic",
    source: "api",
    authMethod: "provider_key",
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheCost: null,
    cacheSavings: null,
    cacheWrite1hTokens: null,
    environmentId: null,
    inputTokensEstimated: false,
    billingMode: "metered",
    durationMs: 1,
    sessionPreview: null,
    attributionLabels: null,
  };
  const columns = getTableColumns(schema.interactionsTable);
  const encoded: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(values)) {
    const column = columns[key as keyof typeof columns];
    encoded[column.name] =
      value === null ? null : String(column.mapToDriverValue(value));
  }
  for (const extra of [false, true]) {
    const payload = {
      ...encoded,
      id: randomUUID(),
      processed_request: "null",
      ...(extra ? { created_at: "2026-01-02 03:04:05.678" } : {}),
    };
    await db.execute(
      sql`SELECT * FROM interaction_user_activity_append(${JSON.stringify(payload)}::jsonb)`,
    );
    const [row] = await db
      .select({
        processedIsSqlNull: sql<boolean>`processed_request IS NULL`,
        processedType: sql<string>`jsonb_typeof(processed_request)`,
        previewIsSqlNull: sql<boolean>`session_preview IS NULL`,
        createdAt: schema.interactionsTable.createdAt,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, payload.id));
    expect(row).toMatchObject({
      processedIsSqlNull: false,
      processedType: "null",
      previewIsSqlNull: true,
    });
    if (extra)
      expect(row.createdAt).toEqual(new Date("2026-01-02T03:04:05.678Z"));
  }
});

test("concurrent same-user appends persist and count both interactions", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  await InteractionUserActivityModel.setEnabled(true);
  while (!(await InteractionUserActivityModel.rebuildBatch()).ready) {}
  const values = {
    userId: user.id,
    profileId: agent.id,
    type: "openai:chatCompletions" as const,
    request: { model: "synthetic", messages: [] },
    response: {
      id: "synthetic",
      object: "chat.completion" as const,
      created: 0,
      model: "synthetic",
      choices: [],
    },
  };
  const rows = await Promise.all([
    InteractionModel.create({ ...values, model: "concurrent-first" }),
    InteractionModel.create({ ...values, model: "concurrent-second" }),
  ]);
  expect(rows.map((row) => row.model)).toEqual([
    "concurrent-first",
    "concurrent-second",
  ]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  expect(await db.select().from(schema.interactionsTable)).toHaveLength(2);
  expect(
    await db.select().from(schema.interactionUserActivityTable),
  ).toMatchObject([
    { organizationId: org.id, userId: user.id, activityCount: 2 },
  ]);
  expect(
    await InteractionModel.getUniqueUserIds({
      organizationId: org.id,
      limit: 100,
    }),
  ).toEqual(
    await InteractionUserActivityModel.mostActive({
      organizationId: org.id,
      limit: 100,
      generation: (await InteractionUserActivityModel.state()).generation,
    }),
  );
});

test("attributed append preserves native decimals, dates, nested JSON, defaults and encrypted content", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({ organizationId: organization.id });
  const user = await makeUser();
  const createdAt = new Date("2026-01-02T03:04:05.678Z");
  const request = {
    model: "synthetic",
    messages: [
      { role: "user" as const, content: "quoted ' JSON and unicode λ" },
    ],
  };
  const response = {
    id: "synthetic",
    object: "chat.completion" as const,
    created: 0,
    model: "synthetic",
    choices: [],
  };
  const audit = { dek: randomBytes(32), conversationId: randomUUID() };
  const created = await InteractionModel.create(
    {
      profileId: agent.id,
      userId: user.id,
      type: "openai:chatCompletions",
      request,
      processedRequest: request,
      response,
      createdAt,
      cost: "999.9999999999",
      baselineCost: "0.1000000000",
      cacheCost: "1.2300000000",
      inputTokensEstimated: true,
      billingMode: "subscription",
    },
    audit,
  );
  expect(created).toMatchObject({
    request,
    processedRequest: request,
    response,
    createdAt,
    cost: "999.9999999999",
    baselineCost: "0.1000000000",
    cacheCost: "1.2300000000",
    inputTokensEstimated: true,
    billingMode: "subscription",
    encryptedChatConversationId: audit.conversationId,
  });
  expect(created.createdAt).toBeInstanceOf(Date);
  const [stored] = await db
    .select()
    .from(schema.interactionsTable)
    .where(eq(schema.interactionsTable.id, created.id));
  expect(stored.request).not.toEqual(request);
  expect(stored.response).not.toEqual(response);
  expect(stored.processedRequest).not.toEqual(request);
  const plain = await InteractionModel.create({
    profileId: agent.id,
    userId: user.id,
    type: "openai:chatCompletions",
    request,
    response,
  });
  expect(plain.request).toEqual(request);
  expect(plain.response).toEqual(response);
  expect(plain.billingMode).toBe("metered");
  expect(plain.inputTokensEstimated).toBe(false);
  expect(plain.createdAt).toBeInstanceOf(Date);
  expect(plain.createdAt.getTime()).toBeGreaterThan(Date.now() - 30_000);
});

test("attributed appends use one atomic statement after environment lookup whether enabled or disabled", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  for (const enabled of [false, true]) {
    await InteractionUserActivityModel.setEnabled(enabled);
    const measured = await recordQueries(() =>
      InteractionModel.create({
        profileId: agent.id,
        userId: user.id,
        type: "openai:chatCompletions",
        request: { model: "synthetic", messages: [] },
        response: {
          id: "synthetic",
          object: "chat.completion",
          created: 0,
          model: "synthetic",
          choices: [],
        },
      }),
    );
    expect(measured.result.userId).toBe(user.id);
    expect(
      measured.statements.filter(
        (statement) =>
          !(
            /^update "agents" set /i.test(statement) &&
            statement.includes('"last_used_at"')
          ),
      ),
    ).toHaveLength(2);
    expect(measured.statements[1]).toContain(
      "interaction_user_activity_append",
    );
  }
});

test("append rejects unsupported columns and encodings instead of silently discarding fields", async () => {
  await expect(
    db.execute(
      sql`SELECT * FROM interaction_user_activity_append(${JSON.stringify({ id: randomUUID(), unsupported: "value" })}::jsonb)`,
    ),
  ).rejects.toThrow();
  await expect(
    db.execute(
      sql`SELECT * FROM interaction_user_activity_append(${JSON.stringify({ id: randomUUID(), request: { messages: [] } })}::jsonb)`,
    ),
  ).rejects.toThrow();
});

test("a missing append migration fails without writing an uncounted interaction", async ({
  makeOrganization,
  makeAgent,
  makeUser,
}) => {
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id });
  const user = await makeUser();
  await db.execute(
    sql`ALTER FUNCTION interaction_user_activity_append(jsonb) RENAME TO interaction_user_activity_append_unavailable`,
  );
  try {
    await expect(
      InteractionModel.create({
        profileId: agent.id,
        userId: user.id,
        type: "openai:chatCompletions",
        request: { model: "synthetic", messages: [] },
        response: {
          id: "synthetic",
          object: "chat.completion",
          created: 0,
          model: "synthetic",
          choices: [],
        },
      }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.interactionsTable)).toHaveLength(0);
  } finally {
    await db.execute(
      sql`ALTER FUNCTION interaction_user_activity_append_unavailable(jsonb) RENAME TO interaction_user_activity_append`,
    );
  }
});
